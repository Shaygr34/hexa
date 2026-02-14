#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// ZVI v1 — Fund Operating System Dashboard
// Standalone Node.js server — ZERO npm dependencies
// ═══════════════════════════════════════════════════════════════════════════════

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─── .env.local loader ──────────────────────────────────────────────────────
const ENV_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), '.env.local');

function loadEnv() {
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
    console.log('[env] Loaded .env.local');
  } catch (e) {
    console.warn('[env] Could not load .env.local:', e.message);
  }
}

loadEnv();

// ─── In-memory state ─────────────────────────────────────────────────────────
const state = {
  thresholds: [],
  signals: [],
  pinnedMarkets: [],
  agentHeartbeats: {
    scanner: { lastSeen: Date.now(), status: 'running', interval: 30000 },
    signalEngine: { lastSeen: Date.now(), status: 'running', interval: 60000 },
    riskManager: { lastSeen: Date.now(), status: 'idle', interval: 120000 },
  },
  opportunityCache: { data: [], fetchedAt: 0, ttl: 15000 },
  // ── Founder decision state ──
  founder: {
    capitalAllocated: false,
    fundSize: 6000,             // $6K default
    risksApproved: false,
    decisions: {},              // { marketId: 'BUY' | 'PASS' }
    positions: {},              // { marketId: { side, size, entryPrice, timestamp } }
    capitalDeployed: 0,
    completedSteps: [],
  },
};

// ─── Polymarket API helpers ──────────────────────────────────────────────────
const GAMMA_BASE = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';

async function fetchOpportunities() {
  const now = Date.now();
  if (state.opportunityCache.data.length > 0 && (now - state.opportunityCache.fetchedAt) < state.opportunityCache.ttl) {
    return state.opportunityCache.data;
  }

  try {
    const url = `${GAMMA_BASE}/markets?closed=false&limit=50&order=volume24hr&ascending=false`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ZVI-FundOS/1.0' },
      signal: AbortSignal.timeout(4000),
    });

    if (!resp.ok) throw new Error(`Gamma API ${resp.status}: ${resp.statusText}`);
    const markets = await resp.json();

    const opportunities = [];

    for (const m of markets) {
      if (!m.outcomePrices) continue;

      let prices;
      try {
        prices = JSON.parse(m.outcomePrices);
      } catch { continue; }

      if (!Array.isArray(prices) || prices.length < 2) continue;

      const numPrices = prices.map(Number).filter(p => !isNaN(p) && p > 0);
      if (numPrices.length < 2) continue;

      const sum = numPrices.reduce((a, b) => a + b, 0);
      const edge = Math.abs(1.0 - sum);

      const bestBid = numPrices[0];
      const bestAsk = numPrices.length >= 2 ? numPrices[1] : 0;
      const volume = parseFloat(m.volume24hr) || parseFloat(m.volume) || 0;
      const liquidity = parseFloat(m.liquidityClob) || parseFloat(m.liquidity) || 0;

      // Confidence: composite of edge magnitude, volume, and liquidity
      const edgeScore = Math.min(edge / 0.05, 1.0);
      const volScore = Math.min(volume / 500000, 1.0);
      const liqScore = Math.min(liquidity / 100000, 1.0);
      const confidence = (edgeScore * 0.4 + volScore * 0.35 + liqScore * 0.25) * 100;

      const slug = m.slug || m.conditionId || '';
      const link = slug ? `https://polymarket.com/event/${slug}` : 'https://polymarket.com';

      opportunities.push({
        id: m.id || m.conditionId || crypto.randomUUID(),
        market: m.question || m.title || 'Unknown Market',
        edge: parseFloat((edge * 100).toFixed(3)),
        bestBid: parseFloat(bestBid.toFixed(4)),
        bestAsk: parseFloat(bestAsk.toFixed(4)),
        priceSum: parseFloat(sum.toFixed(4)),
        outcomes: m.outcomes ? (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes) : ['Yes', 'No'],
        volume: Math.round(volume),
        liquidity: Math.round(liquidity),
        confidence: parseFloat(confidence.toFixed(1)),
        link,
        negRisk: !!m.negRisk,
        conditionId: m.conditionId || '',
        updatedAt: m.updatedAt || new Date().toISOString(),
      });
    }

    // Sort by edge descending
    opportunities.sort((a, b) => b.edge - a.edge);

    state.opportunityCache = { data: opportunities, fetchedAt: now, ttl: 15000 };
    state.agentHeartbeats.scanner.lastSeen = now;
    state.agentHeartbeats.scanner.status = 'running';

    return opportunities;
  } catch (err) {
    console.error('[gamma] Fetch error:', err.message, '— loading demo data');
    state.agentHeartbeats.scanner.status = 'demo';
    // Return stale cache or demo data
    if (state.opportunityCache.data.length > 0) return state.opportunityCache.data;
    const demo = getDemoOpportunities();
    state.opportunityCache = { data: demo, fetchedAt: now, ttl: 30000 };
    return demo;
  }
}

function getDemoOpportunities() {
  const markets = [
    { market: 'Will Trump win the 2028 presidential election?', yes: 0.35, no: 0.62, vol: 1842000, liq: 520000, slug: 'will-trump-win-2028', negRisk: false },
    { market: 'Fed rate cut before July 2026?', yes: 0.72, no: 0.31, vol: 980000, liq: 310000, slug: 'fed-rate-cut-before-july-2026', negRisk: false },
    { market: 'Bitcoin above $150k by end of 2026?', yes: 0.28, no: 0.69, vol: 2100000, liq: 890000, slug: 'bitcoin-above-150k-2026', negRisk: false },
    { market: 'Ukraine ceasefire before April 2026?', yes: 0.41, no: 0.55, vol: 750000, liq: 210000, slug: 'ukraine-ceasefire-april-2026', negRisk: true },
    { market: 'S&P 500 above 6500 by March 2026?', yes: 0.58, no: 0.45, vol: 1200000, liq: 420000, slug: 'sp500-above-6500-march-2026', negRisk: false },
    { market: 'Will AI model beat IMO gold medalist in 2026?', yes: 0.62, no: 0.41, vol: 480000, liq: 150000, slug: 'ai-imo-gold-2026', negRisk: true },
    { market: 'US recession in 2026?', yes: 0.22, no: 0.75, vol: 3200000, liq: 1100000, slug: 'us-recession-2026', negRisk: false },
    { market: 'Ethereum ETF inflows > $10B by June 2026?', yes: 0.45, no: 0.52, vol: 620000, liq: 280000, slug: 'eth-etf-inflows-10b', negRisk: false },
    { market: 'Israel-Saudi normalization deal in 2026?', yes: 0.18, no: 0.78, vol: 340000, liq: 95000, slug: 'israel-saudi-normalization-2026', negRisk: true },
    { market: 'GPT-5 released before September 2026?', yes: 0.55, no: 0.48, vol: 890000, liq: 370000, slug: 'gpt5-release-sept-2026', negRisk: false },
    { market: 'Tesla stock above $500 by mid-2026?', yes: 0.30, no: 0.67, vol: 1500000, liq: 600000, slug: 'tesla-500-mid-2026', negRisk: false },
    { market: 'Next Supreme Court retirement in 2026?', yes: 0.33, no: 0.64, vol: 290000, liq: 85000, slug: 'scotus-retirement-2026', negRisk: false },
  ];
  return markets.map((m, i) => {
    const sum = m.yes + m.no;
    const edge = Math.abs(1.0 - sum);
    const edgeScore = Math.min(edge / 0.05, 1.0);
    const volScore = Math.min(m.vol / 500000, 1.0);
    const liqScore = Math.min(m.liq / 100000, 1.0);
    const confidence = (edgeScore * 0.4 + volScore * 0.35 + liqScore * 0.25) * 100;
    return {
      id: crypto.randomUUID(),
      market: m.market,
      edge: parseFloat((edge * 100).toFixed(3)),
      bestBid: m.yes,
      bestAsk: m.no,
      priceSum: parseFloat(sum.toFixed(4)),
      outcomes: ['Yes', 'No'],
      volume: m.vol,
      liquidity: m.liq,
      confidence: parseFloat(confidence.toFixed(1)),
      link: `https://polymarket.com/event/${m.slug}`,
      negRisk: m.negRisk,
      conditionId: `demo-${i}`,
      updatedAt: new Date().toISOString(),
      demo: true,
    };
  }).sort((a, b) => b.edge - a.edge);
}

