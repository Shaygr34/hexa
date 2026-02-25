// spot-feed.mjs — Binance spot WebSocket price feed
// Maintains a 120s rolling buffer of (ts, price) per symbol.
// Auto-reconnects with exponential backoff on disconnect.
//
// Usage:
//   import { start, stop, getSnapshot, getFeatures } from './spot-feed.mjs';
//   await start();           // connects WS
//   const snap = getSnapshot('BTC');  // { prices: [{ts, price}, ...], connected }
//   const feat = getFeatures('BTC');  // { price, return_60s, vol_60s, ok }
//   stop();                  // clean shutdown

// We use Node's built-in WebSocket if available (Node 21+), fallback to 'ws' package
let WS;

const SYMBOLS_MAP = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};

const BUFFER_SECONDS = 120;
const STREAM_URL = 'wss://stream.binance.com:9443/stream';

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
const buffers = {};  // { BTC: [{ts, price}, ...], ... }
let ws = null;
let connected = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let lastMessageTs = 0;          // timestamp of last received message
let healthCheckTimer = null;
const HEALTH_CHECK_INTERVAL = 30_000;  // check every 30s
const STALE_THRESHOLD = 60_000;        // no data for 60s = stale

// ═══════════════════════════════════════════════════════════════
// INIT BUFFERS
// ═══════════════════════════════════════════════════════════════
for (const sym of Object.keys(SYMBOLS_MAP)) {
  buffers[sym] = [];
}

function trimBuffer(sym) {
  const cutoff = Date.now() - BUFFER_SECONDS * 1000;
  buffers[sym] = buffers[sym].filter(t => t.ts >= cutoff);
}

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════
async function resolveWS() {
  // Try native globalThis.WebSocket (Node 21+), else use 'ws' package
  if (typeof globalThis.WebSocket !== 'undefined') {
    return globalThis.WebSocket;
  }
  try {
    const mod = await import('ws');
    return mod.default || mod.WebSocket;
  } catch (_) {
    return null;
  }
}

function destroySocket() {
  if (ws) {
    try {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    } catch (_) {}
    ws = null;
  }
  connected = false;
}

async function connect() {
  if (!WS) {
    WS = await resolveWS();
    if (!WS) {
      console.error('[binance] No WebSocket implementation available. Install ws: npm i ws');
      return;
    }
  }

  // Force-cleanup any old socket before opening a new one
  destroySocket();

  const streams = Object.values(SYMBOLS_MAP).map(s => `${s}@trade`).join('/');
  const url = `${STREAM_URL}?streams=${streams}`;

  console.log(`[binance] connecting to ${Object.keys(SYMBOLS_MAP).join('/')}...`);

  ws = new WS(url);

  ws.onopen = () => {
    connected = true;
    reconnectDelay = 1000;
    lastMessageTs = Date.now();
    console.log('[binance] connected');
  };

  ws.onmessage = (event) => {
    try {
      lastMessageTs = Date.now();
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      const data = msg.data;
      if (!data || !data.s || !data.p) return;

      // Reverse lookup: BTCUSDT → BTC
      const sym = Object.entries(SYMBOLS_MAP).find(([, v]) => v === data.s.toLowerCase())?.[0];
      if (!sym) return;

      const tick = { ts: data.T || Date.now(), price: parseFloat(data.p) };
      buffers[sym].push(tick);
      trimBuffer(sym);
    } catch (_) {}
  };

  ws.onclose = () => {
    connected = false;
    ws = null;
    console.log(`[binance] disconnected, reconnecting in ${reconnectDelay}ms...`);
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[binance] ws error:', err.message || 'unknown');
    // onclose will fire after onerror
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    try { await connect(); } catch (e) {
      console.error('[binance] reconnect failed:', e.message || 'unknown');
      scheduleReconnect(); // retry on failure
    }
  }, reconnectDelay);
}

function startHealthCheck() {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(() => {
    const sinceLast = Date.now() - lastMessageTs;
    if (lastMessageTs > 0 && sinceLast > STALE_THRESHOLD) {
      console.warn(`[binance] stale connection: no data for ${(sinceLast / 1000).toFixed(0)}s, forcing reconnect`);
      destroySocket();
      reconnectDelay = 1000;
      scheduleReconnect();
    } else if (!connected && !reconnectTimer) {
      console.warn('[binance] health check: not connected and no reconnect scheduled, forcing reconnect');
      reconnectDelay = 1000;
      scheduleReconnect();
    }
  }, HEALTH_CHECK_INTERVAL);
}

function stopHealthCheck() {
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════
async function start() {
  await connect();
  // Wait up to 5s for connection + first ticks
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (connected && Object.values(buffers).some(b => b.length > 0)) break;
    await new Promise(r => setTimeout(r, 200));
  }
  startHealthCheck();
  const tickCounts = Object.entries(buffers).map(([k, v]) => `${k}:${v.length}`).join(' ');
  console.log(`[binance] ready (connected=${connected} ticks: ${tickCounts})`);
}

function stop() {
  stopHealthCheck();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  destroySocket();
  console.log('[binance] stopped');
}

function getSnapshot(sym) {
  trimBuffer(sym);
  return {
    prices: [...(buffers[sym] || [])],
    connected,
    count: (buffers[sym] || []).length,
  };
}

/**
 * Compute derived features for a symbol:
 * - price: latest price
 * - return_60s: (price_now / price_60s_ago) - 1
 * - vol_60s: stddev of 1s returns over last 60s
 * - ok: true if sufficient data
 */
function getFeatures(sym) {
  trimBuffer(sym);
  const buf = buffers[sym] || [];

  if (buf.length < 2) {
    return { price: null, return_60s: null, vol_60s: null, ok: false, reason: 'insufficient ticks' };
  }

  const now = Date.now();
  const latest = buf[buf.length - 1];

  // Find price ~60s ago
  const target60 = now - 60_000;
  let price60 = null;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].ts <= target60) {
      price60 = buf[i].price;
      break;
    }
  }

  if (price60 == null) {
    // Use oldest available if buffer < 60s
    price60 = buf[0].price;
  }

  const return_60s = (latest.price / price60) - 1;

  // Compute 1-second bucketed returns for volatility
  const bucketMs = 1000;
  const window60 = buf.filter(t => t.ts >= now - 60_000);

  // Group into 1s buckets, take last price per bucket
  const buckets = new Map();
  for (const t of window60) {
    const key = Math.floor(t.ts / bucketMs);
    buckets.set(key, t.price);
  }
  const bucketPrices = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);

  let vol_60s = 0;
  if (bucketPrices.length >= 2) {
    const returns = [];
    for (let i = 1; i < bucketPrices.length; i++) {
      returns.push(bucketPrices[i] / bucketPrices[i - 1] - 1);
    }
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    vol_60s = Math.sqrt(variance);
  }

  // Need at least 10 1s-buckets for a meaningful vol estimate
  const MIN_BUCKETS = 10;
  const dataOk = bucketPrices.length >= MIN_BUCKETS;

  return {
    price: latest.price,
    return_60s: parseFloat(return_60s.toFixed(8)),
    vol_60s: parseFloat(vol_60s.toFixed(8)),
    ok: dataOk,
    reason: dataOk ? null : `need ${MIN_BUCKETS} buckets, have ${bucketPrices.length}`,
    tickCount: buf.length,
    bucketCount: bucketPrices.length,
  };
}

function isConnected() { return connected; }

export { start, stop, getSnapshot, getFeatures, isConnected, SYMBOLS_MAP };
