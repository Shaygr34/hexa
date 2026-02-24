// crypto15m-adapter.mjs — Resolve BTC/ETH/SOL/XRP 15-minute Up/Down markets
// Uses Gamma (market lookup) + CLOB (orderbook reads) only. No Polygon RPC.
//
// MODE A (default): live window resolver — finds ACTIVE markets with valid CLOB books
// MODE B (--discover): broad keyword search across all active markets

import { writeFileSync } from 'fs';
import { join } from 'path';

const GAMMA = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
const CLOB = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
const STATE_PATH = join(process.cwd(), 'zvi_state.json');

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
const SYMBOLS = ['btc', 'eth', 'sol', 'xrp'];
const SLOT_SECONDS = 900; // 15 minutes
const SANITY_TOLERANCE = 0.05; // yesMid + noMid should be within 1 ± this

function currentSlotTimestamp() {
  return Math.floor(Date.now() / 1000 / SLOT_SECONDS) * SLOT_SECONDS;
}

function slugFor(symbol, timestamp) {
  return `${symbol}-updown-15m-${timestamp}`;
}

// Trading window = endDate - 15min → endDate
function tradingWindow(endDate) {
  const end = new Date(endDate);
  const start = new Date(end.getTime() - SLOT_SECONDS * 1000);
  return { tradingStart: start.toISOString(), tradingEnd: end.toISOString() };
}

function fmtWindow(startIso, endIso) {
  const fmt = d => new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return `${fmt(startIso)} → ${fmt(endIso)}`;
}