function checkThresholds(symbol, price) {
  const triggered = [];
  for (const t of state.thresholds) {
    const hit =
      (t.direction === 'above' && price >= t.thresholdPrice) ||
      (t.direction === 'below' && price <= t.thresholdPrice);
    if (hit && t.symbol === symbol) {
      const signal = {
        id: crypto.randomUUID(),
        symbol: t.symbol,
        price,
        threshold: t.thresholdPrice,
        direction: t.direction,
        triggeredAt: new Date().toISOString(),
        brief: `RP Optical Mini-Brief: ${t.symbol} crossed ${t.direction} ${t.thresholdPrice}. ` +
               `Current price: ${price}. ` +
               `Action: Review position sizing and hedging strategy. ` +
               `Risk assessment: ${price > t.thresholdPrice ? 'Elevated' : 'Moderate'}.`,
      };
      state.signals.push(signal);
      triggered.push(signal);
    }
  }
  state.agentHeartbeats.signalEngine.lastSeen = Date.now();
  return triggered;
}

function getConfig() {
  return {
    mode: process.env.OBSERVATION_ONLY === 'true' ? 'OBSERVATION_ONLY' : 'LIVE',
    autoExec: process.env.AUTO_EXEC === 'true',
    killSwitch: process.env.KILL_SWITCH === 'true',
    manualApproval: process.env.MANUAL_APPROVAL_REQUIRED !== 'false',
    secrets: {
      polygonRpc: !!process.env.POLYGON_RPC_URL,
      anthropicKey: !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 10,
      polymarketGamma: !!process.env.POLYMARKET_GAMMA_URL,
      polymarketClob: !!process.env.POLYMARKET_CLOB_URL,
      polymarketPrivateKey: !!process.env.POLYMARKET_PRIVATE_KEY,
      openaiKey: !!process.env.OPENAI_API_KEY,
      telegram: !!process.env.TELEGRAM_BOT_TOKEN,
    },
    riskLimits: {
      maxExposurePerMarket: parseInt(process.env.MAX_EXPOSURE_PER_MARKET) || 500,
      dailyMaxExposure: parseInt(process.env.DAILY_MAX_EXPOSURE) || 2000,
      minEdgeThreshold: parseFloat(process.env.MIN_EDGE_THRESHOLD) || 0.02,
      minDepthUsdc: parseInt(process.env.MIN_DEPTH_USDC) || 100,
    },
  };
}

// ─── AI Blocker Detection Engine ────────────────────────────────────────────
// Analyzes system state and returns prioritized founder actions.
// Critical blockers (API keys, wallet) come first. Then capital, risk approval,
// and finally trading decisions. Each step unlocks the next.
function getBlockers() {
  const cfg = getConfig();
  const blockers = [];

  // ── Priority 1: Polymarket API Keys ──
  const missingApi = [];
  if (!process.env.POLYMARKET_API_KEY) missingApi.push('POLYMARKET_API_KEY');
  if (!process.env.POLYMARKET_API_SECRET) missingApi.push('POLYMARKET_API_SECRET');
  if (!process.env.POLYMARKET_API_PASSPHRASE) missingApi.push('POLYMARKET_API_PASSPHRASE');

  blockers.push({
    id: 'api-keys',
    priority: 1,
    title: 'Connect API Keys',
    desc: 'Polymarket CLOB credentials are required to place orders.',
    status: missingApi.length === 0 ? 'done' : 'blocked',
    missing: missingApi,
    action: 'Add keys to .env.local and restart',
    category: 'critical',
  });

  // ── Priority 2: Wallet Private Key ──
  const hasWallet = !!process.env.POLYMARKET_PRIVATE_KEY;
  blockers.push({
    id: 'wallet',
    priority: 2,
    title: 'Connect Wallet',
    desc: 'Private key needed to sign transactions on Polygon.',
    status: hasWallet ? 'done' : 'blocked',
    missing: hasWallet ? [] : ['POLYMARKET_PRIVATE_KEY'],
    action: 'Add POLYMARKET_PRIVATE_KEY to .env.local',
    category: 'critical',
  });

  // ── Priority 3: Fund Capital Allocation ──
  blockers.push({
    id: 'capital',
    priority: 3,
    title: 'Fund Capital',
    desc: 'Confirm USDC allocation for trading. Current: $' + state.founder.fundSize.toLocaleString(),
    status: state.founder.capitalAllocated ? 'done' : 'action-needed',
    missing: [],
    action: 'Set fund size and confirm',
    category: 'setup',
    interactive: true,
    fundSize: state.founder.fundSize,
  });

  // ── Priority 4: Approve Risk Limits ──
  blockers.push({
    id: 'risks',
    priority: 4,
    title: 'Approve Risk Limits',
    desc: 'Max/market: $' + cfg.riskLimits.maxExposurePerMarket +
          ' | Daily: $' + cfg.riskLimits.dailyMaxExposure +
          ' | Min edge: ' + (cfg.riskLimits.minEdgeThreshold * 100).toFixed(1) + '%',
    status: state.founder.risksApproved ? 'done' : 'action-needed',
    missing: [],
    action: 'Review and approve limits',
    category: 'setup',
    interactive: true,
    limits: cfg.riskLimits,
  });

  // ── Priority 5: Trading decisions (auto-unlocks) ──
  const prevDone = blockers.every(b => b.status === 'done');
  const decisionCount = Object.keys(state.founder.decisions).length;
  blockers.push({
    id: 'trade',
    priority: 5,
    title: 'BUY / PASS Decisions',
    desc: prevDone
      ? 'All systems go. Review opportunities and make decisions. ' + decisionCount + ' decided so far.'
      : 'Complete steps above to unlock trading.',
    status: prevDone ? 'ready' : 'locked',
    missing: [],
    action: 'Review opportunities below',
    category: 'trade',
    decisionsCount: decisionCount,
  });

  const currentStep = blockers.findIndex(b => b.status !== 'done');
  return {
    blockers,
    currentStep: currentStep === -1 ? blockers.length : currentStep + 1,
    totalSteps: blockers.length,
    allClear: prevDone,
    founder: {
      fundSize: state.founder.fundSize,
      capitalAllocated: state.founder.capitalAllocated,
      risksApproved: state.founder.risksApproved,
      capitalDeployed: state.founder.capitalDeployed,
      decisions: state.founder.decisions,
    },
  };
}

