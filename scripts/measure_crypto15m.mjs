#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// ZVI v1 — Crypto 15-min Measurement Rig
// Polls CLOB orderbooks for anchor crypto15m markets.
// Writes timestamped CSV + optional JSONL to ./data/measurements/
//
// Usage:
//   node scripts/measure_crypto15m.mjs [--interval 1000] [--duration 3600000] [--format csv]
//
// npm script:
//   npm run measure:crypto15m
// ═══════════════════════════════════════════════════════════════

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

// ── .env.local loader ───────────────────────────────────────────
const BASE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENV_PATH = path.join(BASE_DIR, '.env.local');

function loadEnv() {
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* no .env.local */ }
}
loadEnv();

const CLOB_BASE = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
const STATE_PATH = path.join(BASE_DIR, 'zvi_state.json');
const DATA_DIR = path.join(BASE_DIR, 'data', 'measurements');

// ── CLI Args ────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(flag, def) {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
}

const INTERVAL_MS = parseInt(argVal('--interval', '1000'));
const DURATION_MS = parseInt(argVal('--duration', '3600000')); // 1 hour
const FORMAT = argVal('--format', 'csv'); // csv or jsonl

// ── HTTP helper ─────────────────────────────────────────────────
function httpGetJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ data: JSON.parse(body), latencyMs }); }
          catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Load token universe from state ──────────────────────────────
function loadTokens() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    const universe = state.crypto15m?.universe || [];
    const tokens = [];
    for (const entry of universe) {
      for (const tok of (entry.outcomeTokenIds || [])) {
        tokens.push({
          asset: entry.asset,
          eventSlug: entry.eventSlug,
          tokenId: tok.tokenId,
          outcome: tok.outcome,
          marketQuestion: tok.marketQuestion || entry.question || 'UNAVAILABLE',
        });
      }
      // Fallback: if no outcomeTokenIds, use yesTokenId / noTokenId
      if ((entry.outcomeTokenIds || []).length === 0) {
        if (entry.yesTokenId && entry.yesTokenId !== 'UNAVAILABLE') {
          tokens.push({ asset: entry.asset, eventSlug: entry.eventSlug, tokenId: entry.yesTokenId, outcome: 'Yes', marketQuestion: entry.question || 'UNAVAILABLE' });
        }
        if (entry.noTokenId && entry.noTokenId !== 'UNAVAILABLE') {
          tokens.push({ asset: entry.asset, eventSlug: entry.eventSlug, tokenId: entry.noTokenId, outcome: 'No', marketQuestion: entry.question || 'UNAVAILABLE' });
        }
      }
    }
    return { tokens, universe };
  } catch (e) {
    console.error(`[measure] Cannot load state from ${STATE_PATH}: ${e.message}`);
    console.error('[measure] Run the adapter first: node src/adapters/polymarket/crypto15m-adapter.mjs');
    process.exit(1);
  }
}

// ── Book parsing ────────────────────────────────────────────────
function parseBook(book) {
  if (!book || !book.bids || !book.asks) {
    return { bid: null, ask: null, midpoint: null, spread: null, depthNotionalNearMid: null };
  }
  const bids = book.bids.map(l => ({ p: Number(l.price), s: Number(l.size) })).sort((a, b) => b.p - a.p);
  const asks = book.asks.map(l => ({ p: Number(l.price), s: Number(l.size) })).sort((a, b) => a.p - b.p);

  const bid = bids[0]?.p ?? null;
  const ask = asks[0]?.p ?? null;
  const midpoint = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  const spread = bid !== null && ask !== null ? ask - bid : null;

  let depth = 0;
  if (midpoint !== null) {
    for (const l of bids) { if (l.p >= midpoint - 0.05) depth += l.p * l.s; }
    for (const l of asks) { if (l.p <= midpoint + 0.05) depth += l.p * l.s; }
  }

  return { bid, ask, midpoint, spread, depthNotionalNearMid: +depth.toFixed(2) };
}

// ── Output setup ────────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(DATA_DIR, `crypto15m_${timestamp}.${FORMAT}`);
const outStream = fs.createWriteStream(outFile, { flags: 'a' });

if (FORMAT === 'csv') {
  outStream.write('ts,asset,eventSlug,tokenId,outcome,bid,ask,midpoint,spread,depthNotionalNearMid,httpLatencyMs\n');
}

console.log(`[measure] Output: ${outFile}`);
console.log(`[measure] Interval: ${INTERVAL_MS}ms | Duration: ${DURATION_MS}ms | Format: ${FORMAT}`);

// ── Main polling loop ───────────────────────────────────────────
const { tokens, universe } = loadTokens();

