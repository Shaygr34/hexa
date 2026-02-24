#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// ZVI v1 — Crypto 15-min UP/DOWN Market Adapter
// Resolves Polymarket event metadata + token IDs for the anchor
// crypto 15m markets. Persists to zvi_state.json.
// ═══════════════════════════════════════════════════════════════

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const BASE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const STATE_PATH = path.join(BASE_DIR, 'zvi_state.json');

const GAMMA_BASE = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
const CLOB_BASE = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';

// ── Anchor Markets ──────────────────────────────────────────────
export const ANCHOR_EVENTS = [
  { asset: 'BTC', slug: 'btc-updown-15m-1771925400', url: 'https://polymarket.com/event/btc-updown-15m-1771925400' },
  { asset: 'ETH', slug: 'eth-updown-15m-1771925400', url: 'https://polymarket.com/event/eth-updown-15m-1771925400' },
  { asset: 'SOL', slug: 'sol-updown-15m-1771925400', url: 'https://polymarket.com/event/sol-updown-15m-1771925400' },
  { asset: 'XRP', slug: 'xrp-updown-15m-1771925400', url: 'https://polymarket.com/event/xrp-updown-15m-1771925400' },
];

// ── HTTP helpers ────────────────────────────────────────────────
function httpGetJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ data: JSON.parse(body), latencyMs, status: res.statusCode }); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Gamma: resolve event slug → markets + tokens ────────────────
async function resolveEventBySlug(slug) {
  // The Gamma API /events endpoint keyed by slug
  const url = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;
  try {
    const { data, latencyMs } = await httpGetJson(url);
    const events = Array.isArray(data) ? data : [data];
    const event = events.find(e => e && e.slug === slug) || events[0];
    if (!event) return null;
    return { event, latencyMs };
  } catch {
    // Fallback: search markets by slug substring
    try {
      const marketsUrl = `${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}&limit=10`;
      const { data, latencyMs } = await httpGetJson(marketsUrl);
      if (Array.isArray(data) && data.length > 0) {
        return { markets: data, latencyMs, fromMarketSearch: true };
      }
    } catch { /* swallow */ }
    return null;
  }
}

// ── CLOB: fetch book for a token ────────────────────────────────
export async function fetchBook(tokenId) {
  const url = `${CLOB_BASE}/book?token_id=${tokenId}`;
  try {
    const { data, latencyMs } = await httpGetJson(url);
    return { book: data, latencyMs };
  } catch (e) {
    return { book: null, latencyMs: -1, error: e.message };
  }
}

// ── Book summary helpers ────────────────────────────────────────
export function bookSummary(book) {
  if (!book || !book.bids || !book.asks) {
    return { bid: 'UNAVAILABLE', ask: 'UNAVAILABLE', midpoint: 'UNAVAILABLE', spread: 'UNAVAILABLE', depthNotionalNearMid: 'UNAVAILABLE' };
  }
  const bids = book.bids.map(l => ({ price: Number(l.price), size: Number(l.size) })).sort((a, b) => b.price - a.price);
  const asks = book.asks.map(l => ({ price: Number(l.price), size: Number(l.size) })).sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 1;
  const midpoint = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  // Depth: sum notional within 5c of mid
  let depthBid = 0, depthAsk = 0;
  for (const l of bids) { if (l.price >= midpoint - 0.05) depthBid += l.price * l.size; }
  for (const l of asks) { if (l.price <= midpoint + 0.05) depthAsk += l.price * l.size; }

  return {
    bid: bestBid,
    ask: bestAsk,
    midpoint: +midpoint.toFixed(4),
    spread: +spread.toFixed(4),
    depthNotionalNearMid: +((depthBid + depthAsk).toFixed(2)),
  };
}