// ═══════════════════════════════════════════════════════════════
// CLOB helpers — fetch BOTH Up and Down books explicitly
// ═══════════════════════════════════════════════════════════════
async function fetchBook(tokenId) {
  try {
    const r = await fetch(`${CLOB}/book?token_id=${tokenId}`, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

function topOfBook(book) {
  if (!book) return { bid: null, ask: null, mid: null, bidSize: null, askSize: null, bidCount: 0, askCount: 0 };
  const bids = (book.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
  const asks = (book.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  const bid = bids[0] ? parseFloat(bids[0].price) : null;
  const ask = asks[0] ? parseFloat(asks[0].price) : null;
  const mid = (bid != null && ask != null) ? (bid + ask) / 2 : null;
  return {
    bid, ask, mid,
    bidSize: bids[0] ? parseFloat(bids[0].size) : null,
    askSize: asks[0] ? parseFloat(asks[0].size) : null,
    bidCount: bids.length,
    askCount: asks.length,
  };
}

function parseJsonField(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch (_) { return []; }
}

// ═══════════════════════════════════════════════════════════════
// MODE A: Live window resolver
// ═══════════════════════════════════════════════════════════════
async function resolveBySlug() {
  const slot = currentSlotTimestamp();
  // Try next slot first (most likely to be actively trading), then current, then +2
  const candidates = [slot + SLOT_SECONDS, slot, slot + 2 * SLOT_SECONDS];

  console.log('[crypto15m] MODE A: live window resolver');
  console.log(`[crypto15m] Trying slots: ${candidates.join(', ')}`);
  console.log(`[crypto15m] Resolving ${SYMBOLS.length} symbols...\n`);

  const universeActive = [];
  const universeHistory = [];

  for (const sym of SYMBOLS) {
    let found = false;

    for (const ts of candidates) {
      const slug = slugFor(sym, ts);
      let markets = [];
      try {
        const r = await fetch(`${GAMMA}/markets?slug=${slug}`, { headers: { Accept: 'application/json' } });
        if (r.ok) markets = await r.json();
      } catch (_) { continue; }

      const market = markets[0];
      if (!market || market.closed) {
        if (market?.closed) {
          universeHistory.push(buildRecord(sym, slug, market, null, null));
        }
        continue;
      }

      // Found an open market — fetch BOTH token books
      const tokenIds = parseJsonField(market.clobTokenIds);
      const upTokenId = tokenIds[0];
      const downTokenId = tokenIds[1];

      if (!upTokenId || !downTokenId) continue;

      const [upBook, downBook] = await Promise.all([
        fetchBook(upTokenId),
        fetchBook(downTokenId),
      ]);

      const up = topOfBook(upBook);
      const down = topOfBook(downBook);

      // Sanity: need at least bids on one side to be a real book
      if (up.bidCount === 0 && up.askCount === 0) {
        continue; // CLOB not ready for this slot
      }

      const record = buildRecord(sym, slug, market, up, down);

      // Sanity check
      if (up.mid != null && down.mid != null) {
        const sum = up.mid + down.mid;
        if (Math.abs(sum - 1.0) > SANITY_TOLERANCE) {
          console.log(`[crypto15m]   ⚠ SANITY FAIL ${sym.toUpperCase()}: upMid=${up.mid} + downMid=${down.mid} = ${sum.toFixed(4)} (expected ~1.0)`);
          console.log(`[crypto15m]     upToken=${upTokenId}`);
          console.log(`[crypto15m]     downToken=${downTokenId}`);
        }
      }

      universeActive.push(record);

      const tw = tradingWindow(market.endDate);
      console.log(`[crypto15m]   ${sym.toUpperCase()}: [ACTIVE] "${market.question}"`);
      console.log(`[crypto15m]     slug=${slug}`);
      console.log(`[crypto15m]     window: ${fmtWindow(tw.tradingStart, tw.tradingEnd)}`);
      console.log(`[crypto15m]     Up: bid=${up.bid} ask=${up.ask} mid=${up.mid} (${up.bidCount}b/${up.askCount}a)`);
      console.log(`[crypto15m]     Dn: bid=${down.bid} ask=${down.ask} mid=${down.mid} (${down.bidCount}b/${down.askCount}a)`);
      if (up.mid != null && down.mid != null) {
        console.log(`[crypto15m]     sum=${(up.mid + down.mid).toFixed(4)} | lastTrade: Up=${record.lastTradePrice.up} Dn=${record.lastTradePrice.down}`);
      }
      found = true;
      break;
    }

    if (!found) {
      const triedSlugs = candidates.map(ts => slugFor(sym, ts));
      console.log(`[crypto15m]   ${sym.toUpperCase()}: NO ACTIVE WINDOW WITH CLOB`);
      console.log(`[crypto15m]     tried: ${triedSlugs.join(', ')}`);
    }
  }

  return { universeActive, universeHistory };
}

function buildRecord(sym, slug, market, up, down) {
  const outcomes = parseJsonField(market.outcomes);
  const prices = parseJsonField(market.outcomePrices);
  const tokenIds = parseJsonField(market.clobTokenIds);
  const tw = market.endDate ? tradingWindow(market.endDate) : { tradingStart: null, tradingEnd: null };

  return {
    symbol: sym.toUpperCase(),
    slug,
    status: market.closed ? 'closed' : 'active',
    marketId: market.id,
    conditionId: market.conditionId || null,
    question: market.question,
    enableOrderBook: market.enableOrderBook ?? null,
    outcomes,
    tokenIds: { up: tokenIds[0] || null, down: tokenIds[1] || null },
    // Last trade / outcome prices from Gamma
    lastTradePrice: {
      up: prices[0] ? parseFloat(prices[0]) : null,
      down: prices[1] ? parseFloat(prices[1]) : null,
    },
    // Live CLOB book data
    up: up ? { bid: up.bid, ask: up.ask, mid: up.mid, bidSize: up.bidSize, askSize: up.askSize, bidCount: up.bidCount, askCount: up.askCount } : null,
    down: down ? { bid: down.bid, ask: down.ask, mid: down.mid, bidSize: down.bidSize, askSize: down.askSize, bidCount: down.bidCount, askCount: down.askCount } : null,
    sanitySum: (up?.mid != null && down?.mid != null) ? parseFloat((up.mid + down.mid).toFixed(4)) : null,
    // Window
    tradingWindowStart: tw.tradingStart,
    tradingWindowEnd: tw.tradingEnd,
    rawStartDate: market.startDate || null,
    rawEndDate: market.endDate || null,
    description: (market.description || '').slice(0, 200),
    volume: market.volumeNum || 0,
    liquidity: market.liquidityNum || 0,
    resolvedAt: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// MODE B: Discovery search
// ═══════════════════════════════════════════════════════════════
async function discoverMarkets() {
  console.log('[crypto15m] MODE B: discovery search');
  const allMarkets = [];
  for (let offset = 0; offset <= 2000; offset += 200) {
    const r = await fetch(`${GAMMA}/markets?closed=false&active=true&limit=200&offset=${offset}`, { headers: { Accept: 'application/json' } });
    if (!r.ok) break;
    const batch = await r.json();
    if (batch.length === 0) break;
    allMarkets.push(...batch);
  }
  console.log(`[crypto15m] Scanned ${allMarkets.length} active markets`);
  for (const entry of [{ s: 'BTC', k: ['bitcoin', 'btc'] }, { s: 'ETH', k: ['ethereum'] }, { s: 'SOL', k: ['solana'] }, { s: 'XRP', k: ['xrp', 'ripple'] }]) {
    const matches = allMarkets.filter(m => entry.k.some(k => new RegExp(`\\b${k}\\b`, 'i').test(m.question || '')));
    console.log(`  ${entry.s}: ${matches.length} matches`);
    for (const m of matches.slice(0, 5)) console.log(`    - [${m.id}] ${m.question}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
async function resolve() {
  if (process.argv.includes('--discover')) {
    await discoverMarkets();
    return;
  }

  const { universeActive, universeHistory } = await resolveBySlug();

  const windowRange = universeActive.length > 0
    ? fmtWindow(universeActive[0].tradingWindowStart, universeActive[0].tradingWindowEnd)
    : 'none';

  const state = {
    universeActive,
    universeHistory,
    activeWindow: windowRange,
    resolvedAt: new Date().toISOString(),
    activeCount: universeActive.length,
    closedCount: universeHistory.length,
  };

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  console.log(`\n[crypto15m] resolved ${universeActive.length} active + ${universeHistory.length} history`);
  if (universeActive.length > 0) {
    console.log(`[crypto15m] active window: ${windowRange}`);
  }
  console.log(`[crypto15m] saved → zvi_state.json`);

  return state;
}

// Only auto-run when invoked directly (not when imported by controller/measure)
const isMain = process.argv[1] && (
  process.argv[1].endsWith('crypto15m-adapter.mjs') ||
  process.argv[1].includes('crypto15m-adapter')
);
if (isMain) {
  resolve().catch(e => {
    console.error('[crypto15m] Fatal:', e.message);
    process.exit(1);
  });
}

export { resolve };