if (tokens.length === 0) {
  console.error('[measure] No tokens found in state. Run the adapter first.');
  console.error('  node src/adapters/polymarket/crypto15m-adapter.mjs');
  process.exit(1);
}

console.log(`[measure] Tracking ${tokens.length} tokens across ${universe.length} markets`);
for (const t of tokens) {
  console.log(`  ${t.asset} | ${t.outcome} | ${t.tokenId.slice(0, 16)}...`);
}
console.log('');

let sampleCount = 0;
const startTime = Date.now();

async function pollOnce() {
  const ts = new Date().toISOString();
  for (const tok of tokens) {
    try {
      const { data: book, latencyMs } = await httpGetJson(`${CLOB_BASE}/book?token_id=${tok.tokenId}`);
      const { bid, ask, midpoint, spread, depthNotionalNearMid } = parseBook(book);

      if (FORMAT === 'csv') {
        outStream.write(`${ts},${tok.asset},${tok.eventSlug},${tok.tokenId},${tok.outcome},${bid ?? 'UNAVAILABLE'},${ask ?? 'UNAVAILABLE'},${midpoint ?? 'UNAVAILABLE'},${spread ?? 'UNAVAILABLE'},${depthNotionalNearMid ?? 'UNAVAILABLE'},${latencyMs}\n`);
      } else {
        outStream.write(JSON.stringify({
          ts, asset: tok.asset, eventSlug: tok.eventSlug, tokenId: tok.tokenId,
          outcome: tok.outcome, bid, ask, midpoint, spread, depthNotionalNearMid, httpLatencyMs: latencyMs,
        }) + '\n');
      }

      sampleCount++;
    } catch (e) {
      // Log error row
      if (FORMAT === 'csv') {
        outStream.write(`${ts},${tok.asset},${tok.eventSlug},${tok.tokenId},${tok.outcome},ERROR,ERROR,ERROR,ERROR,ERROR,-1\n`);
      } else {
        outStream.write(JSON.stringify({ ts, asset: tok.asset, tokenId: tok.tokenId, error: e.message }) + '\n');
      }
    }
  }

  const elapsed = Date.now() - startTime;
  const pct = ((elapsed / DURATION_MS) * 100).toFixed(1);
  process.stdout.write(`\r[measure] samples=${sampleCount} elapsed=${(elapsed / 1000).toFixed(0)}s (${pct}%)`);
}

// ── Binance spot price logger (optional, best-effort) ───────────
let binanceWs = null;
const binanceFile = path.join(DATA_DIR, `crypto15m_binance_${timestamp}.csv`);
let binanceStream = null;

function tryBinanceWs() {
  try {
    const symbols = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt'];
    const streams = symbols.map(s => `${s}@trade`).join('/');
    const wsUrl = `wss://stream.binance.com:9443/ws/${streams}`;

    binanceStream = fs.createWriteStream(binanceFile, { flags: 'a' });
    binanceStream.write('ts,symbol,price,qty\n');

    // Use dynamic import for ws if available
    import('ws').then(({ default: WS }) => {
      binanceWs = new WS(wsUrl);
      binanceWs.on('open', () => console.log('\n[binance] WebSocket connected for spot drift'));
      binanceWs.on('message', (raw) => {
        try {
          const d = JSON.parse(raw.toString());
          if (d.e === 'trade') {
            binanceStream.write(`${new Date(d.T).toISOString()},${d.s},${d.p},${d.q}\n`);
          }
        } catch { /* skip */ }
      });
      binanceWs.on('error', () => { /* swallow */ });
      binanceWs.on('close', () => { binanceWs = null; });
    }).catch(() => {
      console.log('\n[binance] ws package not installed — skipping spot drift. Install with: npm i ws');
    });
  } catch {
    console.log('\n[binance] WebSocket not available — skipping spot drift');
  }
}

// Start optional Binance feed
tryBinanceWs();

// ── Run loop ────────────────────────────────────────────────────
console.log(`[measure] Starting polling loop — ${DURATION_MS / 1000}s total...`);

const interval = setInterval(async () => {
  const elapsed = Date.now() - startTime;
  if (elapsed >= DURATION_MS) {
    clearInterval(interval);
    outStream.end();
    if (binanceWs) binanceWs.close();
    if (binanceStream) binanceStream.end();
    console.log(`\n\n[measure] Done. ${sampleCount} samples written to ${outFile}`);
    if (binanceStream) console.log(`[measure] Binance drift log: ${binanceFile}`);
    process.exit(0);
  }
  await pollOnce();
}, INTERVAL_MS);

// First poll immediately
pollOnce();
