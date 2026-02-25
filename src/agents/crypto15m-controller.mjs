// crypto15m-controller.mjs — Fee-curve-aware controller for 15m Up/Down markets
// Usage: node src/agents/crypto15m-controller.mjs [--interval 15000] [--duration 3600000] [--once] [--vol-floor 0.00008] [--vol-mult 2.0] [--vol-window 180] [--z-clamp 3]
//
// Connects Binance spot WebSocket, reads CLOB books via crypto15m-adapter,
// computes p_hat from CEX features with vol-floor/z-clamp/p_hat-clamp,
// applies persistence gate (N consecutive same-side ticks), and produces
// DO_NOTHING / CANDIDATE_UP/DN / PROPOSE_UP/DN / EXIT decisions.
//
// Shadow mode (default ON): tracks proposals against market outcomes.
// Writes: zvi_controller.json, crypto15m_decisions.jsonl, crypto15m_shadow.jsonl

import { resolve } from '../adapters/polymarket/crypto15m-adapter.mjs';
import { start as startFeed, stop as stopFeed, getFeatures, isConnected as feedConnected } from '../adapters/binance/spot-feed.mjs';
import { writeFileSync, readFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════════
// PATHS
// ═══════════════════════════════════════════════════════════════
const CONTROLLER_STATE_PATH = join(process.cwd(), 'zvi_controller.json');
const DECISIONS_LOG_PATH = join(process.cwd(), 'crypto15m_decisions.jsonl');
const SHADOW_LOG_PATH = join(process.cwd(), 'crypto15m_shadow.jsonl');
const RING_BUFFER_MAX = 500;

// ═══════════════════════════════════════════════════════════════
// FEE CURVE
// ═══════════════════════════════════════════════════════════════
const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;

function takerFee(p) {
  if (p <= 0 || p >= 1) return 0;
  return FEE_RATE * Math.pow(p * (1 - p), FEE_EXPONENT);
}

function assertFeeCurve() {
  const f05 = takerFee(0.5);
  const f01 = takerFee(0.1);
  const ok05 = Math.abs(f05 - 0.015625) < 1e-10;
  const ok01 = Math.abs(f01 - 0.002025) < 1e-10;
  console.log(`[controller] fee self-check: fee(0.5)=${f05} (${(f05 * 100).toFixed(4)}%) ${ok05 ? 'OK' : 'FAIL'}`);
  console.log(`[controller] fee self-check: fee(0.1)=${f01} (${(f01 * 100).toFixed(4)}%) ${ok01 ? 'OK' : 'FAIL'}`);
  if (!ok05 || !ok01) { console.error('[controller] FATAL: fee curve failed.'); process.exit(1); }
}
assertFeeCurve();

// ═══════════════════════════════════════════════════════════════
// SLIPPAGE
// ═══════════════════════════════════════════════════════════════
const NOTIONAL_USDC = 100;
const SLIPPAGE_COEFF = 2.0;
const MAX_SLIPPAGE = 0.05;

function estimateSlippage(askSize) {
  if (!askSize || askSize <= 0) return MAX_SLIPPAGE;
  return Math.min(NOTIONAL_USDC / (askSize * SLIPPAGE_COEFF), MAX_SLIPPAGE);
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL: sigmoid p_hat with vol-floor, z-clamp, p_hat-clamp
// ═══════════════════════════════════════════════════════════════
const SIGMOID_K = 1.0;
const SIGMOID_EPS = 1e-6;
let VOL_FLOOR = 0.00008;          // below this → NO_SIGNAL (tunable via --vol-floor)
let VOL_MULT = 2.0;              // effectiveVol = max(vol, volFloor * VOL_MULT) — tunable via --vol-mult
let Z_CLAMP = 3;                 // clamp z to [-3, +3] (tunable via --z-clamp)
const P_HAT_MIN = 0.01;          // clamp p_hat to [0.01, 0.99]
const P_HAT_MAX = 0.99;
const PROPOSAL_THRESHOLD = 0.02; // |p_hat - upMid| must exceed this
const EDGE_BUFFER = 0.005;       // 0.5% safety
let VOL_WINDOW_SEC = 180;        // vol estimation window (tunable via --vol-window)

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function computePHat(return_60s, vol_60s) {
  const volFloorHit = vol_60s < VOL_FLOOR;
  const effectiveVol = Math.max(vol_60s, VOL_FLOOR * VOL_MULT);
  const volMultApplied = effectiveVol > vol_60s;
  const rawZ = SIGMOID_K * return_60s / (effectiveVol + SIGMOID_EPS);
  const zClamped = rawZ !== Math.max(-Z_CLAMP, Math.min(Z_CLAMP, rawZ));
  const z = Math.max(-Z_CLAMP, Math.min(Z_CLAMP, rawZ));
  const rawPHat = sigmoid(z);
  const p_hat = Math.max(P_HAT_MIN, Math.min(P_HAT_MAX, rawPHat));
  const pHatClamped = rawPHat !== p_hat;
  return { p_hat, z, rawZ, volFloorHit, zClamped, pHatClamped, effectiveVol, volMultApplied };
}

// ═══════════════════════════════════════════════════════════════
// HARD GATES
// ═══════════════════════════════════════════════════════════════
const GATE_SANITY_TOL = 0.05;
const GATE_MAX_SPREAD = 0.03;
const GATE_MIN_DEPTH = 50;
const GATE_MIN_TIME_REMAINING = 240;
const GATE_MIN_NET_EDGE = 0.03;

function checkGates(market, hasCexFeed) {
  const gates = [];
  const up = market.up;
  const down = market.down;

  const sanityOk = market.sanitySum != null && Math.abs(market.sanitySum - 1.0) <= GATE_SANITY_TOL;
  gates.push({ name: 'sanitySum', pass: sanityOk, value: market.sanitySum, threshold: `1.0 ± ${GATE_SANITY_TOL}` });

  const upSpread = (up?.ask != null && up?.bid != null) ? up.ask - up.bid : 1;
  const dnSpread = (down?.ask != null && down?.bid != null) ? down.ask - down.bid : 1;
  const spreadOk = Math.min(upSpread, dnSpread) <= GATE_MAX_SPREAD;
  gates.push({ name: 'spread', pass: spreadOk, value: Math.min(upSpread, dnSpread).toFixed(4), threshold: `≤ ${GATE_MAX_SPREAD}` });

  const upDepth = up?.askSize ?? 0;
  const dnDepth = down?.askSize ?? 0;
  const depthOk = Math.max(upDepth, dnDepth) >= GATE_MIN_DEPTH;
  gates.push({ name: 'depth', pass: depthOk, value: Math.max(upDepth, dnDepth).toFixed(1), threshold: `≥ ${GATE_MIN_DEPTH}` });

  const now = Date.now();
  const windowEnd = market.tradingWindowEnd ? new Date(market.tradingWindowEnd).getTime() : 0;
  const timeRemaining = Math.max(0, (windowEnd - now) / 1000);
  const timeOk = timeRemaining >= GATE_MIN_TIME_REMAINING;
  gates.push({ name: 'timeRemaining', pass: timeOk, value: `${timeRemaining.toFixed(0)}s`, threshold: `≥ ${GATE_MIN_TIME_REMAINING}s` });

  gates.push({ name: 'cexFeed', pass: hasCexFeed, value: hasCexFeed ? 'OK' : 'NO_CEX_FEED', threshold: 'connected + data' });

  return { gates, allPass: gates.every(g => g.pass), timeRemaining };
}

// ═══════════════════════════════════════════════════════════════
// PERSISTENCE GATE — require N consecutive same-side signals
// ═══════════════════════════════════════════════════════════════
const PERSISTENCE_N = 2;
const persistenceTracker = {}; // { BTC: { side: 'UP'|'DN', count: 2 }, ... }

function updatePersistence(symbol, signalSide) {
  // signalSide is 'UP', 'DN', or null (DO_NOTHING)
  if (!signalSide) {
    persistenceTracker[symbol] = { side: null, count: 0 };
    return { persisted: false, count: 0, needed: PERSISTENCE_N };
  }
  const prev = persistenceTracker[symbol];
  if (prev && prev.side === signalSide) {
    prev.count++;
  } else {
    persistenceTracker[symbol] = { side: signalSide, count: 1 };
  }
  const current = persistenceTracker[symbol];
  return { persisted: current.count >= PERSISTENCE_N, count: current.count, needed: PERSISTENCE_N };
}

// ═══════════════════════════════════════════════════════════════
// COUNTERFACTUALS — "what would happen if we relaxed ONE gate?"
// ═══════════════════════════════════════════════════════════════

/**
 * Simulate the full decision pipeline with ONE gate parameter changed.
 * Returns { CF1..CF4 booleans, CF3_netEdge, cfCount }.
 */
function computeCounterfactuals(record, market, signal, gatesResult, persistence) {
  const cf = { CF1: false, CF2: false, CF3: false, CF3_netEdge: null, CF4: false, cfCount: 0 };

  // Helper: would this combination produce a PROPOSE?
  // Needs: signal fires (edge >= threshold && netEdge >= minNetEdge), gates pass, persistence met
  function wouldPropose({ netEdgeThreshold = GATE_MIN_NET_EDGE, persistenceThreshold = PERSISTENCE_N,
                          volFloorOverride = null, maxSpreadOverride = null } = {}) {
    // Re-derive signal values if volFloor is overridden
    let edge = signal.edge;
    let netEdge = signal.netEdge;
    let volFloorHit = signal.volFloorHit;

    if (volFloorOverride !== null) {
      // Recompute p_hat with volFloor=0 (use actual vol, no floor)
      const cexReturn = record.return_60s;
      const cexVol = record.vol_60s;
      if (cexReturn == null || cexVol == null) return false;

      const effectiveVol = Math.max(cexVol, volFloorOverride);
      const rawZ = SIGMOID_K * cexReturn / (effectiveVol + SIGMOID_EPS);
      const z = Math.max(-Z_CLAMP, Math.min(Z_CLAMP, rawZ));
      const p_hat = Math.max(P_HAT_MIN, Math.min(P_HAT_MAX, sigmoid(z)));
      volFloorHit = cexVol < volFloorOverride;

      const upMid = signal.upMid;
      if (upMid == null) return false;

      const buyUp = p_hat > upMid;
      const buyPrice = buyUp ? market.up?.ask : market.down?.ask;
      const buyAskSize = buyUp ? (market.up?.askSize ?? 0) : (market.down?.askSize ?? 0);
      if (buyPrice == null) return false;

      edge = Math.abs(p_hat - upMid);
      const fees = takerFee(buyPrice);
      const slippage = estimateSlippage(buyAskSize);
      netEdge = edge - fees - slippage - EDGE_BUFFER;

      // Store CF3 netEdge for reporting
      if (volFloorOverride === 0) {
        cf.CF3_netEdge = parseFloat(netEdge.toFixed(6));
      }
    }

    // If volFloor still hit (only possible if volFloorOverride > 0), signal is unreliable
    if (volFloorHit) return false;

    // Signal must fire
    if (edge == null || netEdge == null) return false;
    if (edge < PROPOSAL_THRESHOLD) return false;
    if (netEdge < netEdgeThreshold) return false;

    // Gates must pass (with potential spread override)
    const effectiveMaxSpread = maxSpreadOverride !== null ? maxSpreadOverride : GATE_MAX_SPREAD;
    for (const g of gatesResult.gates) {
      if (g.name === 'spread' && maxSpreadOverride !== null) {
        // Re-evaluate spread gate with relaxed threshold
        const upSpread = (market.up?.ask != null && market.up?.bid != null) ? market.up.ask - market.up.bid : 1;
        const dnSpread = (market.down?.ask != null && market.down?.bid != null) ? market.down.ask - market.down.bid : 1;
        if (Math.min(upSpread, dnSpread) > effectiveMaxSpread) return false;
      } else if (!g.pass) {
        return false;
      }
    }

    // Persistence must be met
    if (persistence.count < persistenceThreshold) return false;

    return true;
  }

  // CF1: relaxed netEdge (0.01 instead of 0.03)
  cf.CF1 = wouldPropose({ netEdgeThreshold: 0.01 });

  // CF2: no persistence (threshold=1 instead of N)
  cf.CF2 = wouldPropose({ persistenceThreshold: 1 });

  // CF3: no vol floor (volFloor=0 instead of 0.0002)
  cf.CF3 = wouldPropose({ volFloorOverride: 0 });

  // CF4: relaxed spread (0.05 instead of 0.03)
  cf.CF4 = wouldPropose({ maxSpreadOverride: 0.05 });

  cf.cfCount = [cf.CF1, cf.CF2, cf.CF3, cf.CF4].filter(Boolean).length;
  return cf;
}

/**
 * Return the single label for the FIRST gate that blocks, following evaluation order.
 */
function computeDominantBlocker(record, gatesResult) {
  // 1. No CEX feed
  if (record.binancePrice == null || !gatesResult.gates.find(g => g.name === 'cexFeed')?.pass) {
    return 'NO_CEX_FEED';
  }
  // 2. Vol floor
  if (record.volFloorHit) return 'VOL_FLOOR';
  // 3. Sanity
  if (!gatesResult.gates.find(g => g.name === 'sanitySum')?.pass) return 'SANITY';
  // 4. Spread
  if (!gatesResult.gates.find(g => g.name === 'spread')?.pass) return 'SPREAD';
  // 5. Depth
  if (!gatesResult.gates.find(g => g.name === 'depth')?.pass) return 'DEPTH';
  // 6. Time remaining
  if (!gatesResult.gates.find(g => g.name === 'timeRemaining')?.pass) return 'TIME_REMAINING';
  // 7. Net edge too low
  if (record.netEdge != null && record.netEdge < GATE_MIN_NET_EDGE) return 'NET_EDGE';
  // 8. Edge below proposal threshold (signal doesn't fire)
  if (record.edge != null && record.edge < PROPOSAL_THRESHOLD) return 'NET_EDGE';
  // 9. Persistence not met
  if (record.decision && record.decision.includes('CANDIDATE')) return 'PERSISTENCE';
  // 10. Nothing blocked — it's a PROPOSE
  return null;
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL COMPUTATION
// ═══════════════════════════════════════════════════════════════
const NULL_SIGNAL = {
  decision: 'DO_NOTHING', reason: '', p_hat: null, z: null, rawZ: null,
  volFloorHit: false, zClamped: false, pHatClamped: false,
  effectiveVol: null, volMultApplied: false,
  edge: null, fees: null, slippage: null, buffer: EDGE_BUFFER, netEdge: null,
  buySide: null, buyPrice: null,
  binancePrice: null, return_60s: null, vol_60s: null, upMid: null, dnMid: null,
};

function computeSignal(market, cexFeatures) {
  const up = market.up;
  const down = market.down;

  if (!up || !down || up.mid == null || down.mid == null) {
    return { ...NULL_SIGNAL, reason: 'no book data' };
  }

  const upMid = up.mid;
  const dnMid = down.mid;

  if (!cexFeatures || !cexFeatures.ok) {
    return { ...NULL_SIGNAL, reason: 'NO_CEX_FEED', binancePrice: cexFeatures?.price ?? null, upMid, dnMid };
  }

  // Compute p_hat with clamps
  const pResult = computePHat(cexFeatures.return_60s, cexFeatures.vol_60s);

  // Vol floor gate: if vol too low, signal is unreliable
  if (pResult.volFloorHit) {
    return {
      ...NULL_SIGNAL,
      reason: `NO_SIGNAL: vol_60s=${cexFeatures.vol_60s} < floor=${VOL_FLOOR}`,
      p_hat: pResult.p_hat, z: parseFloat(pResult.z.toFixed(4)), rawZ: parseFloat(pResult.rawZ.toFixed(4)),
      volFloorHit: true, zClamped: pResult.zClamped, pHatClamped: pResult.pHatClamped,
      effectiveVol: pResult.effectiveVol, volMultApplied: pResult.volMultApplied,
      binancePrice: cexFeatures.price, return_60s: cexFeatures.return_60s, vol_60s: cexFeatures.vol_60s,
      upMid, dnMid,
    };
  }

  const { p_hat, z, rawZ, volFloorHit, zClamped, pHatClamped, effectiveVol, volMultApplied } = pResult;

  // Direction
  const buyUp = p_hat > upMid;
  const buySide = buyUp ? 'UP' : 'DN';
  const buyPrice = buyUp ? up.ask : down.ask;
  const buyAskSize = buyUp ? (up.askSize ?? 0) : (down.askSize ?? 0);

  if (buyPrice == null) {
    return {
      ...NULL_SIGNAL, reason: 'no ask price',
      p_hat, z: parseFloat(z.toFixed(4)), rawZ: parseFloat(rawZ.toFixed(4)),
      volFloorHit, zClamped, pHatClamped, effectiveVol, volMultApplied,
      buySide, binancePrice: cexFeatures.price, return_60s: cexFeatures.return_60s, vol_60s: cexFeatures.vol_60s,
      upMid, dnMid,
    };
  }

  const edge = Math.abs(p_hat - upMid);
  const fees = takerFee(buyPrice);
  const slippage = estimateSlippage(buyAskSize);
  const netEdge = edge - fees - slippage - EDGE_BUFFER;

  let decision = 'DO_NOTHING';
  let reason = '';
  const aboveThreshold = edge >= PROPOSAL_THRESHOLD;
  const netEdgeOk = netEdge >= GATE_MIN_NET_EDGE;

  if (aboveThreshold && netEdgeOk) {
    decision = buyUp ? 'PROPOSE_UP' : 'PROPOSE_DN';
    reason = `p_hat=${p_hat.toFixed(4)} vs upMid=${upMid.toFixed(4)}, edge=${(edge * 100).toFixed(2)}%, netEdge=${(netEdge * 100).toFixed(2)}%`;
  } else if (edge < 0.005) {
    reason = `flat: p_hat=${p_hat.toFixed(4)} ≈ upMid=${upMid.toFixed(4)}`;
  } else if (!aboveThreshold) {
    reason = `below threshold: edge=${(edge * 100).toFixed(3)}% < ${(PROPOSAL_THRESHOLD * 100).toFixed(1)}%`;
  } else {
    reason = `costs too high: netEdge=${(netEdge * 100).toFixed(2)}% < ${(GATE_MIN_NET_EDGE * 100).toFixed(1)}%`;
  }

  // Annotate clamps in reason
  const flags = [];
  if (zClamped) flags.push(`z-clamped(${rawZ.toFixed(2)}→${z.toFixed(2)})`);
  if (pHatClamped) flags.push('p_hat-clamped');
  if (flags.length > 0) reason += ` [${flags.join(', ')}]`;

  return {
    decision, reason,
    p_hat: parseFloat(p_hat.toFixed(6)),
    z: parseFloat(z.toFixed(4)),
    rawZ: parseFloat(rawZ.toFixed(4)),
    volFloorHit, zClamped, pHatClamped,
    effectiveVol, volMultApplied,
    edge: parseFloat(edge.toFixed(6)),
    fees: parseFloat(fees.toFixed(6)),
    slippage: parseFloat(slippage.toFixed(6)),
    buffer: EDGE_BUFFER,
    netEdge: parseFloat(netEdge.toFixed(6)),
    buySide, buyPrice,
    binancePrice: cexFeatures.price,
    return_60s: cexFeatures.return_60s,
    vol_60s: cexFeatures.vol_60s,
    upMid, dnMid,
  };
}

// ═══════════════════════════════════════════════════════════════
// SHADOW MODE — track proposals against outcomes
// ═══════════════════════════════════════════════════════════════
const SHADOW_MODE = true;
const shadowProposals = []; // in-memory list of pending proposals
let shadowIdCounter = 0;

function loadShadowLog() {
  // Load existing shadow proposals to resolve on restart
  if (!existsSync(SHADOW_LOG_PATH)) return [];
  try {
    const lines = readFileSync(SHADOW_LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l)).filter(p => p.status === 'pending');
  } catch (_) { return []; }
}

function logShadowProposal(proposal) {
  appendFileSync(SHADOW_LOG_PATH, JSON.stringify(proposal) + '\n');
}

function logShadowOutcome(resolved) {
  appendFileSync(SHADOW_LOG_PATH, JSON.stringify(resolved) + '\n');
}

function createShadowProposal(d, cycle) {
  shadowIdCounter++;
  const proposal = {
    id: `shadow-${Date.now()}-${shadowIdCounter}`,
    status: 'pending',
    cycle,
    ts: new Date().toISOString(),
    symbol: d.symbol,
    slug: d.slug,
    side: d.buySide,
    decision: d.decision,
    p_hat: d.p_hat,
    z: d.z,
    upMid: d.upMid,
    dnMid: d.dnMid,
    edge: d.edge,
    netEdge: d.netEdge,
    fees: d.fees,
    slippage: d.slippage,
    buffer: d.buffer,
    buyPrice: d.buyPrice,
    effectiveVol: d.effectiveVol,
    volMultApplied: d.volMultApplied,
    binancePrice: d.binancePrice,
    return_60s: d.return_60s,
    vol_60s: d.vol_60s,
    windowEnd: d.window?.end,
    volFloorHit: d.volFloorHit,
    zClamped: d.zClamped,
    pHatClamped: d.pHatClamped,
  };
  shadowProposals.push(proposal);
  logShadowProposal(proposal);
  return proposal.id;
}

async function resolveShadowProposals() {
  const now = Date.now();
  const toResolve = shadowProposals.filter(p =>
    p.status === 'pending' && p.windowEnd && new Date(p.windowEnd).getTime() < now
  );

  for (const proposal of toResolve) {
    // Query Gamma for this market's outcome
    let outcome = null;
    try {
      const GAMMA = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
      const r = await fetch(`${GAMMA}/markets?slug=${proposal.slug}`, { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const markets = await r.json();
        const market = markets[0];
        if (market) {
          const prices = JSON.parse(market.outcomePrices || '[]');
          const upPrice = parseFloat(prices[0] || '0');
          // If market resolved: upPrice will be 1 (Up won) or 0 (Down won)
          // If not fully resolved, prices may be near 0 or 1
          if (upPrice > 0.9) outcome = 'UP';
          else if (upPrice < 0.1) outcome = 'DOWN';
          else outcome = 'UNRESOLVED';
        }
      }
    } catch (_) {
      outcome = 'FETCH_ERROR';
    }

    const won = outcome && (
      (proposal.side === 'UP' && outcome === 'UP') ||
      (proposal.side === 'DN' && outcome === 'DOWN')
    );

    // Compute realized PnL
    const entryCost = proposal.buyPrice ?? 0;
    const entryFees = proposal.fees ?? 0;
    const entrySlippage = proposal.slippage ?? 0;
    const entryBuffer = proposal.buffer ?? 0;
    const costs = entryFees + entrySlippage + entryBuffer;
    const realizedPnl = proposal.buyPrice != null
      ? (won ? 1 - entryCost : -entryCost) - costs
      : null;

    proposal.status = 'resolved';
    proposal.resolvedAt = new Date().toISOString();
    proposal.outcome = outcome;
    proposal.won = won ?? null;
    proposal.costs = costs > 0 ? parseFloat(costs.toFixed(6)) : null;
    proposal.realizedPnl = realizedPnl != null ? parseFloat(realizedPnl.toFixed(6)) : null;

    logShadowOutcome(proposal);
    const pnlStr = realizedPnl != null ? ` pnl=${realizedPnl.toFixed(4)}` : '';
    console.log(`[shadow] resolved ${proposal.id}: ${proposal.symbol} ${proposal.side} → outcome=${outcome} won=${won} (p_hat=${proposal.p_hat} edge=${proposal.edge}${pnlStr})`);
  }

  // Remove resolved from in-memory list
  for (let i = shadowProposals.length - 1; i >= 0; i--) {
    if (shadowProposals[i].status === 'resolved') shadowProposals.splice(i, 1);
  }
}

function computeShadowStats() {
  if (!existsSync(SHADOW_LOG_PATH)) return null;
  try {
    const lines = readFileSync(SHADOW_LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => JSON.parse(l));
    const resolved = entries.filter(e => e.status === 'resolved' && e.outcome !== 'UNRESOLVED' && e.outcome !== 'FETCH_ERROR');
    const pending = entries.filter(e => e.status === 'pending');
    const wins = resolved.filter(e => e.won);
    const losses = resolved.filter(e => e.won === false);

    const volFloorFiltered = entries.filter(e => e.volFloorHit).length;
    const zClampFiltered = entries.filter(e => e.zClamped).length;

    const avgEdge = resolved.length > 0 ? resolved.reduce((s, e) => s + (e.edge || 0), 0) / resolved.length : 0;
    const avgNetEdge = resolved.length > 0 ? resolved.reduce((s, e) => s + (e.netEdge || 0), 0) / resolved.length : 0;
    const avgPHat = resolved.length > 0 ? resolved.reduce((s, e) => s + (e.p_hat || 0), 0) / resolved.length : 0;
    const outcomeRate = resolved.length > 0 ? wins.length / resolved.length : 0;

    return {
      totalProposals: entries.filter(e => e.id).length / 2, // each proposal has pending+resolved entries
      pendingCount: pending.length,
      resolvedCount: resolved.length,
      wins: wins.length,
      losses: losses.length,
      winRate: parseFloat(outcomeRate.toFixed(4)),
      avgEdge: parseFloat(avgEdge.toFixed(6)),
      avgNetEdge: parseFloat(avgNetEdge.toFixed(6)),
      avgPHat: parseFloat(avgPHat.toFixed(4)),
      volFloorFiltered,
      zClampFiltered,
    };
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════
// CONTROLLER CYCLE
// ═══════════════════════════════════════════════════════════════
async function controllerCycle(cycle) {
  // Resolve any expired shadow proposals first
  if (SHADOW_MODE) await resolveShadowProposals();

  const state = await resolve();
  if (!state || !state.universeActive || state.universeActive.length === 0) {
    return { cycle, ts: new Date().toISOString(), decisions: [], error: 'no active markets' };
  }

  const decisions = [];

  for (const market of state.universeActive) {
    const cexFeatures = getFeatures(market.symbol, VOL_WINDOW_SEC);
    const hasCexFeed = cexFeatures.ok && feedConnected();

    const { gates, allPass, timeRemaining } = checkGates(market, hasCexFeed);
    const signal = computeSignal(market, cexFeatures);

    // Determine raw signal side for persistence tracking
    let rawSide = null;
    if (signal.decision === 'PROPOSE_UP') rawSide = 'UP';
    else if (signal.decision === 'PROPOSE_DN') rawSide = 'DN';

    // Persistence gate
    const persistence = updatePersistence(market.symbol, rawSide);

    // Build final decision
    let finalDecision = signal.decision;
    let gateBlock = null;

    // If signal proposes but persistence not met → downgrade to CANDIDATE
    if (rawSide && !persistence.persisted) {
      finalDecision = rawSide === 'UP' ? 'CANDIDATE_UP' : 'CANDIDATE_DN';
    }

    // Gate block: only applies to PROPOSE (persisted candidates)
    if ((finalDecision === 'PROPOSE_UP' || finalDecision === 'PROPOSE_DN') && !allPass) {
      gateBlock = gates.filter(g => !g.pass).map(g => g.name).join(', ');
      finalDecision = 'DO_NOTHING';
    }

    // EXIT logic
    if (timeRemaining < 120 && (finalDecision === 'PROPOSE_UP' || finalDecision === 'PROPOSE_DN')) {
      finalDecision = 'EXIT';
    }

    const record = {
      symbol: market.symbol,
      slug: market.slug,
      decision: finalDecision,
      signal: signal.decision,
      reason: signal.reason,
      gateBlock,
      gates,
      allGatesPass: allPass,
      timeRemaining: parseFloat(timeRemaining.toFixed(0)),
      // Persistence
      persistenceCount: persistence.count,
      persistenceNeeded: persistence.needed,
      persisted: persistence.persisted,
      // Binance + signal
      binancePrice: signal.binancePrice,
      return_60s: signal.return_60s,
      vol_60s: signal.vol_60s,
      p_hat: signal.p_hat,
      z: signal.z,
      rawZ: signal.rawZ,
      volFloorHit: signal.volFloorHit,
      zClamped: signal.zClamped,
      pHatClamped: signal.pHatClamped,
      effectiveVol: signal.effectiveVol,
      volMultApplied: signal.volMultApplied,
      // Edge
      edge: signal.edge,
      fees: signal.fees,
      slippage: signal.slippage,
      buffer: signal.buffer,
      netEdge: signal.netEdge,
      // Book
      upMid: signal.upMid,
      dnMid: signal.dnMid,
      buySide: signal.buySide,
      buyPrice: signal.buyPrice,
      window: { start: market.tradingWindowStart, end: market.tradingWindowEnd },
      bookSnapshot: { up: market.up, down: market.down, sanitySum: market.sanitySum },
    };

    // Counterfactuals + dominant blocker
    record.counterfactuals = computeCounterfactuals(record, market, signal, { gates, allPass }, persistence);
    record.dominantBlocker = computeDominantBlocker(record, { gates, allPass });

    // Shadow: log actionable proposals (PROPOSE_UP/DN only, not candidates)
    if (SHADOW_MODE && (finalDecision === 'PROPOSE_UP' || finalDecision === 'PROPOSE_DN')) {
      record.shadowId = createShadowProposal(record, cycle);
    }

    decisions.push(record);
  }

  return {
    cycle,
    ts: new Date().toISOString(),
    activeWindow: state.activeWindow,
    binanceFeed: feedConnected(),
    shadowMode: SHADOW_MODE,
    shadowStats: SHADOW_MODE ? computeShadowStats() : null,
    decisions,
  };
}

// ═══════════════════════════════════════════════════════════════
// RING BUFFER
// ═══════════════════════════════════════════════════════════════
function loadControllerState() {
  try {
    if (existsSync(CONTROLLER_STATE_PATH)) {
      return JSON.parse(readFileSync(CONTROLLER_STATE_PATH, 'utf-8'));
    }
  } catch (_) {}
  return { tickBuffer: {}, lastCycle: null, proposals: [] };
}

function updateRingBuffer(existing, decisions) {
  const buf = existing.tickBuffer || {};
  for (const d of decisions) {
    if (!buf[d.symbol]) buf[d.symbol] = [];
    buf[d.symbol].push({
      ts: new Date().toISOString(),
      decision: d.decision,
      netEdge: d.netEdge,
      p_hat: d.p_hat,
      z: d.z,
      upMid: d.upMid,
      dnMid: d.dnMid,
      binancePrice: d.binancePrice,
      timeRemaining: d.timeRemaining,
    });
    if (buf[d.symbol].length > RING_BUFFER_MAX) {
      buf[d.symbol] = buf[d.symbol].slice(-RING_BUFFER_MAX);
    }
  }
  return buf;
}

// ═══════════════════════════════════════════════════════════════
// JSONL LOGGING
// ═══════════════════════════════════════════════════════════════
function logDecisions(result) {
  const line = JSON.stringify({
    ts: result.ts,
    cycle: result.cycle,
    activeWindow: result.activeWindow,
    binanceFeed: result.binanceFeed,
    shadowMode: result.shadowMode,
    decisions: result.decisions.map(d => ({
      symbol: d.symbol, decision: d.decision, signal: d.signal, gateBlock: d.gateBlock,
      persistenceCount: d.persistenceCount, persisted: d.persisted,
      binancePrice: d.binancePrice, return_60s: d.return_60s, vol_60s: d.vol_60s,
      p_hat: d.p_hat, z: d.z, rawZ: d.rawZ,
      volFloorHit: d.volFloorHit, zClamped: d.zClamped, pHatClamped: d.pHatClamped,
      effectiveVol: d.effectiveVol, volMultApplied: d.volMultApplied,
      edge: d.edge, fees: d.fees, slippage: d.slippage, buffer: d.buffer, netEdge: d.netEdge,
      upMid: d.upMid, dnMid: d.dnMid, timeRemaining: d.timeRemaining,
      gatesFailing: d.gates?.filter(g => !g.pass).map(g => g.name) || [],
      dominantBlocker: d.dominantBlocker || null,
      counterfactuals: d.counterfactuals || null,
      shadowId: d.shadowId || null,
    })),
  });
  appendFileSync(DECISIONS_LOG_PATH, line + '\n');
}

// ═══════════════════════════════════════════════════════════════
// SAVE STATE
// ═══════════════════════════════════════════════════════════════
function saveControllerState(result, tickBuffer) {
  const proposals = result.decisions.filter(d =>
    d.decision === 'PROPOSE_UP' || d.decision === 'PROPOSE_DN'
  );
  const candidates = result.decisions.filter(d =>
    d.decision === 'CANDIDATE_UP' || d.decision === 'CANDIDATE_DN'
  );

  const state = {
    lastCycle: result.cycle,
    lastTs: result.ts,
    activeWindow: result.activeWindow,
    binanceFeed: result.binanceFeed,
    shadowMode: result.shadowMode,
    shadowStats: result.shadowStats,
    decisions: result.decisions,
    proposals,
    candidates,
    proposalCount: proposals.length,
    candidateCount: candidates.length,
    doNothingCount: result.decisions.filter(d => d.decision === 'DO_NOTHING').length,
    tickBuffer,
    config: {
      feeRate: FEE_RATE, feeExponent: FEE_EXPONENT, notional: NOTIONAL_USDC,
      sigmoidK: SIGMOID_K, volFloor: VOL_FLOOR, volMult: VOL_MULT, volWindowSec: VOL_WINDOW_SEC, zClamp: Z_CLAMP,
      pHatRange: [P_HAT_MIN, P_HAT_MAX],
      proposalThreshold: PROPOSAL_THRESHOLD, edgeBuffer: EDGE_BUFFER,
      persistenceN: PERSISTENCE_N,
      gates: {
        sanityTol: GATE_SANITY_TOL, maxSpread: GATE_MAX_SPREAD,
        minDepth: GATE_MIN_DEPTH, minTimeRemaining: GATE_MIN_TIME_REMAINING,
        minNetEdge: GATE_MIN_NET_EDGE,
      },
    },
  };

  writeFileSync(CONTROLLER_STATE_PATH, JSON.stringify(state, null, 2));
}

// ═══════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════
function parseArgs() {
  const args = process.argv.slice(2);
  let interval = 15_000;
  let duration = 3_600_000;
  let once = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval' && args[i + 1]) { interval = Number(args[i + 1]); i++; }
    else if (args[i] === '--duration' && args[i + 1]) { duration = Number(args[i + 1]); i++; }
    else if (args[i] === '--vol-floor' && args[i + 1]) { VOL_FLOOR = Number(args[i + 1]); i++; }
    else if (args[i] === '--vol-mult' && args[i + 1]) { VOL_MULT = Number(args[i + 1]); i++; }
    else if (args[i] === '--vol-window' && args[i + 1]) { VOL_WINDOW_SEC = Number(args[i + 1]); i++; }
    else if (args[i] === '--z-clamp' && args[i + 1]) { Z_CLAMP = Number(args[i + 1]); i++; }
    else if (args[i] === '--once') { once = true; }
  }

  return { interval, duration, once };
}

async function main() {
  const { interval, duration, once } = parseArgs();

  console.log(`[controller] crypto15m controller v2 starting`);
  console.log(`[controller] fee: ${FEE_RATE} * (p*(1-p))^${FEE_EXPONENT}`);
  console.log(`[controller] signal: sigmoid(${SIGMOID_K} * ret60 / (vol60 + eps)) | volFloor=${VOL_FLOOR} volMult=${VOL_MULT} volWindow=${VOL_WINDOW_SEC}s zClamp=±${Z_CLAMP} pHat=[${P_HAT_MIN},${P_HAT_MAX}]`);
  console.log(`[controller] persistence: ${PERSISTENCE_N} consecutive same-side ticks to promote CANDIDATE → PROPOSE`);
  console.log(`[controller] gates: sanity±${GATE_SANITY_TOL} spread≤${GATE_MAX_SPREAD} depth≥${GATE_MIN_DEPTH} time≥${GATE_MIN_TIME_REMAINING}s netEdge≥${GATE_MIN_NET_EDGE} cexFeed=required`);
  console.log(`[controller] shadow: ${SHADOW_MODE ? 'ON' : 'OFF'}`);
  console.log(`[controller] mode: ${once ? 'single cycle' : `loop interval=${interval}ms duration=${duration}ms`}`);

  // Load any pending shadow proposals from previous runs
  if (SHADOW_MODE) {
    const pending = loadShadowLog();
    shadowProposals.push(...pending);
    if (pending.length > 0) console.log(`[controller] loaded ${pending.length} pending shadow proposals`);
  }

  console.log('[controller] starting Binance feed...');
  await startFeed();

  if (!feedConnected()) {
    console.warn('[controller] WARNING: Binance feed not connected.');
  }

  if (feedConnected()) {
    const waitSec = 12;
    console.log(`[controller] waiting ${waitSec}s for price data to accumulate...`);
    await new Promise(r => setTimeout(r, waitSec * 1000));
    for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
      const f = getFeatures(sym, VOL_WINDOW_SEC);
      console.log(`[controller]   ${sym}: $${f.price} buckets=${f.bucketCount} ok=${f.ok}${f.reason ? ` (${f.reason})` : ''}`);
    }
  }

  console.log('');

  const deadline = Date.now() + duration;
  let cycle = 0;

  const runCycle = async () => {
    cycle++;
    try {
      const result = await controllerCycle(cycle);

      if (result.error) {
        console.log(`[controller] #${cycle} ${result.error}`);
        return;
      }

      const existing = loadControllerState();
      const tickBuffer = updateRingBuffer(existing, result.decisions);
      logDecisions(result);
      saveControllerState(result, tickBuffer);

      // Console output
      const feed = result.binanceFeed ? 'BN:OK' : 'BN:DOWN';
      const summary = result.decisions.map(d => {
        const phat = d.p_hat != null ? `p=${d.p_hat.toFixed(3)}` : 'p=?';
        const zStr = d.z != null ? `z=${d.z.toFixed(2)}` : '';
        const edge = d.netEdge != null ? `net=${(d.netEdge * 100).toFixed(2)}%` : 'net=?';
        const flags = [];
        if (d.volFloorHit) flags.push('VF');
        if (d.zClamped) flags.push('ZC');
        if (d.pHatClamped) flags.push('PC');
        const pers = d.persistenceCount > 0 ? `${d.persistenceCount}/${d.persistenceNeeded}` : '';
        const flagStr = flags.length > 0 ? `[${flags.join(',')}]` : '';
        return `${d.symbol}:${d.decision} ${phat} ${zStr} ${edge} ${pers} ${flagStr}`.replace(/\s+/g, ' ').trim();
      }).join(' | ');

      console.log(`[controller] #${cycle} [${feed}] ${summary}`);

      // Highlight non-DO_NOTHING
      for (const d of result.decisions) {
        if (d.decision !== 'DO_NOTHING') {
          const flags = [d.volFloorHit && 'volFloor', d.zClamped && 'zClamp', d.pHatClamped && 'pHatClamp'].filter(Boolean).join(',');
          console.log(`[controller]   >>> ${d.symbol} ${d.decision} | p_hat=${d.p_hat} z=${d.z} upMid=${d.upMid} | edge=${(d.edge * 100).toFixed(2)}% net=${(d.netEdge * 100).toFixed(2)}% | persist=${d.persistenceCount}/${d.persistenceNeeded}${flags ? ` [${flags}]` : ''}${d.shadowId ? ` shadow=${d.shadowId}` : ''}`);
        }
      }

      // Shadow stats
      if (result.shadowStats && result.shadowStats.resolvedCount > 0) {
        const s = result.shadowStats;
        console.log(`[shadow] stats: ${s.resolvedCount} resolved, ${s.wins}W/${s.losses}L (${(s.winRate * 100).toFixed(1)}%), avgEdge=${(s.avgEdge * 100).toFixed(2)}%, pending=${s.pendingCount}`);
      }
    } catch (e) {
      console.error(`[controller] #${cycle} error:`, e.message);
    }
  };

  if (once) {
    await runCycle();
    stopFeed();
    console.log('[controller] single cycle complete.');
    process.exit(0);
  }

  while (Date.now() < deadline) {
    await runCycle();
    const left = deadline - Date.now();
    if (left > interval) {
      await new Promise(r => setTimeout(r, interval));
    } else {
      break;
    }
  }

  stopFeed();
  console.log(`[controller] done. ${cycle} cycles completed.`);
  process.exit(0);
}

main().catch(e => {
  console.error('[controller] Fatal:', e.message);
  stopFeed();
  process.exit(1);
});

export { controllerCycle, takerFee, checkGates, computeSignal, computePHat };