// ── Build universe entry for one anchor ─────────────────────────
async function buildUniverseEntry(anchor) {
  const entry = {
    asset: anchor.asset,
    eventSlug: anchor.slug,
    eventUrl: anchor.url,
    marketId: 'UNAVAILABLE',
    conditionId: 'UNAVAILABLE',
    yesTokenId: 'UNAVAILABLE',
    noTokenId: 'UNAVAILABLE',
    outcomeTokenIds: [],
    question: 'UNAVAILABLE',
    startTimestamp: 'UNAVAILABLE',
    endTimestamp: 'UNAVAILABLE',
    windowMinutes: 15,
    rulesRaw: 'UNAVAILABLE',
    rulesParsed: { type: 'crypto-15m-updown', asset: anchor.asset, windowMinutes: 15 },
    enableOrderBook: 'UNAVAILABLE',
    resolvedAt: new Date().toISOString(),
    bookSummary: { yes: null, no: null },
  };

  const result = await resolveEventBySlug(anchor.slug);

  if (result && result.event) {
    const ev = result.event;
    entry.marketId = ev.id || ev.market_id || 'UNAVAILABLE';
    entry.conditionId = ev.condition_id || 'UNAVAILABLE';
    entry.question = ev.title || ev.question || 'UNAVAILABLE';
    entry.enableOrderBook = ev.enable_order_book ?? ev.enableOrderBook ?? 'UNAVAILABLE';
    entry.rulesRaw = ev.description || ev.rules || 'UNAVAILABLE';
    entry.startTimestamp = ev.start_date || ev.startDate || 'UNAVAILABLE';
    entry.endTimestamp = ev.end_date || ev.endDate || 'UNAVAILABLE';

    // Extract token IDs from event markets
    const markets = ev.markets || [];
    for (const mkt of markets) {
      const tokens = mkt.tokens || mkt.clobTokenIds || [];
      if (Array.isArray(tokens)) {
        for (const tok of tokens) {
          const tid = typeof tok === 'string' ? tok : tok.token_id;
          const outcome = typeof tok === 'object' ? tok.outcome : null;
          if (tid) {
            entry.outcomeTokenIds.push({ tokenId: tid, outcome: outcome || 'UNAVAILABLE', marketQuestion: mkt.question || mkt.groupItemTitle || 'UNAVAILABLE' });
            if (outcome === 'Yes' || outcome === 'YES') entry.yesTokenId = tid;
            if (outcome === 'No' || outcome === 'NO') entry.noTokenId = tid;
          }
        }
      }
    }
  } else if (result && result.fromMarketSearch && result.markets) {
    // Came from /markets search - build from market objects
    for (const mkt of result.markets) {
      entry.marketId = entry.marketId === 'UNAVAILABLE' ? mkt.id || mkt.condition_id : entry.marketId;
      entry.conditionId = mkt.condition_id || entry.conditionId;
      entry.question = mkt.question || entry.question;
      entry.enableOrderBook = mkt.enable_order_book ?? mkt.enableOrderBook ?? entry.enableOrderBook;
      entry.rulesRaw = mkt.description || entry.rulesRaw;
      entry.startTimestamp = mkt.start_date || mkt.startDate || entry.startTimestamp;
      entry.endTimestamp = mkt.end_date || mkt.endDate || mkt.end_date_iso || entry.endTimestamp;

      const tokens = mkt.tokens || [];
      for (const tok of tokens) {
        const tid = tok.token_id || tok;
        const outcome = tok.outcome || 'UNAVAILABLE';
        if (tid) {
          entry.outcomeTokenIds.push({ tokenId: tid, outcome, marketQuestion: mkt.question || 'UNAVAILABLE' });
          if (outcome === 'Yes') entry.yesTokenId = tid;
          if (outcome === 'No') entry.noTokenId = tid;
        }
      }

      // Also check clobTokenIds string field
      if (typeof mkt.clobTokenIds === 'string' && mkt.clobTokenIds.includes(',')) {
        const ids = mkt.clobTokenIds.split(',').map(s => s.trim()).filter(Boolean);
        const outcomes = Array.isArray(mkt.outcomes) ? (typeof mkt.outcomes[0] === 'string' ? mkt.outcomes : JSON.parse(mkt.outcomes)) : ['Yes', 'No'];
        for (let i = 0; i < ids.length; i++) {
          const existing = entry.outcomeTokenIds.find(t => t.tokenId === ids[i]);
          if (!existing) {
            entry.outcomeTokenIds.push({ tokenId: ids[i], outcome: outcomes[i] || 'UNAVAILABLE', marketQuestion: mkt.question || 'UNAVAILABLE' });
          }
          if ((outcomes[i] || '').toLowerCase() === 'yes') entry.yesTokenId = ids[i];
          if ((outcomes[i] || '').toLowerCase() === 'no') entry.noTokenId = ids[i];
        }
      }
    }
  }

  // Derive timestamps from slug if not resolved (epoch in slug name)
  if (entry.startTimestamp === 'UNAVAILABLE') {
    const epochMatch = anchor.slug.match(/(\d{10})$/);
    if (epochMatch) {
      const epoch = parseInt(epochMatch[1]) * 1000;
      entry.startTimestamp = new Date(epoch).toISOString();
      entry.endTimestamp = new Date(epoch + 15 * 60 * 1000).toISOString();
    }
  }

  // Fetch order books for discovered tokens
  const tokensToFetch = entry.outcomeTokenIds.slice(0, 4); // cap to avoid hammering
  for (const tok of tokensToFetch) {
    const { book, latencyMs } = await fetchBook(tok.tokenId);
    const summary = bookSummary(book);
    tok.bookSummary = summary;
    tok.bookLatencyMs = latencyMs;
  }

  return entry;
}