// Position sizing: Kelly-lite based on edge, confidence, fund size
function recommendPosition(opp) {
  const fundSize = state.founder.fundSize;
  const maxPerMarket = parseInt(process.env.MAX_EXPOSURE_PER_MARKET) || 500;
  const edgeFraction = opp.edge / 100;
  const confFraction = opp.confidence / 100;
  // Fractional Kelly: edge * confidence * fund, capped at max per market
  const kellySize = Math.round(edgeFraction * confFraction * fundSize * 0.25);
  const size = Math.min(Math.max(kellySize, 10), maxPerMarket);
  const pctOfFund = ((size / fundSize) * 100).toFixed(1);
  return { size, pctOfFund, maxPerMarket };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────
function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ─── Dashboard HTML ──────────────────────────────────────────────────────────
function dashboardHTML() {
  const cfg = getConfig();
  const initialBlockers = getBlockers();
  const initialOpps = getDemoOpportunities();
  // Embed state directly — page renders with ZERO API calls needed
  const EMBEDDED_STATE = JSON.stringify({ blockers: initialBlockers, opportunities: initialOpps });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZVI v1 — Founder Command Center</title>
<style>
  :root {
    --bg-primary: #0c0c11;
    --bg-secondary: #111015;
    --bg-card: #16151e;
    --bg-card-hover: #1e1d28;
    --border: #26242e;
    --border-bright: #3d3b37;
    --text-primary: #e8e5df;
    --text-secondary: #8a8478;
    --text-muted: #5c5850;
    --accent-gold: #c9a84c;
    --accent-gold-hover: #d4b65e;
    --accent-gold-dim: #a8903f;
    --accent-green: #22c55e;
    --accent-yellow: #eab308;
    --accent-red: #ef4444;
    --accent-purple: #8b5cf6;
    --glow-gold: rgba(201, 168, 76, 0.15);
    --glow-green: rgba(34, 197, 94, 0.12);
    --font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
    --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    --ease: cubic-bezier(0.4, 0, 0.2, 1);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.6;
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg-primary); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-bright); }

  /* ── Top Bar ── */
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 32px;
    height: 56px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .topbar-left { display: flex; align-items: center; gap: 16px; }

  .logo {
    font-family: var(--font-mono);
    font-size: 16px;
    font-weight: 700;
    background: linear-gradient(135deg, var(--accent-gold), var(--accent-gold-hover));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: 0.5px;
  }

  .logo-sub {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .topbar-right { display: flex; align-items: center; gap: 12px; }

  .mode-badge {
    padding: 4px 12px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }

  .mode-observation {
    background: rgba(245, 158, 11, 0.15);
    color: var(--accent-yellow);
    border: 1px solid rgba(245, 158, 11, 0.3);
  }

  .mode-live {
    background: rgba(201, 168, 76, 0.12);
    color: var(--accent-gold);
    border: 1px solid rgba(201, 168, 76, 0.3);
    animation: pulse-border 2s infinite;
  }

  @keyframes pulse-border {
    0%, 100% { border-color: rgba(201, 168, 76, 0.3); }
    50% { border-color: rgba(201, 168, 76, 0.7); }
  }

  .secret-badges { display: flex; gap: 6px; }

  .secret-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 10px;
    font-family: var(--font-mono);
    background: var(--bg-card);
    border: 1px solid var(--border);
    transition: border-color 0.2s var(--ease);
  }

  .secret-badge .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .dot-green { background: var(--accent-green); box-shadow: 0 0 4px var(--accent-green); }
  .dot-red { background: var(--accent-red); box-shadow: 0 0 4px var(--accent-red); }

  /* ── Tabs ── */
  .tabs {
    display: flex;
    gap: 0;
    padding: 0 32px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
  }

  .tab {
    padding: 12px 20px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.2s var(--ease);
    user-select: none;
    font-family: var(--font-sans);
  }

  .tab:hover { color: var(--text-primary); background: rgba(201, 168, 76, 0.04); }

  .tab.active {
    color: var(--accent-gold);
    border-bottom-color: var(--accent-gold);
  }

  .tab .count {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 9999px;
    font-size: 10px;
    font-family: var(--font-mono);
    background: var(--bg-card);
    color: var(--text-muted);
    min-width: 18px;
    text-align: center;
  }

  .tab.active .count { background: rgba(201, 168, 76, 0.12); color: var(--accent-gold); }

  /* ── Content ── */
  .content { padding: 24px 32px; }
  .panel { display: none; }
  .panel.active { display: block; }

  /* ── Summary Strip ── */
  .summary-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .summary-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
    position: relative;
    overflow: hidden;
    transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
  }

  .summary-card:hover {
    border-color: var(--border-bright);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }

  .summary-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
  }

  .summary-card.blue::before { background: var(--accent-gold); }
  .summary-card.green::before { background: var(--accent-green); }
  .summary-card.yellow::before { background: var(--accent-yellow); }
  .summary-card.purple::before { background: var(--accent-purple); }
  .summary-card.cyan::before { background: var(--accent-gold-hover); }

  .summary-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-family: var(--font-mono);
    font-weight: 600;
    margin-bottom: 6px;
  }

  .summary-value {
    font-size: 28px;
    font-weight: 700;
    font-family: var(--font-mono);
  }

  .summary-sub {
    font-size: 11px;
    color: var(--text-secondary);
    margin-top: 4px;
  }

  /* ── Table ── */
  .table-wrap {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }

  .table-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
  }

  .table-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .table-actions { display: flex; gap: 8px; align-items: center; }

  .refresh-indicator {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
  }

  .btn {
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-family: var(--font-mono);
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.2s var(--ease);
  }

  .btn:hover { border-color: var(--accent-gold-dim); color: var(--accent-gold); }
  .btn:active { transform: scale(0.97); }

  .btn-primary {
    background: rgba(201, 168, 76, 0.12);
    border-color: rgba(201, 168, 76, 0.4);
    color: var(--accent-gold);
  }

  .btn-primary:hover {
    background: rgba(201, 168, 76, 0.22);
    border-color: var(--accent-gold);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  thead th {
    padding: 12px 16px;
    text-align: left;
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    background: rgba(0,0,0,0.25);
    border-bottom: 1px solid var(--border);
    font-family: var(--font-mono);
    white-space: nowrap;
    user-select: none;
    cursor: pointer;
  }

  thead th:hover { color: var(--accent-gold-dim); }

  tbody tr {
    border-bottom: 1px solid rgba(38, 36, 46, 0.7);
    transition: background 0.15s var(--ease);
  }

  tbody tr:hover { background: var(--bg-card-hover); }
  tbody tr:last-child { border-bottom: none; }

  td {
    padding: 12px 16px;
    vertical-align: middle;
  }

  .market-name {
    max-width: 380px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .market-name a {
    color: var(--text-primary);
    text-decoration: none;
    transition: color 0.15s;
  }

  .market-name a:hover { color: var(--accent-gold); }

  .negrisk-tag {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 9999px;
    font-size: 9px;
    font-family: var(--font-mono);
    background: rgba(139, 92, 246, 0.15);
    color: var(--accent-purple);
    border: 1px solid rgba(139, 92, 246, 0.3);
    margin-left: 6px;
    vertical-align: middle;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  .edge-cell {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 13px;
  }

  .edge-high { color: var(--accent-green); }
  .edge-mid { color: var(--accent-yellow); }
  .edge-low { color: var(--text-muted); }

  .price-cell {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
  }

  .volume-cell {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
  }

  .confidence-bar {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .confidence-track {
    width: 60px;
    height: 4px;
    background: var(--bg-primary);
    border-radius: 2px;
    overflow: hidden;
  }

  .confidence-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s;
  }

  .confidence-val {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    min-width: 30px;
  }

  .pin-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 11px;
    font-family: var(--font-mono);
    transition: all 0.2s var(--ease);
  }

  .pin-btn:hover { border-color: var(--accent-gold-dim); color: var(--accent-gold); }
  .pin-btn.pinned { border-color: var(--accent-gold); color: var(--accent-gold); background: rgba(201,168,76,0.1); }

  /* ── Signals Panel ── */
  .signal-form {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
    flex-wrap: wrap;
    align-items: flex-end;
  }

  .form-group { display: flex; flex-direction: column; gap: 4px; }

  .form-group label {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .form-input {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 7px 10px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 12px;
    outline: none;
    transition: border-color 0.2s var(--ease);
  }

  .form-input:focus { border-color: var(--accent-gold); }

  select.form-input {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235a6478'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 24px;
  }

  .signal-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
    margin-bottom: 12px;
    border-left: 3px solid var(--accent-gold);
  }

  .signal-card .signal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .signal-card .signal-symbol {
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 15px;
    color: var(--accent-gold);
  }

  .signal-card .signal-time {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }

  .signal-card .signal-brief {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.6;
    background: rgba(0,0,0,0.2);
    padding: 12px;
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .threshold-list {
    margin-top: 16px;
  }

  .threshold-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-bottom: 6px;
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .threshold-item .th-symbol { color: var(--accent-gold); font-weight: 600; min-width: 80px; }
  .threshold-item .th-dir { color: var(--text-muted); }
  .threshold-item .th-price { color: var(--accent-gold-hover); font-weight: 600; }
  .threshold-item .th-remove {
    margin-left: auto;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    transition: all 0.15s;
  }
  .threshold-item .th-remove:hover { color: var(--accent-red); background: rgba(239,68,68,0.1); }

  /* ── Pinned Markets ── */
  .pinned-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 12px;
  }

  .pinned-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
    transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
  }

  .pinned-card:hover { border-color: var(--accent-gold-dim); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }

  .pinned-card .pc-title {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 8px;
    line-height: 1.4;
  }

  .pinned-card .pc-title a {
    color: var(--text-primary);
    text-decoration: none;
  }

  .pinned-card .pc-title a:hover { color: var(--accent-gold); }

  .pinned-card .pc-meta {
    display: flex;
    gap: 16px;
    margin-bottom: 12px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }

  .pinned-card .pc-actions {
    display: flex;
    gap: 8px;
  }

  .pinned-card .pc-unpin { color: var(--accent-red); }

  /* ── Agent Health ── */
  .health-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }

  .health-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 24px;
    transition: border-color 0.2s var(--ease);
  }

  .health-card:hover { border-color: var(--border-bright); }

  .health-card .hc-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .health-card .hc-name {
    font-weight: 600;
    font-size: 14px;
  }

  .status-pill {
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 10px;
    font-family: var(--font-mono);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .status-running { background: rgba(16,185,129,0.15); color: var(--accent-green); }
  .status-idle { background: rgba(245,158,11,0.15); color: var(--accent-yellow); }
  .status-error { background: rgba(239,68,68,0.15); color: var(--accent-red); }
  .status-stopped { background: rgba(90,100,120,0.15); color: var(--text-muted); }

  .health-card .hc-row {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    font-size: 12px;
    border-bottom: 1px solid rgba(38, 36, 46, 0.5);
  }

  .health-card .hc-row:last-child { border-bottom: none; }
  .health-card .hc-label { color: var(--text-muted); font-family: var(--font-mono); font-size: 11px; }
  .health-card .hc-val { color: var(--text-secondary); font-family: var(--font-mono); font-size: 11px; }

  /* ── Empty state ── */
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-muted);
  }

  .empty-state .empty-icon {
    font-size: 40px;
    margin-bottom: 12px;
    opacity: 0.3;
  }

  .empty-state p { font-size: 14px; margin-bottom: 4px; }
  .empty-state .empty-hint { font-size: 12px; font-family: var(--font-mono); }

  /* ── Loader ── */
  .loader {
    text-align: center;
    padding: 40px;
  }

  .spinner {
    display: inline-block;
    width: 24px;
    height: 24px;
    border: 2px solid var(--border);
    border-top-color: var(--accent-gold);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .loader-text {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 10px;
  }

  /* ── Toast ── */
  .toast-container {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .toast {
    padding: 10px 16px;
    border-radius: 10px;
    font-size: 12px;
    font-family: var(--font-mono);
    background: var(--bg-card);
    border: 1px solid var(--border);
    color: var(--text-primary);
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    animation: slideIn 0.2s var(--ease);
    max-width: 360px;
  }

  .toast.success { border-color: var(--accent-green); }
  .toast.error { border-color: var(--accent-red); }
  .toast.info { border-color: var(--accent-gold); }

  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  /* ── Responsive ── */
  @media (max-width: 768px) {
    .topbar { padding: 0 12px; flex-wrap: wrap; height: auto; padding: 10px 12px; gap: 8px; }
    .tabs { padding: 0 12px; overflow-x: auto; }
    .tab { padding: 10px 14px; font-size: 12px; white-space: nowrap; }
    .content { padding: 12px; }
    .action-queue { padding: 12px; }
    .summary-strip { grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .summary-card { padding: 14px; }
    .market-name { max-width: 200px; }
    table { font-size: 12px; }
    td, thead th { padding: 8px 10px; }
  }

  /* ── Price simulation form ── */
  .price-sim-form {
    display: flex;
    gap: 10px;
    margin-top: 16px;
    padding: 20px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    align-items: flex-end;
    flex-wrap: wrap;
  }

  /* ── Action Queue (Founder Priority Flow) ── */
  .action-queue {
    padding: 16px 32px;
    background: linear-gradient(180deg, rgba(201, 168, 76, 0.03) 0%, transparent 100%);
    border-bottom: 1px solid var(--border);
  }

  .aq-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .aq-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--accent-gold);
    font-family: var(--font-mono);
  }

  .aq-progress {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }

  .aq-steps {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 4px;
  }

  .aq-step {
    flex: 1;
    min-width: 170px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    transition: all 0.2s var(--ease);
    position: relative;
  }

  .aq-step.step-blocked {
    border-color: rgba(239, 68, 68, 0.4);
    background: rgba(239, 68, 68, 0.04);
  }

  .aq-step.step-current {
    border-color: var(--accent-gold);
    background: rgba(201, 168, 76, 0.06);
    box-shadow: 0 0 20px rgba(201, 168, 76, 0.1);
  }

  .aq-step.step-done {
    border-color: rgba(34, 197, 94, 0.3);
    background: rgba(34, 197, 94, 0.04);
    opacity: 0.65;
  }

  .aq-step.step-locked {
    opacity: 0.3;
    pointer-events: none;
  }

  .aq-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    font-size: 10px;
    font-weight: 700;
    font-family: var(--font-mono);
    margin-bottom: 6px;
  }

  .step-blocked .aq-num { background: rgba(239, 68, 68, 0.2); color: var(--accent-red); }
  .step-current .aq-num { background: rgba(201, 168, 76, 0.2); color: var(--accent-gold); }
  .step-done .aq-num { background: rgba(34, 197, 94, 0.2); color: var(--accent-green); }
  .step-locked .aq-num { background: rgba(92, 88, 80, 0.15); color: var(--text-muted); }

  .aq-step-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 3px;
  }

  .aq-step-desc {
    font-size: 10px;
    color: var(--text-muted);
    line-height: 1.5;
    font-family: var(--font-mono);
  }

  .aq-step-action {
    margin-top: 8px;
  }

  .aq-step-action .btn {
    font-size: 10px;
    padding: 3px 10px;
  }

  .aq-missing {
    margin-top: 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent-red);
    line-height: 1.6;
  }

  .aq-all-clear {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px;
    background: linear-gradient(135deg, rgba(201, 168, 76, 0.06) 0%, rgba(34, 197, 94, 0.06) 100%);
    border: 1px solid rgba(34, 197, 94, 0.25);
    border-radius: 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--accent-green);
    font-weight: 600;
  }

  .aq-capital-input {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    align-items: center;
  }

  .aq-capital-input input {
    width: 80px;
    padding: 3px 6px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .aq-capital-input input:focus {
    border-color: var(--accent-gold);
    outline: none;
  }

  /* ── BUY / PASS Verdict Buttons ── */
  .verdict-cell {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .verdict-btn {
    padding: 3px 10px;
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    border: 1px solid;
    cursor: pointer;
    transition: all 0.2s var(--ease);
    letter-spacing: 0.5px;
    background: none;
  }

  .vb-buy {
    border-color: rgba(34, 197, 94, 0.3);
    color: var(--accent-green);
  }
  .vb-buy:hover { background: rgba(34, 197, 94, 0.15); border-color: var(--accent-green); }
  .vb-buy.active { background: var(--accent-green); color: #000; }

  .vb-pass {
    border-color: rgba(239, 68, 68, 0.3);
    color: var(--accent-red);
  }
  .vb-pass:hover { background: rgba(239, 68, 68, 0.15); border-color: var(--accent-red); }
  .vb-pass.active { background: var(--accent-red); color: #fff; }

  .verdict-locked .verdict-btn {
    opacity: 0.25;
    pointer-events: none;
  }

  .position-rec {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--accent-gold-dim);
    margin-top: 2px;
  }

  .verdict-decided {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
  }

  .verdict-decided.decided-buy { color: var(--accent-green); }
  .verdict-decided.decided-pass { color: var(--text-muted); text-decoration: line-through; }

  /* ── Fund Summary Bar ── */
  .fund-bar {
    display: flex;
    gap: 16px;
    align-items: center;
    padding: 10px 20px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 16px;
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .fund-bar .fb-item { display: flex; gap: 6px; align-items: center; }
  .fund-bar .fb-label { color: var(--text-muted); }
  .fund-bar .fb-value { font-weight: 700; }
  .fund-bar .fb-green { color: var(--accent-green); }
  .fund-bar .fb-yellow { color: var(--accent-yellow); }
  .fund-bar .fb-red { color: var(--accent-red); }
</style>
</head>
<body>

  <!-- ── Top Bar ── -->
  <div class="topbar">
    <div class="topbar-left">
      <div>
        <div class="logo">ZVI v1</div>
        <div class="logo-sub">Fund Operating System</div>
      </div>
    </div>
    <div class="topbar-right">
      <div class="secret-badges" id="secretBadges"></div>
      <div class="mode-badge ${cfg.mode === 'OBSERVATION_ONLY' ? 'mode-observation' : 'mode-live'}" id="modeBadge">
        ${cfg.mode === 'OBSERVATION_ONLY' ? 'Observation Only' : 'LIVE TRADING'}
      </div>
    </div>
  </div>

  <!-- ── Founder Action Queue ── -->
  <div class="action-queue" id="actionQueue">
    <div class="aq-header">
      <span class="aq-title">Founder Action Queue</span>
      <span class="aq-progress" id="aqProgress">Loading...</span>
    </div>
    <div class="aq-steps" id="aqSteps">
      <div style="color:var(--text-muted);font-family:var(--font-mono);font-size:11px;padding:8px;">Detecting blockers...</div>
    </div>
  </div>

  <!-- ── Tabs ── -->
  <div class="tabs">
    <div class="tab active" data-tab="opportunities">Opportunities <span class="count" id="countOpps">--</span></div>
    <div class="tab" data-tab="signals">Signals <span class="count" id="countSignals">0</span></div>
    <div class="tab" data-tab="pinned">Pinned Markets <span class="count" id="countPinned">0</span></div>
    <div class="tab" data-tab="health">Agent Health</div>
  </div>

  <!-- ── Content ── -->
  <div class="content">

    <!-- Opportunities Panel -->
    <div class="panel active" id="panel-opportunities">
      <div class="fund-bar" id="fundBar" style="display:none"></div>
      <div class="summary-strip" id="oppSummary"></div>
      <div class="table-wrap">
        <div class="table-header">
          <div class="table-title">NegRisk Arbitrage Scanner</div>
          <div class="table-actions">
            <span class="refresh-indicator" id="refreshTimer">Refreshing in 30s</span>
            <button class="btn btn-primary" onclick="fetchOpportunities()">Refresh Now</button>
          </div>
        </div>
        <div id="oppTableBody">
          <div class="loader">
            <div class="spinner"></div>
            <div class="loader-text">Scanning Polymarket...</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Signals Panel -->
    <div class="panel" id="panel-signals">
      <h3 style="margin-bottom: 16px; font-size: 16px;">RPOL Threshold Alerts</h3>

      <div class="signal-form">
        <div class="form-group">
          <label>Symbol</label>
          <input class="form-input" id="sigSymbol" placeholder="RPOL" value="RPOL" style="width:100px">
        </div>
        <div class="form-group">
          <label>Threshold Price</label>
          <input class="form-input" id="sigPrice" type="number" step="0.01" placeholder="0.50" style="width:120px">
        </div>
        <div class="form-group">
          <label>Direction</label>
          <select class="form-input" id="sigDir">
            <option value="above">Above</option>
            <option value="below">Below</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="addThreshold()">Add Threshold</button>
      </div>

      <div class="threshold-list" id="thresholdList"></div>

      <div class="price-sim-form">
        <div class="form-group">
          <label>Simulate Price Update</label>
          <input class="form-input" id="simSymbol" placeholder="RPOL" value="RPOL" style="width:100px">
        </div>
        <div class="form-group">
          <label>Price</label>
          <input class="form-input" id="simPrice" type="number" step="0.01" placeholder="0.55" style="width:120px">
        </div>
        <button class="btn btn-primary" onclick="simulatePrice()">Send Price Update</button>
      </div>

      <h3 style="margin: 24px 0 12px; font-size: 14px; color: var(--text-secondary);">Triggered Signals</h3>
      <div id="signalsList">
        <div class="empty-state">
          <div class="empty-icon">~</div>
          <p>No signals triggered yet</p>
          <p class="empty-hint">Add thresholds and simulate price updates to generate signals</p>
        </div>
      </div>
    </div>

    <!-- Pinned Markets Panel -->
    <div class="panel" id="panel-pinned">
      <h3 style="margin-bottom: 16px; font-size: 16px;">Pinned Markets for LLM Analysis</h3>
      <div class="pinned-grid" id="pinnedGrid">
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="empty-icon">*</div>
          <p>No markets pinned yet</p>
          <p class="empty-hint">Pin markets from the Opportunities tab to track them here</p>
        </div>
      </div>
    </div>

    <!-- Agent Health Panel -->
    <div class="panel" id="panel-health">
      <h3 style="margin-bottom: 16px; font-size: 16px;">Agent Health Monitor</h3>
      <div class="health-grid" id="healthGrid"></div>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

<script>
  // ── Server-embedded state (renders INSTANTLY, no API wait) ──
  const __INITIAL__ = ${EMBEDDED_STATE};
  let opportunities = __INITIAL__.opportunities || [];
  let signals = [];
  let thresholds = [];
  let pinnedMarkets = new Set();
  let refreshCountdown = 30;
  let refreshInterval;
  let countdownInterval;

  // ── Tab Navigation ──
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    });
  });

  // ── Toast ──
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ── Number formatting ──
  function fmt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toString();
  }

  // ── Fetch config for secret badges ──
  async function loadConfig() {
    try {
      const r = await fetch('/api/config');
      const cfg = await r.json();

      const badges = [
        { key: 'polygonRpc', label: 'Polygon RPC' },
        { key: 'anthropicKey', label: 'Anthropic' },
        { key: 'polymarketGamma', label: 'Polymarket' },
      ];

      document.getElementById('secretBadges').innerHTML = badges.map(b => {
        const ok = cfg.secrets[b.key];
        return '<div class="secret-badge"><span class="dot ' + (ok ? 'dot-green' : 'dot-red') + '"></span>' + b.label + '</div>';
      }).join('');
    } catch (e) {
      console.error('Config load error:', e);
    }
  }

  // ── Fetch opportunities ──
  async function fetchOpportunities() {
    try {
      const r = await fetch('/api/opportunities');
      const data = await r.json();
      opportunities = data.opportunities || data;
      renderOpportunities();
      refreshCountdown = 30;
      toast('Markets refreshed (' + opportunities.length + ' scanned)', 'success');
    } catch (e) {
      console.error('Fetch error:', e);
      toast('Failed to fetch opportunities', 'error');
    }
  }

  // ── Render opportunities ──
  function renderOpportunities() {
    const ct = document.getElementById('countOpps');
    const withEdge = opportunities.filter(o => o.edge > 0.5);
    ct.textContent = withEdge.length;

    // Summary
    const totalVol = opportunities.reduce((a, o) => a + o.volume, 0);
    const avgEdge = opportunities.length > 0
      ? opportunities.reduce((a, o) => a + o.edge, 0) / opportunities.length
      : 0;
    const maxEdge = opportunities.length > 0 ? Math.max(...opportunities.map(o => o.edge)) : 0;
    const negRiskCount = opportunities.filter(o => o.negRisk).length;

    document.getElementById('oppSummary').innerHTML = [
      { label: 'Markets Scanned', value: opportunities.length, cls: 'blue' },
      { label: 'Arb Opportunities', value: withEdge.length, cls: 'green', sub: '> 0.5% edge' },
      { label: 'Max Edge', value: maxEdge.toFixed(2) + '%', cls: 'cyan' },
      { label: 'Avg Edge', value: avgEdge.toFixed(2) + '%', cls: 'yellow' },
      { label: 'Total Volume 24h', value: '$' + fmt(totalVol), cls: 'purple' },
      { label: 'NegRisk Markets', value: negRiskCount, cls: 'blue' },
    ].map(s =>
      '<div class="summary-card ' + s.cls + '">' +
        '<div class="summary-label">' + s.label + '</div>' +
        '<div class="summary-value">' + s.value + '</div>' +
        (s.sub ? '<div class="summary-sub">' + s.sub + '</div>' : '') +
      '</div>'
    ).join('');

    if (opportunities.length === 0) {
      document.getElementById('oppTableBody').innerHTML =
        '<div class="empty-state"><div class="empty-icon">~</div><p>No opportunities found</p></div>';
      return;
    }

    let html = '<table><thead><tr>' +
      '<th>#</th>' +
      '<th>Market</th>' +
      '<th>Edge %</th>' +
      '<th>Best Bid</th>' +
      '<th>Best Ask</th>' +
      '<th>Volume 24h</th>' +
      '<th>Liquidity</th>' +
      '<th>Confidence</th>' +
      '<th>Verdict</th>' +
      '<th>Pin</th>' +
      '</tr></thead><tbody>';

    opportunities.forEach((o, i) => {
      const edgeClass = o.edge >= 2 ? 'edge-high' : o.edge >= 1 ? 'edge-mid' : 'edge-low';
      const confColor = o.confidence >= 60 ? 'var(--accent-green)'
        : o.confidence >= 30 ? 'var(--accent-yellow)' : 'var(--text-muted)';
      const isPinned = pinnedMarkets.has(o.id);

      html += '<tr>' +
        '<td class="price-cell">' + (i + 1) + '</td>' +
        '<td class="market-name"><a href="' + esc(o.link) + '" target="_blank" rel="noopener">' + esc(o.market) + '</a>' +
          (o.negRisk ? '<span class="negrisk-tag">NegRisk</span>' : '') +
        '</td>' +
        '<td class="edge-cell ' + edgeClass + '">' + o.edge.toFixed(2) + '%</td>' +
        '<td class="price-cell">' + o.bestBid.toFixed(4) + '</td>' +
        '<td class="price-cell">' + o.bestAsk.toFixed(4) + '</td>' +
        '<td class="volume-cell">$' + fmt(o.volume) + '</td>' +
        '<td class="volume-cell">$' + fmt(o.liquidity) + '</td>' +
        '<td><div class="confidence-bar">' +
          '<div class="confidence-track"><div class="confidence-fill" style="width:' + o.confidence + '%;background:' + confColor + '"></div></div>' +
          '<span class="confidence-val">' + o.confidence.toFixed(0) + '</span>' +
        '</div></td>' +
        '<td>' + renderVerdictCell(o) + '</td>' +
        '<td><button class="pin-btn' + (isPinned ? ' pinned' : '') + '" onclick="togglePin(\\'' + o.id + '\\')">' + (isPinned ? 'Unpin' : 'Pin') + '</button></td>' +
        '</tr>';
    });

    html += '</tbody></table>';
    document.getElementById('oppTableBody').innerHTML = html;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Pin / Unpin ──
  function togglePin(id) {
    if (pinnedMarkets.has(id)) {
      pinnedMarkets.delete(id);
      toast('Market unpinned', 'info');
    } else {
      pinnedMarkets.add(id);
      toast('Market pinned for LLM analysis', 'success');
    }
    renderOpportunities();
    renderPinned();
  }

  function renderPinned() {
    const pinned = opportunities.filter(o => pinnedMarkets.has(o.id));
    document.getElementById('countPinned').textContent = pinned.length;

    if (pinned.length === 0) {
      document.getElementById('pinnedGrid').innerHTML =
        '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">*</div><p>No markets pinned yet</p><p class="empty-hint">Pin markets from the Opportunities tab to track them here</p></div>';
      return;
    }

    document.getElementById('pinnedGrid').innerHTML = pinned.map(o => {
      const edgeClass = o.edge >= 2 ? 'edge-high' : o.edge >= 1 ? 'edge-mid' : 'edge-low';
      return '<div class="pinned-card">' +
        '<div class="pc-title"><a href="' + esc(o.link) + '" target="_blank">' + esc(o.market) + '</a>' +
          (o.negRisk ? ' <span class="negrisk-tag">NegRisk</span>' : '') +
        '</div>' +
        '<div class="pc-meta">' +
          '<span class="' + edgeClass + '">Edge: ' + o.edge.toFixed(2) + '%</span>' +
          '<span>Vol: $' + fmt(o.volume) + '</span>' +
          '<span>Liq: $' + fmt(o.liquidity) + '</span>' +
          '<span>Conf: ' + o.confidence.toFixed(0) + '</span>' +
        '</div>' +
        '<div class="pc-actions">' +
          '<a class="btn" href="' + esc(o.link) + '" target="_blank">View on Polymarket</a>' +
          '<button class="btn pc-unpin" onclick="togglePin(\\'' + o.id + '\\')">Unpin</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ── Threshold Management ──
  async function addThreshold() {
    const symbol = document.getElementById('sigSymbol').value.trim();
    const price = parseFloat(document.getElementById('sigPrice').value);
    const dir = document.getElementById('sigDir').value;

    if (!symbol || isNaN(price)) {
      toast('Please fill in symbol and price', 'error');
      return;
    }

    try {
      const r = await fetch('/api/signals/thresholds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, thresholdPrice: price, direction: dir }),
      });
      const data = await r.json();
      thresholds = data.thresholds || [];
      renderThresholds();
      document.getElementById('sigPrice').value = '';
      toast('Threshold added: ' + symbol + ' ' + dir + ' ' + price, 'success');
    } catch (e) {
      toast('Failed to add threshold', 'error');
    }
  }

  function renderThresholds() {
    if (thresholds.length === 0) {
      document.getElementById('thresholdList').innerHTML =
        '<div style="color:var(--text-muted);font-size:12px;font-family:var(--font-mono);padding:8px 0;">No active thresholds</div>';
      return;
    }

    document.getElementById('thresholdList').innerHTML = thresholds.map((t, i) =>
      '<div class="threshold-item">' +
        '<span class="th-symbol">' + esc(t.symbol) + '</span>' +
        '<span class="th-dir">' + t.direction + '</span>' +
        '<span class="th-price">$' + t.thresholdPrice.toFixed(2) + '</span>' +
        '<span class="th-remove" onclick="removeThreshold(' + i + ')">x</span>' +
      '</div>'
    ).join('');
  }

  function removeThreshold(idx) {
    thresholds.splice(idx, 1);
    renderThresholds();
    toast('Threshold removed', 'info');
  }

  // ── Price Simulation ──
  async function simulatePrice() {
    const symbol = document.getElementById('simSymbol').value.trim();
    const price = parseFloat(document.getElementById('simPrice').value);
    if (!symbol || isNaN(price)) {
      toast('Enter symbol and price', 'error');
      return;
    }

    try {
      const r = await fetch('/api/price-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, price }),
      });
      const data = await r.json();
      if (data.triggered && data.triggered.length > 0) {
        signals = [...data.triggered, ...signals];
        renderSignals();
        toast(data.triggered.length + ' signal(s) triggered!', 'success');
      } else {
        toast('Price update received, no thresholds crossed', 'info');
      }
    } catch (e) {
      toast('Price simulation failed', 'error');
    }
  }

  function renderSignals() {
    document.getElementById('countSignals').textContent = signals.length;

    if (signals.length === 0) {
      document.getElementById('signalsList').innerHTML =
        '<div class="empty-state"><div class="empty-icon">~</div><p>No signals triggered yet</p><p class="empty-hint">Add thresholds and simulate price updates to generate signals</p></div>';
      return;
    }

    document.getElementById('signalsList').innerHTML = signals.map(s =>
      '<div class="signal-card">' +
        '<div class="signal-header">' +
          '<span class="signal-symbol">' + esc(s.symbol) + ' @ ' + s.price.toFixed(4) + '</span>' +
          '<span class="signal-time">' + new Date(s.triggeredAt).toLocaleTimeString() + '</span>' +
        '</div>' +
        '<div class="signal-brief">' + esc(s.brief) + '</div>' +
      '</div>'
    ).join('');
  }

  // ── Signals fetch ──
  async function fetchSignals() {
    try {
      const r = await fetch('/api/signals');
      const data = await r.json();
      signals = data.signals || [];
      thresholds = data.thresholds || [];
      renderSignals();
      renderThresholds();
    } catch (e) { /* silent */ }
  }

  // ── Health ──
  async function fetchHealth() {
    try {
      const r = await fetch('/api/health');
      const data = await r.json();

      const agents = data.agents || {};
      document.getElementById('healthGrid').innerHTML = Object.entries(agents).map(([name, info]) => {
        const ago = Math.round((Date.now() - info.lastSeen) / 1000);
        const statusCls = 'status-' + (info.status || 'idle');
        return '<div class="health-card">' +
          '<div class="hc-header">' +
            '<span class="hc-name">' + esc(name) + '</span>' +
            '<span class="status-pill ' + statusCls + '">' + (info.status || 'unknown') + '</span>' +
          '</div>' +
          '<div class="hc-row"><span class="hc-label">Last Heartbeat</span><span class="hc-val">' + ago + 's ago</span></div>' +
          '<div class="hc-row"><span class="hc-label">Check Interval</span><span class="hc-val">' + (info.interval / 1000) + 's</span></div>' +
          '<div class="hc-row"><span class="hc-label">Uptime Status</span><span class="hc-val">' + (ago < (info.interval / 1000) * 2 ? 'Healthy' : 'Stale') + '</span></div>' +
        '</div>';
      }).join('');
    } catch (e) {
      document.getElementById('healthGrid').innerHTML = '<div class="empty-state"><p>Failed to load health data</p></div>';
    }
  }

  // ── Refresh countdown ──
  function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    refreshCountdown = 30;
    countdownInterval = setInterval(() => {
      refreshCountdown--;
      const el = document.getElementById('refreshTimer');
      if (el) el.textContent = 'Refreshing in ' + refreshCountdown + 's';
      if (refreshCountdown <= 0) {
        refreshCountdown = 30;
        fetchOpportunities();
      }
    }, 1000);
  }

  // ── Blocker / Action Queue State (pre-loaded from server) ──
  let blockerData = __INITIAL__.blockers || null;
  let founderDecisions = blockerData?.founder?.decisions || {};
  let tradingUnlocked = blockerData?.allClear || false;

  async function fetchBlockers() {
    try {
      const r = await fetch('/api/blockers');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      blockerData = await r.json();
      founderDecisions = blockerData.founder?.decisions || {};
      tradingUnlocked = blockerData.allClear;
      renderActionQueue();
      renderFundBar();
      // Re-render opportunities to update verdict buttons
      if (opportunities.length > 0) renderOpportunities();
    } catch (e) {
      console.error('Blocker fetch error:', e);
      document.getElementById('aqProgress').textContent = 'Error loading';
      document.getElementById('aqSteps').innerHTML =
        '<div style="color:var(--accent-red);font-family:var(--font-mono);font-size:11px;padding:8px;">' +
        'Failed to load blockers: ' + esc(e.message) + ' — check terminal</div>';
    }
  }

  function renderActionQueue() {
    if (!blockerData) return;
    const { blockers, currentStep, totalSteps, allClear } = blockerData;

    document.getElementById('aqProgress').textContent =
      allClear ? 'ALL CLEAR' : 'Step ' + currentStep + ' of ' + totalSteps;

    if (allClear) {
      document.getElementById('aqSteps').innerHTML =
        '<div class="aq-all-clear">' +
          '<span style="font-size:16px">></span> ALL SYSTEMS GO — Ready to trade. ' +
          'Scroll down to make BUY / PASS decisions.' +
        '</div>';
      return;
    }

    document.getElementById('aqSteps').innerHTML = blockers.map((b, i) => {
      let stepClass = 'step-locked';
      if (b.status === 'done') stepClass = 'step-done';
      else if (b.status === 'blocked') stepClass = i === currentStep - 1 ? 'step-blocked step-current' : 'step-blocked';
      else if (b.status === 'action-needed') stepClass = i === currentStep - 1 ? 'step-current' : '';
      else if (b.status === 'ready') stepClass = 'step-current';

      let statusIcon = '';
      if (b.status === 'done') statusIcon = '[OK]';
      else if (b.status === 'blocked') statusIcon = '[!!]';
      else if (b.status === 'action-needed') statusIcon = '[>>]';
      else if (b.status === 'locked') statusIcon = '[--]';

      let actionHtml = '';
      if (b.status !== 'done' && b.status !== 'locked') {
        if (b.id === 'capital' && b.status === 'action-needed') {
          actionHtml =
            '<div class="aq-capital-input">' +
              '<span style="color:var(--text-muted);font-size:10px">$</span>' +
              '<input type="number" id="aqCapitalInput" value="' + (blockerData.founder?.fundSize || 6000) + '" min="100" step="500">' +
              '<button class="btn btn-primary" style="font-size:10px;padding:3px 8px" onclick="setCapital()">Confirm</button>' +
            '</div>';
        } else if (b.id === 'risks' && b.status === 'action-needed') {
          actionHtml =
            '<div class="aq-step-action">' +
              '<button class="btn btn-primary" onclick="approveRisks()">Approve Limits</button>' +
            '</div>';
        } else if (b.status === 'blocked' && b.missing && b.missing.length > 0) {
          actionHtml = '<div class="aq-missing">Missing: ' + b.missing.join(', ') + '</div>';
        }
      }

      return '<div class="aq-step ' + stepClass + '">' +
        '<div class="aq-num">' + (b.status === 'done' ? '>' : (i + 1)) + '</div>' +
        '<div class="aq-step-title">' + statusIcon + ' ' + esc(b.title) + '</div>' +
        '<div class="aq-step-desc">' + esc(b.desc) + '</div>' +
        actionHtml +
      '</div>';
    }).join('');
  }

  function renderFundBar() {
    const bar = document.getElementById('fundBar');
    if (!blockerData || !blockerData.founder) { bar.style.display = 'none'; return; }
    const f = blockerData.founder;
    if (!f.capitalAllocated) { bar.style.display = 'none'; return; }

    const remaining = f.fundSize - f.capitalDeployed;
    const pctUsed = ((f.capitalDeployed / f.fundSize) * 100).toFixed(0);
    const decisions = Object.values(f.decisions || {});
    const buys = decisions.filter(d => d.verdict === 'BUY').length;
    const passes = decisions.filter(d => d.verdict === 'PASS').length;
    const remainClass = remaining > f.fundSize * 0.3 ? 'fb-green' : remaining > f.fundSize * 0.1 ? 'fb-yellow' : 'fb-red';

    bar.style.display = 'flex';
    bar.innerHTML =
      '<div class="fb-item"><span class="fb-label">Fund:</span><span class="fb-value">$' + f.fundSize.toLocaleString() + '</span></div>' +
      '<div class="fb-item"><span class="fb-label">Deployed:</span><span class="fb-value fb-yellow">$' + f.capitalDeployed.toLocaleString() + ' (' + pctUsed + '%)</span></div>' +
      '<div class="fb-item"><span class="fb-label">Remaining:</span><span class="fb-value ' + remainClass + '">$' + remaining.toLocaleString() + '</span></div>' +
      '<div class="fb-item"><span class="fb-label">Decisions:</span><span class="fb-value">' + buys + ' BUY / ' + passes + ' PASS</span></div>';
  }

  // ── Verdict rendering per opportunity ──
  function renderVerdictCell(o) {
    const decision = founderDecisions[o.id];

    if (decision) {
      if (decision.verdict === 'BUY') {
        return '<div class="verdict-decided decided-buy">BUY</div>';
      }
      return '<div class="verdict-decided decided-pass">PASS</div>';
    }

    if (!tradingUnlocked) {
      return '<div class="verdict-cell verdict-locked">' +
        '<button class="verdict-btn vb-buy" disabled>BUY</button>' +
        '<button class="verdict-btn vb-pass" disabled>PASS</button>' +
      '</div>';
    }

    return '<div class="verdict-cell">' +
      '<button class="verdict-btn vb-buy" onclick="founderDecide(\\'' + o.id + '\\', \\'BUY\\', \\'' + esc(o.market).replace(/'/g, "\\\\'") + '\\')">BUY</button>' +
      '<button class="verdict-btn vb-pass" onclick="founderDecide(\\'' + o.id + '\\', \\'PASS\\', \\'' + esc(o.market).replace(/'/g, "\\\\'") + '\\')">PASS</button>' +
    '</div>';
  }

  async function founderDecide(marketId, verdict, market) {
    try {
      const r = await fetch('/api/founder/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId, verdict, market }),
      });
      const data = await r.json();
      if (data.ok) {
        founderDecisions[marketId] = { verdict };
        if (verdict === 'BUY' && data.position) {
          toast('BUY — Recommended: $' + data.position.size + ' (' + data.position.pctOfFund + '% of fund)', 'success');
        } else {
          toast('PASS — Market skipped', 'info');
        }
        await fetchBlockers();
      }
    } catch (e) {
      toast('Decision failed', 'error');
    }
  }

  async function setCapital() {
    const input = document.getElementById('aqCapitalInput');
    const size = parseInt(input?.value);
    if (!size || size < 100) { toast('Fund size must be >= $100', 'error'); return; }

    try {
      const r = await fetch('/api/founder/set-capital', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fundSize: size }),
      });
      const data = await r.json();
      if (data.ok) {
        blockerData = data.blockers;
        toast('Fund capital set: $' + size.toLocaleString(), 'success');
        renderActionQueue();
        renderFundBar();
      }
    } catch (e) {
      toast('Failed to set capital', 'error');
    }
  }

  async function approveRisks() {
    try {
      const r = await fetch('/api/founder/approve-risks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (data.ok) {
        blockerData = data.blockers;
        tradingUnlocked = data.blockers.allClear;
        toast('Risk limits approved', 'success');
        renderActionQueue();
        if (opportunities.length > 0) renderOpportunities();
      }
    } catch (e) {
      toast('Failed to approve risks', 'error');
    }
  }

  // ── Init ──
  function init() {
    loadConfig();

    // RENDER IMMEDIATELY from server-embedded state (zero API wait)
    renderActionQueue();
    renderFundBar();
    renderOpportunities();

    // Background refresh — updates if Polymarket is reachable, otherwise keeps demo data
    fetchBlockers().catch(e => console.error('blockers:', e));
    fetchOpportunities().catch(e => console.error('opps:', e));
    fetchSignals().catch(() => {});
    fetchHealth().catch(() => {});
    startCountdown();

    setInterval(fetchHealth, 30000);
    setInterval(fetchBlockers, 30000);
  }

  init();
</script>
</body>
</html>`;
}

// ─── Route handler ───────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
  const method = req.method;
  const pathname = url.pathname;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    // ── API routes ──
    if (pathname === '/api/health' && method === 'GET') {
      return json(res, {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        mode: process.env.OBSERVATION_ONLY === 'true' ? 'OBSERVATION_ONLY' : 'LIVE',
        agents: state.agentHeartbeats,
      });
    }

    if (pathname === '/api/opportunities' && method === 'GET') {
      const opps = await fetchOpportunities();
      return json(res, {
        opportunities: opps,
        count: opps.length,
        fetchedAt: new Date(state.opportunityCache.fetchedAt).toISOString(),
      });
    }

    if (pathname === '/api/signals' && method === 'GET') {
      return json(res, {
        signals: state.signals,
        thresholds: state.thresholds,
      });
    }

    if (pathname === '/api/signals/thresholds' && method === 'POST') {
      const body = await readBody(req);
      const { symbol, thresholdPrice, direction } = body;

      if (!symbol || typeof thresholdPrice !== 'number' || !['above', 'below'].includes(direction)) {
        return json(res, { error: 'Invalid threshold. Requires: symbol, thresholdPrice (number), direction (above|below)' }, 400);
      }

      state.thresholds.push({
        id: crypto.randomUUID(),
        symbol,
        thresholdPrice,
        direction,
        createdAt: new Date().toISOString(),
      });

      return json(res, { ok: true, thresholds: state.thresholds });
    }

    if (pathname === '/api/price-update' && method === 'POST') {
      const body = await readBody(req);
      const { symbol, price } = body;

      if (!symbol || typeof price !== 'number') {
        return json(res, { error: 'Invalid. Requires: symbol, price (number)' }, 400);
      }

      const triggered = checkThresholds(symbol, price);
      return json(res, {
        ok: true,
        symbol,
        price,
        thresholdsChecked: state.thresholds.length,
        triggered,
      });
    }

    if (pathname === '/api/config' && method === 'GET') {
      return json(res, getConfig());
    }

    // ── Founder Blocker / Action Queue ──
    if (pathname === '/api/blockers' && method === 'GET') {
      return json(res, getBlockers());
    }

    if (pathname === '/api/founder/set-capital' && method === 'POST') {
      const body = await readBody(req);
      const size = parseInt(body.fundSize);
      if (!size || size < 100) {
        return json(res, { error: 'Fund size must be >= $100' }, 400);
      }
      state.founder.fundSize = size;
      state.founder.capitalAllocated = true;
      if (!state.founder.completedSteps.includes('capital')) {
        state.founder.completedSteps.push('capital');
      }
      return json(res, { ok: true, fundSize: size, blockers: getBlockers() });
    }

    if (pathname === '/api/founder/approve-risks' && method === 'POST') {
      state.founder.risksApproved = true;
      if (!state.founder.completedSteps.includes('risks')) {
        state.founder.completedSteps.push('risks');
      }
      return json(res, { ok: true, blockers: getBlockers() });
    }

    if (pathname === '/api/founder/decide' && method === 'POST') {
      const body = await readBody(req);
      const { marketId, verdict, market } = body;
      if (!marketId || !['BUY', 'PASS'].includes(verdict)) {
        return json(res, { error: 'Requires marketId and verdict (BUY|PASS)' }, 400);
      }
      state.founder.decisions[marketId] = {
        verdict,
        market: market || '',
        timestamp: new Date().toISOString(),
      };
      // If BUY, compute position recommendation
      let position = null;
      if (verdict === 'BUY') {
        const opp = state.opportunityCache.data.find(o => o.id === marketId);
        if (opp) {
          position = recommendPosition(opp);
          state.founder.positions[marketId] = {
            side: 'YES',
            recommendedSize: position.size,
            entryEdge: opp.edge,
            timestamp: new Date().toISOString(),
          };
          state.founder.capitalDeployed += position.size;
        }
      }
      return json(res, {
        ok: true,
        marketId,
        verdict,
        position,
        decisions: state.founder.decisions,
        capitalDeployed: state.founder.capitalDeployed,
      });
    }

    // ── Dashboard ──
    if (pathname === '/' || pathname === '/index.html') {
      const html = dashboardHTML();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    }

    // ── 404 ──
    json(res, { error: 'Not found', path: pathname }, 404);

  } catch (err) {
    console.error('[server] Request error:', err);
    json(res, { error: 'Internal server error', message: err.message }, 500);
  }
}

// ─── Server startup ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   ZVI v1 — Fund Operating System Dashboard   ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log(`  ║   http://localhost:${PORT}                      ║`);
  console.log('  ║   Mode: ' + (process.env.OBSERVATION_ONLY === 'true' ? 'OBSERVATION ONLY' : 'LIVE') + '                       ║');
  console.log('  ║   Node: ' + process.version + '                          ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Secrets loaded:');
  console.log('    Polygon RPC:  ' + (process.env.POLYGON_RPC_URL ? 'YES' : 'NO'));
  console.log('    Anthropic:    ' + (process.env.ANTHROPIC_API_KEY ? 'YES' : 'NO'));
  console.log('    Polymarket:   ' + (process.env.POLYMARKET_GAMMA_URL ? 'YES' : 'NO'));
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[fatal] Port ${PORT} is already in use. Kill the existing process or set PORT env var.`);
    process.exit(1);
  }
  console.error('[fatal] Server error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[shutdown] Received SIGINT, shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
});

process.on('SIGTERM', () => {
  console.log('\n[shutdown] Received SIGTERM, shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
});