// ── Main: resolve all anchors and persist ───────────────────────
export async function resolveAndPersist() {
  console.log('[crypto15m] Resolving anchor markets...');
  const universe = [];

  for (const anchor of ANCHOR_EVENTS) {
    console.log(`  [${anchor.asset}] slug=${anchor.slug}`);
    try {
      const entry = await buildUniverseEntry(anchor);
      universe.push(entry);
      const tokenCount = entry.outcomeTokenIds.length;
      console.log(`    → ${tokenCount} tokens found, marketId=${entry.marketId}`);
    } catch (e) {
      console.error(`    → ERROR: ${e.message}`);
      universe.push({
        asset: anchor.asset,
        eventSlug: anchor.slug,
        eventUrl: anchor.url,
        error: e.message,
        resolvedAt: new Date().toISOString(),
      });
    }
  }

  // Persist to zvi_state.json
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch { /* file doesn't exist yet */ }

  state.crypto15m = state.crypto15m || {};
  state.crypto15m.universe = universe;
  state.crypto15m.lastRefresh = new Date().toISOString();
  state.crypto15m.pollCadenceMs = 1000;
  state.crypto15m.anchorCount = ANCHOR_EVENTS.length;
  state.crypto15m.resolvedCount = universe.filter(u => u.marketId !== 'UNAVAILABLE').length;

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`[crypto15m] Persisted ${universe.length} entries to ${STATE_PATH}`);

  return { universe, state: state.crypto15m };
}

// ── Caps / Limits Report ────────────────────────────────────────
export function capsReport() {
  return {
    fetchMarkets_standalone: {
      location: 'standalone.mjs:760',
      description: 'targetLimit = max(store.settings.marketLimit || 200, 500) — fetches up to 500 markets per cycle (5 batches of 100)',
      settingKey: 'store.settings.marketLimit',
      default: 200,
      effectiveCap: 500,
    },
    fetchMarkets_standalone_maxBatches: {
      location: 'standalone.mjs:764',
      description: 'maxBatches = 5 — hard-coded cap of 5 pagination batches (5 × 100 = 500)',
    },
    fetchMarkets_standalone_settingsEndpoint: {
      location: 'standalone.mjs:4836',
      description: 'marketLimit clamped to [10, 5000] via /api/settings endpoint',
    },
    gammaApi_negrisk: {
      location: 'src/adapters/polymarket/gamma-api.ts:35',
      description: 'fetchNegRiskMarkets paginates with offset > 2000 safety break',
      effectiveCap: 2000,
    },
    tierSlice: {
      location: 'standalone.mjs:796',
      description: 'Tier arrays sliced to 200 each (A/B/C)',
      effectiveCap: '200 per tier',
    },
  };
}

// ── CLI entrypoint ──────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  resolveAndPersist()
    .then(({ universe }) => {
      console.log('\n═══ Universe Summary ═══');
      for (const u of universe) {
        console.log(`${u.asset}: marketId=${u.marketId}, tokens=${(u.outcomeTokenIds || []).length}, start=${u.startTimestamp}`);
      }
      console.log('\n═══ Caps/Limits in fetchMarkets ═══');
      const caps = capsReport();
      for (const [k, v] of Object.entries(caps)) {
        console.log(`  ${k}: ${v.description} [${v.location}]`);
      }
    })
    .catch(e => { console.error('Fatal:', e); process.exit(1); });
}
