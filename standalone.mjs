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

// ─── Activity Log ────────────────────────────────────────────────────────────
const activityLog = [];
const STARTUP_TIME = Date.now();

function logActivity(type, message, details = {}) {
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type, // 'system' | 'trade' | 'config' | 'scan' | 'error' | 'decision'
    message,
    details,
  };
  activityLog.unshift(entry);
  if (activityLog.length > 1000) activityLog.pop();
  console.log('[' + type + '] ' + message);
  return entry;
}

logActivity('system', 'ZVI v1 starting up');

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
  totalScans: 0,
  totalMarketsScanned: 0,
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
  // ── Configurable settings (editable from UI) ──
  settings: {
    marketLimit: 200,
    refreshInterval: 30,
    scanMode: 'volume',         // 'volume' | 'newest' | 'ending-soon'
    minEdgeDisplay: 0,          // show all markets by default
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
    // ── Configurable limit — NO hard cap. Default 200, configurable from UI ──
    const limit = state.settings.marketLimit || 200;
    const orderBy = state.settings.scanMode === 'newest' ? 'startDate'
      : state.settings.scanMode === 'ending-soon' ? 'endDate'
      : 'volume24hr';
    const ascending = state.settings.scanMode === 'ending-soon' ? 'true' : 'false';

    // Fetch multiple pages if limit > 100 (Gamma API max per page)
    let allMarkets = [];
    let offset = 0;
    const pageSize = Math.min(limit, 100);

    while (allMarkets.length < limit) {
      const url = `${GAMMA_BASE}/markets?closed=false&limit=${pageSize}&offset=${offset}&order=${orderBy}&ascending=${ascending}`;
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'ZVI-FundOS/1.0' },
        signal: AbortSignal.timeout(8000),
      });

      if (!resp.ok) throw new Error(`Gamma API ${resp.status}: ${resp.statusText}`);
      const page = await resp.json();
      if (!Array.isArray(page) || page.length === 0) break;
      allMarkets = allMarkets.concat(page);
      offset += page.length;
      if (page.length < pageSize) break; // no more pages
    }

    const opportunities = [];

    for (const m of allMarkets) {
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

      // ── Fix Polymarket links — use correct slug-based URL ──
      // Gamma API returns slugs that map to polymarket.com/event/{slug}
      // If slug is missing, fall back to condition ID search
      const slug = m.slug || '';
      let link;
      if (slug) {
        link = `https://polymarket.com/event/${slug}`;
      } else if (m.conditionId) {
        link = `https://polymarket.com/markets?tid=${m.conditionId}`;
      } else {
        link = `https://polymarket.com`;
      }

      // Parse end date for time-to-expiry info
      const endDate = m.endDate || m.endDateIso || null;
      const daysToExpiry = endDate ? Math.max(0, Math.round((new Date(endDate) - now) / 86400000)) : null;

      opportunities.push({
        id: m.id || m.conditionId || crypto.randomUUID(),
        market: m.question || m.title || 'Unknown Market',
        description: m.description || '',
        edge: parseFloat((edge * 100).toFixed(3)),
        bestBid: parseFloat(bestBid.toFixed(4)),
        bestAsk: parseFloat(bestAsk.toFixed(4)),
        priceSum: parseFloat(sum.toFixed(4)),
        outcomes: m.outcomes ? (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes) : ['Yes', 'No'],
        volume: Math.round(volume),
        liquidity: Math.round(liquidity),
        confidence: parseFloat(confidence.toFixed(1)),
        link,
        slug,
        negRisk: !!m.negRisk,
        conditionId: m.conditionId || '',
        endDate,
        daysToExpiry,
        updatedAt: m.updatedAt || new Date().toISOString(),
      });
    }

    // Sort by edge descending
    opportunities.sort((a, b) => b.edge - a.edge);

    state.opportunityCache = { data: opportunities, fetchedAt: now, ttl: 15000 };
    state.agentHeartbeats.scanner.lastSeen = now;
    state.agentHeartbeats.scanner.status = 'running';
    state.totalScans++;
    state.totalMarketsScanned += allMarkets.length;

    logActivity('scan', `Scanned ${allMarkets.length} markets, found ${opportunities.filter(o => o.edge > 0.5).length} with edge > 0.5%`);

    return opportunities;
  } catch (err) {
    console.error('[gamma] Fetch error:', err.message, '— loading demo data');
    logActivity('error', 'Gamma API fetch failed: ' + err.message);
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
      description: 'Demo market — connect Polymarket API for live data',
      edge: parseFloat((edge * 100).toFixed(3)),
      bestBid: m.yes,
      bestAsk: m.no,
      priceSum: parseFloat(sum.toFixed(4)),
      outcomes: ['Yes', 'No'],
      volume: m.vol,
      liquidity: m.liq,
      confidence: parseFloat(confidence.toFixed(1)),
      link: 'https://polymarket.com',
      slug: '',
      negRisk: m.negRisk,
      conditionId: 'demo-' + i,
      endDate: null,
      daysToExpiry: null,
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

// ─── System Status ───────────────────────────────────────────────────────────
function getSystemStatus() {
  const cfg = getConfig();
  const uptime = Math.round((Date.now() - STARTUP_TIME) / 1000);
  const cacheAge = state.opportunityCache.fetchedAt > 0
    ? Math.round((Date.now() - state.opportunityCache.fetchedAt) / 1000) : -1;

  return {
    uptime,
    uptimeFormatted: uptime > 3600 ? Math.floor(uptime/3600) + 'h ' + Math.floor((uptime%3600)/60) + 'm'
      : uptime > 60 ? Math.floor(uptime/60) + 'm ' + (uptime%60) + 's'
      : uptime + 's',
    mode: cfg.mode,
    totalScans: state.totalScans,
    totalMarketsScanned: state.totalMarketsScanned,
    marketsInCache: state.opportunityCache.data.length,
    cacheAge,
    dataSource: state.agentHeartbeats.scanner.status === 'demo' ? 'demo' : 'live',
    secrets: cfg.secrets,
    riskLimits: cfg.riskLimits,
    settings: state.settings,
    founder: {
      capitalAllocated: state.founder.capitalAllocated,
      fundSize: state.founder.fundSize,
      risksApproved: state.founder.risksApproved,
      capitalDeployed: state.founder.capitalDeployed,
      totalDecisions: Object.keys(state.founder.decisions).length,
      buys: Object.values(state.founder.decisions).filter(d => d.verdict === 'BUY').length,
      passes: Object.values(state.founder.decisions).filter(d => d.verdict === 'PASS').length,
    },
    agents: state.agentHeartbeats,
    activityCount: activityLog.length,
  };
}

// ─── .env.local updater (for UI-based API key config) ────────────────────────
function updateEnvFile(updates) {
  // updates is { KEY: 'value', KEY2: 'value2', ... }
  // Only allow known safe keys
  const ALLOWED_KEYS = new Set([
    'POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE',
    'POLYMARKET_PRIVATE_KEY', 'POLYMARKET_GAMMA_URL', 'POLYMARKET_CLOB_URL',
    'POLYGON_RPC_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY',
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'WEBHOOK_URL',
    'MAX_EXPOSURE_PER_MARKET', 'DAILY_MAX_EXPOSURE', 'MIN_EDGE_THRESHOLD', 'MIN_DEPTH_USDC',
    'OBSERVATION_ONLY', 'MANUAL_APPROVAL_REQUIRED', 'AUTO_EXEC', 'KILL_SWITCH',
  ]);

  const filteredUpdates = {};
  for (const [key, val] of Object.entries(updates)) {
    if (ALLOWED_KEYS.has(key)) filteredUpdates[key] = val;
  }

  if (Object.keys(filteredUpdates).length === 0) return { ok: false, error: 'No valid keys to update' };

  try {
    let content = '';
    try { content = fs.readFileSync(ENV_PATH, 'utf-8'); } catch { content = ''; }

    for (const [key, val] of Object.entries(filteredUpdates)) {
      const regex = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=.*$', 'm');
      if (regex.test(content)) {
        content = content.replace(regex, key + '=' + val);
      } else {
        content += '\n' + key + '=' + val;
      }
      // Also update process.env immediately
      process.env[key] = val;
    }

    fs.writeFileSync(ENV_PATH, content, 'utf-8');
    logActivity('config', 'Updated .env.local: ' + Object.keys(filteredUpdates).join(', '));
    return { ok: true, updated: Object.keys(filteredUpdates) };
  } catch (err) {
    logActivity('error', 'Failed to update .env.local: ' + err.message);
    return { ok: false, error: err.message };
  }
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

  /* ── Search Bar ── */
  .search-bar {
    display: flex;
    gap: 10px;
    margin-bottom: 16px;
    align-items: center;
    flex-wrap: wrap;
  }
  .search-bar input {
    flex: 1;
    min-width: 200px;
    padding: 8px 14px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s;
  }
  .search-bar input:focus { border-color: var(--accent-cyan); }
  .search-bar select {
    padding: 8px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 11px;
    outline: none;
    appearance: none;
    cursor: pointer;
  }
  .search-bar .result-count {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }

  /* ── Modal / Drawer ── */
  .modal-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7);
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.15s;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: 90%;
    max-width: 700px;
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }
  .modal-header h2 {
    font-size: 16px;
    font-weight: 700;
  }
  .modal-close {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    width: 28px;
    height: 28px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }
  .modal-close:hover { border-color: var(--accent-red); color: var(--accent-red); }
  .modal-body { padding: 20px; }
  .modal-footer {
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  /* ── Settings ── */
  .settings-section {
    margin-bottom: 24px;
  }
  .settings-section h3 {
    font-size: 13px;
    font-weight: 700;
    color: var(--accent-cyan);
    margin-bottom: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-family: var(--font-mono);
  }
  .settings-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 10px;
  }
  .setting-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .setting-item label {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .setting-item .setting-desc {
    font-size: 10px;
    color: var(--text-muted);
    margin-bottom: 4px;
  }
  .setting-item input, .setting-item select {
    padding: 7px 10px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s;
  }
  .setting-item input:focus { border-color: var(--accent-cyan); }
  .setting-status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-family: var(--font-mono);
    padding: 2px 6px;
    border-radius: 3px;
  }
  .setting-status.connected { background: rgba(34,197,94,0.1); color: var(--accent-green); }
  .setting-status.missing { background: rgba(239,68,68,0.1); color: var(--accent-red); }

  /* ── Explain Hub ── */
  .hub-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  @media (max-width: 900px) { .hub-grid { grid-template-columns: 1fr; } }
  .hub-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
    position: relative;
    overflow: hidden;
  }
  .hub-card.full-width { grid-column: 1 / -1; }
  .hub-card h3 {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--accent-blue);
    font-family: var(--font-mono);
    margin-bottom: 12px;
  }
  .hub-card p {
    font-size: 13px;
    line-height: 1.7;
    color: var(--text-secondary);
    margin-bottom: 8px;
  }
  .hub-status-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 8px;
  }
  .hub-stat {
    padding: 10px;
    background: rgba(0,0,0,0.2);
    border-radius: 6px;
  }
  .hub-stat .hs-label {
    font-size: 10px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    text-transform: uppercase;
  }
  .hub-stat .hs-val {
    font-size: 18px;
    font-weight: 700;
    font-family: var(--font-mono);
  }

  /* ── Activity Feed ── */
  .activity-feed {
    max-height: 400px;
    overflow-y: auto;
  }
  .activity-entry {
    display: flex;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid rgba(42,53,85,0.3);
    font-size: 12px;
    align-items: flex-start;
  }
  .activity-entry:last-child { border-bottom: none; }
  .activity-time {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
    min-width: 60px;
  }
  .activity-type {
    font-family: var(--font-mono);
    font-size: 9px;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    min-width: 55px;
    text-align: center;
  }
  .at-system { background: rgba(99,102,241,0.15); color: var(--accent-blue); }
  .at-scan { background: rgba(6,182,212,0.15); color: var(--accent-cyan); }
  .at-config { background: rgba(245,158,11,0.15); color: var(--accent-yellow); }
  .at-trade { background: rgba(34,197,94,0.15); color: var(--accent-green); }
  .at-decision { background: rgba(139,92,246,0.15); color: var(--accent-purple); }
  .at-error { background: rgba(239,68,68,0.15); color: var(--accent-red); }
  .activity-msg { color: var(--text-secondary); }

  /* ── Glossary ── */
  .glossary-item {
    padding: 10px;
    margin-bottom: 6px;
    background: rgba(0,0,0,0.15);
    border-radius: 6px;
    border-left: 3px solid var(--accent-blue);
  }
  .glossary-item .gi-term {
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 12px;
    color: var(--accent-cyan);
    margin-bottom: 3px;
  }
  .glossary-item .gi-def {
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  /* ── Roadmap ── */
  .roadmap-phase {
    padding: 12px;
    margin-bottom: 8px;
    background: rgba(0,0,0,0.15);
    border-radius: 8px;
    border-left: 3px solid var(--border);
  }
  .roadmap-phase.active { border-left-color: var(--accent-green); background: rgba(34,197,94,0.04); }
  .roadmap-phase.next { border-left-color: var(--accent-blue); }
  .roadmap-phase.future { opacity: 0.6; }
  .rp-title {
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .rp-desc {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .rp-tag {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 9px;
    font-family: var(--font-mono);
    font-weight: 700;
    margin-right: 6px;
  }
  .rp-tag.current { background: rgba(34,197,94,0.2); color: var(--accent-green); }
  .rp-tag.upcoming { background: rgba(99,102,241,0.2); color: var(--accent-blue); }
  .rp-tag.planned { background: rgba(90,90,114,0.2); color: var(--text-muted); }

  /* ── Interactive Action Queue (expanded) ── */
  .aq-step { cursor: pointer; }
  .aq-step:hover:not(.step-locked) { border-color: var(--accent-cyan); }
  .aq-step-expanded {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }
  .aq-input-row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    align-items: center;
  }
  .aq-input-row input {
    flex: 1;
    padding: 5px 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 11px;
    outline: none;
  }
  .aq-input-row input:focus { border-color: var(--accent-cyan); }
  .aq-input-row label {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--text-muted);
    text-transform: uppercase;
    min-width: 50px;
  }

  /* ── Market Detail Modal ── */
  .md-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin: 12px 0;
  }
  .md-stat {
    padding: 10px;
    background: rgba(0,0,0,0.2);
    border-radius: 6px;
  }
  .md-stat .ms-label {
    font-size: 10px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    text-transform: uppercase;
  }
  .md-stat .ms-val {
    font-size: 16px;
    font-weight: 700;
    font-family: var(--font-mono);
  }
  .md-desc {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.6;
    padding: 12px;
    background: rgba(0,0,0,0.15);
    border-radius: 6px;
    margin: 10px 0;
  }
  .md-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    background: rgba(99,102,241,0.1);
    border: 1px solid rgba(99,102,241,0.3);
    border-radius: 6px;
    color: var(--accent-blue);
    text-decoration: none;
    font-family: var(--font-mono);
    font-size: 12px;
    transition: all 0.15s;
  }
  .md-link:hover { background: rgba(99,102,241,0.2); border-color: var(--accent-blue); }

  /* ── Clickable market rows ── */
  tbody tr { cursor: pointer; }
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
    <div class="tab" data-tab="hub">Explain Hub</div>
    <div class="tab" data-tab="settings">Settings</div>
    <div class="tab" data-tab="health">Agent Health</div>
  </div>

  <!-- ── Content ── -->
  <div class="content">

    <!-- Opportunities Panel -->
    <div class="panel active" id="panel-opportunities">
      <div class="fund-bar" id="fundBar" style="display:none"></div>
      <div class="summary-strip" id="oppSummary"></div>
      <div class="search-bar">
        <input type="text" id="marketSearch" placeholder="Search markets... (e.g. Bitcoin, Trump, Fed)" oninput="filterAndRender()">
        <select id="edgeFilter" onchange="filterAndRender()">
          <option value="0">All Edges</option>
          <option value="0.5">Edge > 0.5%</option>
          <option value="1">Edge > 1%</option>
          <option value="2">Edge > 2%</option>
          <option value="5">Edge > 5%</option>
        </select>
        <select id="sortMode" onchange="filterAndRender()">
          <option value="edge">Sort: Edge</option>
          <option value="volume">Sort: Volume</option>
          <option value="confidence">Sort: Confidence</option>
          <option value="liquidity">Sort: Liquidity</option>
        </select>
        <span class="result-count" id="resultCount"></span>
      </div>
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

    <!-- Explain Hub Panel -->
    <div class="panel" id="panel-hub">
      <div class="hub-grid" id="hubGrid"></div>
    </div>

    <!-- Settings Panel -->
    <div class="panel" id="panel-settings">
      <div id="settingsContent"></div>
    </div>

    <!-- Agent Health Panel -->
    <div class="panel" id="panel-health">
      <h3 style="margin-bottom: 16px; font-size: 16px;">Agent Health Monitor</h3>
      <div class="health-grid" id="healthGrid"></div>
    </div>
  </div>

  <!-- Market Detail Modal -->
  <div id="marketModal"></div>

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

    // Summary — always from full dataset
    const totalVol = opportunities.reduce((a, o) => a + o.volume, 0);
    const avgEdge = opportunities.length > 0
      ? opportunities.reduce((a, o) => a + o.edge, 0) / opportunities.length
      : 0;
    const maxEdge = opportunities.length > 0 ? Math.max(...opportunities.map(o => o.edge)) : 0;
    const negRiskCount = opportunities.filter(o => o.negRisk).length;
    const liveCount = opportunities.filter(o => !o.demo).length;
    const demoCount = opportunities.filter(o => o.demo).length;

    document.getElementById('oppSummary').innerHTML = [
      { label: 'Markets Scanned', value: opportunities.length, cls: 'blue', sub: liveCount > 0 ? liveCount + ' live' : demoCount + ' demo' },
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

    // Apply search/filter
    const filtered = getFilteredOpportunities();
    const rcEl = document.getElementById('resultCount');
    if (rcEl) rcEl.textContent = filtered.length + ' of ' + opportunities.length + ' markets';

    if (filtered.length === 0) {
      document.getElementById('oppTableBody').innerHTML =
        '<div class="empty-state"><div class="empty-icon">~</div><p>No opportunities match your filters</p></div>';
      return;
    }

    let html = '<table><thead><tr>' +
      '<th>#</th>' +
      '<th>Market</th>' +
      '<th>Edge %</th>' +
      '<th>Yes / No</th>' +
      '<th>Volume 24h</th>' +
      '<th>Liquidity</th>' +
      '<th>Confidence</th>' +
      '<th>Verdict</th>' +
      '<th>Pin</th>' +
      '</tr></thead><tbody>';

    filtered.forEach((o, i) => {
      const edgeClass = o.edge >= 2 ? 'edge-high' : o.edge >= 1 ? 'edge-mid' : 'edge-low';
      const confColor = o.confidence >= 60 ? 'var(--accent-green)'
        : o.confidence >= 30 ? 'var(--accent-yellow)' : 'var(--text-muted)';
      const isPinned = pinnedMarkets.has(o.id);
      const expiryTag = o.daysToExpiry !== null && o.daysToExpiry !== undefined
        ? ' <span style="font-size:9px;color:var(--text-muted);font-family:var(--font-mono)">' + o.daysToExpiry + 'd</span>' : '';

      html += '<tr onclick="showMarketDetail(' + i + ')" title="Click for details">' +
        '<td class="price-cell">' + (i + 1) + '</td>' +
        '<td class="market-name">' + esc(o.market) +
          (o.negRisk ? '<span class="negrisk-tag">NegRisk</span>' : '') +
          expiryTag +
          (o.demo ? '<span style="font-size:9px;color:var(--accent-yellow);margin-left:4px;font-family:var(--font-mono)">[demo]</span>' : '') +
        '</td>' +
        '<td class="edge-cell ' + edgeClass + '">' + o.edge.toFixed(2) + '%</td>' +
        '<td class="price-cell">' + o.bestBid.toFixed(2) + ' / ' + o.bestAsk.toFixed(2) + '</td>' +
        '<td class="volume-cell">$' + fmt(o.volume) + '</td>' +
        '<td class="volume-cell">$' + fmt(o.liquidity) + '</td>' +
        '<td><div class="confidence-bar">' +
          '<div class="confidence-track"><div class="confidence-fill" style="width:' + o.confidence + '%;background:' + confColor + '"></div></div>' +
          '<span class="confidence-val">' + o.confidence.toFixed(0) + '</span>' +
        '</div></td>' +
        '<td onclick="event.stopPropagation()">' + renderVerdictCell(o) + '</td>' +
        '<td onclick="event.stopPropagation()"><button class="pin-btn' + (isPinned ? ' pinned' : '') + '" onclick="togglePin(\\'' + o.id + '\\')">' + (isPinned ? 'Unpin' : 'Pin') + '</button></td>' +
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

  var expandedStep = null;

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
      else if (b.status === 'ready') statusIcon = '[GO]';

      // ── Interactive action forms for each blocker ──
      var actionHtml = '';
      var isExpanded = expandedStep === b.id;

      if (b.status !== 'done' && b.status !== 'locked') {
        if (b.id === 'api-keys') {
          // API key blocker: show input fields inline
          if (isExpanded) {
            actionHtml = '<div class="aq-step-expanded">' +
              '<div class="aq-input-row"><label>API Key</label><input type="password" id="aq_api_key" placeholder="Polymarket API Key"></div>' +
              '<div class="aq-input-row"><label>Secret</label><input type="password" id="aq_api_secret" placeholder="API Secret"></div>' +
              '<div class="aq-input-row"><label>Pass</label><input type="password" id="aq_api_pass" placeholder="Passphrase"></div>' +
              '<div style="margin-top:8px;display:flex;gap:6px">' +
                '<button class="btn btn-primary" style="font-size:10px" onclick="event.stopPropagation();saveAqApiKeys()">Save Keys</button>' +
                '<button class="btn" style="font-size:10px" onclick="event.stopPropagation();switchToTab(\\'settings\\')">Full Settings</button>' +
              '</div>' +
            '</div>';
          } else if (b.missing && b.missing.length > 0) {
            actionHtml = '<div class="aq-missing">Missing: ' + b.missing.join(', ') + '</div>' +
              '<div style="margin-top:4px;font-size:9px;color:var(--accent-cyan);font-family:var(--font-mono)">Click to configure</div>';
          }
        } else if (b.id === 'wallet') {
          if (isExpanded) {
            actionHtml = '<div class="aq-step-expanded">' +
              '<div class="aq-input-row"><label>Key</label><input type="password" id="aq_wallet_key" placeholder="Polygon wallet private key"></div>' +
              '<div style="margin-top:8px">' +
                '<button class="btn btn-primary" style="font-size:10px" onclick="event.stopPropagation();saveAqWalletKey()">Save Wallet Key</button>' +
              '</div>' +
            '</div>';
          } else if (b.missing && b.missing.length > 0) {
            actionHtml = '<div class="aq-missing">Missing: ' + b.missing.join(', ') + '</div>' +
              '<div style="margin-top:4px;font-size:9px;color:var(--accent-cyan);font-family:var(--font-mono)">Click to configure</div>';
          }
        } else if (b.id === 'capital') {
          actionHtml =
            '<div class="aq-capital-input">' +
              '<span style="color:var(--text-muted);font-size:10px">$</span>' +
              '<input type="number" id="aqCapitalInput" value="' + (blockerData.founder?.fundSize || 6000) + '" min="100" step="500" onclick="event.stopPropagation()">' +
              '<button class="btn btn-primary" style="font-size:10px;padding:3px 8px" onclick="event.stopPropagation();setCapital()">Confirm</button>' +
            '</div>';
        } else if (b.id === 'risks') {
          if (isExpanded) {
            var limits = b.limits || {};
            actionHtml = '<div class="aq-step-expanded">' +
              '<div class="aq-input-row"><label>Max/Mkt</label><input type="number" id="aq_risk_max" value="' + (limits.maxExposurePerMarket || 500) + '" onclick="event.stopPropagation()"></div>' +
              '<div class="aq-input-row"><label>Daily</label><input type="number" id="aq_risk_daily" value="' + (limits.dailyMaxExposure || 2000) + '" onclick="event.stopPropagation()"></div>' +
              '<div class="aq-input-row"><label>Min Edge</label><input type="number" step="0.001" id="aq_risk_edge" value="' + (limits.minEdgeThreshold || 0.02) + '" onclick="event.stopPropagation()"></div>' +
              '<div style="margin-top:8px;display:flex;gap:6px">' +
                '<button class="btn btn-primary" style="font-size:10px" onclick="event.stopPropagation();saveAqRiskAndApprove()">Save & Approve</button>' +
                '<button class="btn" style="font-size:10px" onclick="event.stopPropagation();approveRisks()">Approve Current</button>' +
              '</div>' +
            '</div>';
          } else {
            actionHtml =
              '<div class="aq-step-action">' +
                '<div style="font-size:9px;color:var(--accent-cyan);font-family:var(--font-mono);margin-bottom:4px">Click to edit limits</div>' +
                '<button class="btn btn-primary" onclick="event.stopPropagation();approveRisks()">Approve Current Limits</button>' +
              '</div>';
          }
        } else if (b.id === 'trade' && b.status === 'ready') {
          actionHtml = '<div class="aq-step-action">' +
            '<button class="btn btn-primary" onclick="event.stopPropagation();switchToTab(\\'opportunities\\')">Go to Opportunities</button>' +
          '</div>';
        }
      }

      var clickHandler = b.status !== 'done' && b.status !== 'locked'
        ? ' onclick="toggleStepExpand(\\'' + b.id + '\\')"' : '';

      return '<div class="aq-step ' + stepClass + '"' + clickHandler + '>' +
        '<div class="aq-num">' + (b.status === 'done' ? '>' : (i + 1)) + '</div>' +
        '<div class="aq-step-title">' + statusIcon + ' ' + esc(b.title) + '</div>' +
        '<div class="aq-step-desc">' + esc(b.desc) + '</div>' +
        actionHtml +
      '</div>';
    }).join('');
  }

  function toggleStepExpand(id) {
    expandedStep = expandedStep === id ? null : id;
    renderActionQueue();
  }

  async function saveAqApiKeys() {
    var updates = {};
    var k = document.getElementById('aq_api_key');
    var s = document.getElementById('aq_api_secret');
    var p = document.getElementById('aq_api_pass');
    if (k && k.value.trim()) updates.POLYMARKET_API_KEY = k.value.trim();
    if (s && s.value.trim()) updates.POLYMARKET_API_SECRET = s.value.trim();
    if (p && p.value.trim()) updates.POLYMARKET_API_PASSPHRASE = p.value.trim();
    if (Object.keys(updates).length === 0) { toast('Enter at least one key', 'error'); return; }
    try {
      var r = await fetch('/api/founder/update-env', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
      var data = await r.json();
      if (data.ok) { toast('API keys saved!', 'success'); expandedStep = null; fetchBlockers(); }
      else toast('Failed: ' + (data.error || ''), 'error');
    } catch (e) { toast('Save failed', 'error'); }
  }

  async function saveAqWalletKey() {
    var el = document.getElementById('aq_wallet_key');
    if (!el || !el.value.trim()) { toast('Enter wallet key', 'error'); return; }
    try {
      var r = await fetch('/api/founder/update-env', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ POLYMARKET_PRIVATE_KEY: el.value.trim() }) });
      var data = await r.json();
      if (data.ok) { toast('Wallet key saved!', 'success'); expandedStep = null; fetchBlockers(); }
      else toast('Failed: ' + (data.error || ''), 'error');
    } catch (e) { toast('Save failed', 'error'); }
  }

  async function saveAqRiskAndApprove() {
    var updates = {};
    var e1 = document.getElementById('aq_risk_max');
    var e2 = document.getElementById('aq_risk_daily');
    var e3 = document.getElementById('aq_risk_edge');
    if (e1) updates.MAX_EXPOSURE_PER_MARKET = e1.value;
    if (e2) updates.DAILY_MAX_EXPOSURE = e2.value;
    if (e3) updates.MIN_EDGE_THRESHOLD = e3.value;
    try {
      await fetch('/api/founder/update-env', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
      await approveRisks();
      expandedStep = null;
    } catch (e) { toast('Save failed', 'error'); }
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

  // ── Search / Filter ──
  function filterAndRender() {
    renderOpportunities();
  }

  function getFilteredOpportunities() {
    let filtered = [...opportunities];
    const query = (document.getElementById('marketSearch')?.value || '').toLowerCase();
    const minEdge = parseFloat(document.getElementById('edgeFilter')?.value || '0');
    const sortBy = document.getElementById('sortMode')?.value || 'edge';

    if (query) {
      filtered = filtered.filter(o => o.market.toLowerCase().includes(query));
    }
    if (minEdge > 0) {
      filtered = filtered.filter(o => o.edge >= minEdge);
    }
    if (sortBy === 'volume') filtered.sort((a, b) => b.volume - a.volume);
    else if (sortBy === 'confidence') filtered.sort((a, b) => b.confidence - a.confidence);
    else if (sortBy === 'liquidity') filtered.sort((a, b) => b.liquidity - a.liquidity);
    else filtered.sort((a, b) => b.edge - a.edge);

    return filtered;
  }

  // ── Market Detail Modal ──
  function showMarketDetail(idx) {
    const filtered = getFilteredOpportunities();
    const o = filtered[idx];
    if (!o) return;

    const edgeClass = o.edge >= 2 ? 'edge-high' : o.edge >= 1 ? 'edge-mid' : 'edge-low';
    const isDemo = o.demo || false;
    const expiryText = o.daysToExpiry !== null && o.daysToExpiry !== undefined ? o.daysToExpiry + ' days' : 'N/A';
    const decision = founderDecisions[o.id];

    document.getElementById('marketModal').innerHTML =
      '<div class="modal-overlay" onclick="closeMarketModal(event)">' +
        '<div class="modal" onclick="event.stopPropagation()">' +
          '<div class="modal-header">' +
            '<h2>' + esc(o.market) + '</h2>' +
            '<button class="modal-close" onclick="closeMarketModal()">X</button>' +
          '</div>' +
          '<div class="modal-body">' +
            (isDemo ? '<div style="padding:8px 12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:6px;margin-bottom:12px;font-size:11px;color:var(--accent-yellow);font-family:var(--font-mono)">DEMO DATA — Connect Polymarket API for live markets</div>' : '') +
            (o.description ? '<div class="md-desc">' + esc(o.description) + '</div>' : '') +
            '<div class="md-grid">' +
              '<div class="md-stat"><div class="ms-label">Edge</div><div class="ms-val ' + edgeClass + '">' + o.edge.toFixed(2) + '%</div></div>' +
              '<div class="md-stat"><div class="ms-label">Confidence</div><div class="ms-val">' + o.confidence.toFixed(0) + '%</div></div>' +
              '<div class="md-stat"><div class="ms-label">Yes Price</div><div class="ms-val">' + o.bestBid.toFixed(4) + '</div></div>' +
              '<div class="md-stat"><div class="ms-label">No Price</div><div class="ms-val">' + o.bestAsk.toFixed(4) + '</div></div>' +
              '<div class="md-stat"><div class="ms-label">Price Sum</div><div class="ms-val">' + o.priceSum.toFixed(4) + '</div></div>' +
              '<div class="md-stat"><div class="ms-label">Volume 24h</div><div class="ms-val">$' + fmt(o.volume) + '</div></div>' +
              '<div class="md-stat"><div class="ms-label">Liquidity</div><div class="ms-val">$' + fmt(o.liquidity) + '</div></div>' +
              '<div class="md-stat"><div class="ms-label">Expires</div><div class="ms-val">' + expiryText + '</div></div>' +
            '</div>' +
            '<div style="margin-top:12px">' +
              '<div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);margin-bottom:6px">OUTCOMES: ' + (o.outcomes || []).join(' / ') + '</div>' +
              (o.negRisk ? '<span class="negrisk-tag" style="margin-bottom:8px;display:inline-block">NegRisk Market</span>' : '') +
              (decision ? '<div style="margin-top:8px;font-family:var(--font-mono);font-size:12px;font-weight:700;color:' + (decision.verdict === 'BUY' ? 'var(--accent-green)' : 'var(--text-muted)') + '">Decision: ' + decision.verdict + '</div>' : '') +
            '</div>' +
            '<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">' +
              (o.link !== 'https://polymarket.com' ? '<a class="md-link" href="' + esc(o.link) + '" target="_blank" rel="noopener">View on Polymarket</a>' : '') +
              (!decision && tradingUnlocked ? '<button class="btn btn-primary" style="padding:8px 16px" onclick="founderDecide(\\'' + o.id + '\\', \\'BUY\\', \\'' + esc(o.market).replace(/'/g, "\\\\'") + '\\');closeMarketModal()">BUY</button>' +
                '<button class="btn" style="padding:8px 16px" onclick="founderDecide(\\'' + o.id + '\\', \\'PASS\\', \\'' + esc(o.market).replace(/'/g, "\\\\'") + '\\');closeMarketModal()">PASS</button>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function closeMarketModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('marketModal').innerHTML = '';
  }

  // ── Explain Hub ──
  let hubData = null;

  async function fetchSystemStatus() {
    try {
      const r = await fetch('/api/system-status');
      hubData = await r.json();
      renderHub();
    } catch (e) {
      console.error('Hub fetch error:', e);
    }
  }

  async function fetchActivityLog() {
    try {
      const r = await fetch('/api/activity-log');
      const data = await r.json();
      renderActivityFeed(data.log || []);
    } catch (e) { /* silent */ }
  }

  function renderHub() {
    if (!hubData) {
      document.getElementById('hubGrid').innerHTML = '<div class="loader"><div class="spinner"></div><div class="loader-text">Loading system status...</div></div>';
      return;
    }
    const h = hubData;

    // System overview card
    let html = '<div class="hub-card">' +
      '<h3>System Overview</h3>' +
      '<p>ZVI v1 is a Polymarket Fund Operating System. It continuously scans prediction markets for mispriced opportunities, computes edge and confidence scores, and surfaces them for founder decision-making.</p>' +
      '<div class="hub-status-grid">' +
        '<div class="hub-stat"><div class="hs-label">Uptime</div><div class="hs-val">' + esc(h.uptimeFormatted) + '</div></div>' +
        '<div class="hub-stat"><div class="hs-label">Mode</div><div class="hs-val">' + (h.mode === 'OBSERVATION_ONLY' ? 'Observe' : 'LIVE') + '</div></div>' +
        '<div class="hub-stat"><div class="hs-label">Data Source</div><div class="hs-val">' + (h.dataSource === 'live' ? 'Polymarket API' : 'Demo Data') + '</div></div>' +
        '<div class="hub-stat"><div class="hs-label">Markets Cached</div><div class="hs-val">' + h.marketsInCache + '</div></div>' +
        '<div class="hub-stat"><div class="hs-label">Total Scans</div><div class="hs-val">' + h.totalScans + '</div></div>' +
        '<div class="hub-stat"><div class="hs-label">Markets Scanned</div><div class="hs-val">' + h.totalMarketsScanned + '</div></div>' +
      '</div>' +
    '</div>';

    // Setup progress
    var secretsList = [
      { key: 'polygonRpc', label: 'Polygon RPC' },
      { key: 'anthropicKey', label: 'Anthropic LLM' },
      { key: 'polymarketGamma', label: 'Polymarket API' },
      { key: 'polymarketClob', label: 'CLOB Trading' },
      { key: 'polymarketPrivateKey', label: 'Wallet Key' },
      { key: 'telegram', label: 'Telegram Alerts' },
    ];
    html += '<div class="hub-card">' +
      '<h3>Setup Progress</h3>';
    for (var si = 0; si < secretsList.length; si++) {
      var s = secretsList[si];
      var ok = h.secrets[s.key];
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(42,53,85,0.3)">' +
        '<span style="font-size:12px">' + s.label + '</span>' +
        '<span class="setting-status ' + (ok ? 'connected' : 'missing') + '">' + (ok ? 'Connected' : 'Missing') + '</span>' +
      '</div>';
    }
    html += '<div style="margin-top:12px"><button class="btn btn-primary" onclick="switchToTab(\\'settings\\')">Configure in Settings</button></div>' +
    '</div>';

    // Founder state
    html += '<div class="hub-card">' +
      '<h3>Founder Status</h3>' +
      '<div class="hub-status-grid">' +
        '<div class="hub-stat"><div class="hs-label">Fund Size</div><div class="hs-val" style="color:var(--accent-green)">$' + h.founder.fundSize.toLocaleString() + '</div></div>' +
        '<div class="hub-stat"><div class="hs-label">Capital Deployed</div><div class="hs-val" style="color:var(--accent-yellow)">$' + h.founder.capitalDeployed.toLocaleString() + '</div></div>' +
        '<div class="hub-stat"><div class="hs-label">Decisions Made</div><div class="hs-val">' + h.founder.totalDecisions + '</div></div>' +
        '<div class="hub-stat"><div class="hs-label">BUY / PASS</div><div class="hs-val">' + h.founder.buys + ' / ' + h.founder.passes + '</div></div>' +
      '</div>' +
    '</div>';

    // Glossary
    html += '<div class="hub-card">' +
      '<h3>Key Concepts</h3>' +
      '<div class="glossary-item"><div class="gi-term">Edge %</div><div class="gi-def">The pricing inefficiency. Calculated as |1.0 - (YES price + NO price)| x 100. Markets should sum to exactly 1.0. Any deviation = potential arbitrage.</div></div>' +
      '<div class="glossary-item"><div class="gi-term">Confidence Score</div><div class="gi-def">Composite metric: 40% edge magnitude + 35% volume + 25% liquidity. Higher = more reliable opportunity.</div></div>' +
      '<div class="glossary-item"><div class="gi-term">NegRisk</div><div class="gi-def">Polymarket markets using the NegRisk adapter contract. These allow multi-outcome events and have specific arbitrage patterns.</div></div>' +
      '<div class="glossary-item"><div class="gi-term">Kelly Sizing</div><div class="gi-def">Position size = edge x confidence x fund_size x 0.25 (quarter-Kelly). Caps at max per market. Conservative approach for capital preservation.</div></div>' +
      '<div class="glossary-item"><div class="gi-term">Price Sum</div><div class="gi-def">YES + NO prices. Should equal 1.0. When below 1.0: buy-all-YES arb opportunity. When above 1.0: buy-all-NO + convert opportunity.</div></div>' +
    '</div>';

    // Roadmap
    html += '<div class="hub-card">' +
      '<h3>Development Roadmap</h3>' +
      '<div class="roadmap-phase active">' +
        '<div class="rp-title"><span class="rp-tag current">NOW</span>Phase 1 — Foundation</div>' +
        '<div class="rp-desc">Live market scanning, founder decision queue, basic analytics. Dashboard operational with Polymarket API integration.</div>' +
      '</div>' +
      '<div class="roadmap-phase next">' +
        '<div class="rp-title"><span class="rp-tag upcoming">NEXT</span>Phase 2 — Execution</div>' +
        '<div class="rp-desc">CLOB order execution (dry-run first), basket execution for multi-leg arbs, simulate button showing expected fills without placing orders.</div>' +
      '</div>' +
      '<div class="roadmap-phase next">' +
        '<div class="rp-title"><span class="rp-tag upcoming">NEXT</span>Phase 3 — LLM Engine</div>' +
        '<div class="rp-desc">Claude/GPT probability estimates, mispricing alerts when model-vs-market gap > 10%, auto-generated RP Optical-style research briefs.</div>' +
      '</div>' +
      '<div class="roadmap-phase future">' +
        '<div class="rp-title"><span class="rp-tag planned">PLANNED</span>Phase 4 — Risk & Scale</div>' +
        '<div class="rp-desc">P&L tracking, position-aware risk checks, multi-exchange arb (Polymarket + Kalshi + Metaculus), portfolio optimization, mobile alerts.</div>' +
      '</div>' +
    '</div>';

    // Activity Feed
    html += '<div class="hub-card full-width">' +
      '<h3>Activity Log</h3>' +
      '<div class="activity-feed" id="activityFeed">' +
        '<div style="color:var(--text-muted);font-family:var(--font-mono);font-size:11px">Loading...</div>' +
      '</div>' +
    '</div>';

    document.getElementById('hubGrid').innerHTML = html;
    fetchActivityLog();
  }

  function renderActivityFeed(log) {
    var feedEl = document.getElementById('activityFeed');
    if (!feedEl) return;
    if (log.length === 0) {
      feedEl.innerHTML = '<div style="color:var(--text-muted);font-family:var(--font-mono);font-size:11px;padding:8px">No activity yet</div>';
      return;
    }
    feedEl.innerHTML = log.slice(0, 100).map(function(entry) {
      var time = new Date(entry.timestamp).toLocaleTimeString();
      var typeCls = 'at-' + entry.type;
      return '<div class="activity-entry">' +
        '<span class="activity-time">' + time + '</span>' +
        '<span class="activity-type ' + typeCls + '">' + esc(entry.type) + '</span>' +
        '<span class="activity-msg">' + esc(entry.message) + '</span>' +
      '</div>';
    }).join('');
  }

  function switchToTab(tabName) {
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
    var tabEl = document.querySelector('.tab[data-tab="' + tabName + '"]');
    if (tabEl) tabEl.classList.add('active');
    var panelEl = document.getElementById('panel-' + tabName);
    if (panelEl) panelEl.classList.add('active');
    if (tabName === 'hub') { fetchSystemStatus(); fetchActivityLog(); }
    if (tabName === 'settings') renderSettings();
  }

  // ── Settings ──
  function renderSettings() {
    var cfg = null;
    fetch('/api/config').then(function(r) { return r.json(); }).then(function(data) {
      cfg = data;
      doRenderSettings(cfg);
    }).catch(function() {
      document.getElementById('settingsContent').innerHTML = '<div class="empty-state"><p>Failed to load settings</p></div>';
    });
  }

  function doRenderSettings(cfg) {
    var html = '';

    // API Keys section
    html += '<div class="settings-section">' +
      '<h3>API Connections</h3>' +
      '<div class="settings-grid">' +
        settingInput('POLYMARKET_API_KEY', 'Polymarket API Key', 'CLOB API key for order placement', cfg.secrets.polymarketClob, 'password') +
        settingInput('POLYMARKET_API_SECRET', 'Polymarket API Secret', 'CLOB API secret', cfg.secrets.polymarketClob, 'password') +
        settingInput('POLYMARKET_API_PASSPHRASE', 'Polymarket Passphrase', 'CLOB API passphrase', cfg.secrets.polymarketClob, 'password') +
        settingInput('POLYMARKET_PRIVATE_KEY', 'Wallet Private Key', 'Polygon wallet key for signing txns', cfg.secrets.polymarketPrivateKey, 'password') +
        settingInput('ANTHROPIC_API_KEY', 'Anthropic API Key', 'Claude LLM for probability estimates', cfg.secrets.anthropicKey, 'password') +
        settingInput('POLYGON_RPC_URL', 'Polygon RPC URL', 'Alchemy/Infura Polygon endpoint', cfg.secrets.polygonRpc, 'text') +
        settingInput('TELEGRAM_BOT_TOKEN', 'Telegram Bot Token', 'For alert notifications', cfg.secrets.telegram, 'password') +
        settingInput('TELEGRAM_CHAT_ID', 'Telegram Chat ID', 'Chat to receive alerts', cfg.secrets.telegram, 'text') +
      '</div>' +
      '<div style="margin-top:12px"><button class="btn btn-primary" onclick="saveApiKeys()">Save API Keys</button></div>' +
    '</div>';

    // Risk Limits
    html += '<div class="settings-section">' +
      '<h3>Risk Limits</h3>' +
      '<div class="settings-grid">' +
        settingNumInput('MAX_EXPOSURE_PER_MARKET', 'Max Per Market ($)', 'Maximum USDC exposure per single market', cfg.riskLimits.maxExposurePerMarket) +
        settingNumInput('DAILY_MAX_EXPOSURE', 'Daily Max Exposure ($)', 'Maximum total USDC deployed per day', cfg.riskLimits.dailyMaxExposure) +
        settingNumInput('MIN_EDGE_THRESHOLD', 'Min Edge Threshold', 'Minimum edge % to consider (0.02 = 2%)', cfg.riskLimits.minEdgeThreshold) +
        settingNumInput('MIN_DEPTH_USDC', 'Min Depth (USDC)', 'Minimum market depth to trade', cfg.riskLimits.minDepthUsdc) +
      '</div>' +
      '<div style="margin-top:12px"><button class="btn btn-primary" onclick="saveRiskLimits()">Save Risk Limits</button></div>' +
    '</div>';

    // Scan Settings
    html += '<div class="settings-section">' +
      '<h3>Scanner Settings</h3>' +
      '<div class="settings-grid">' +
        '<div class="setting-item">' +
          '<label>Market Scan Limit</label>' +
          '<div class="setting-desc">Number of markets to scan per cycle (no hard cap)</div>' +
          '<input type="number" id="set_marketLimit" value="200" min="10" max="5000">' +
        '</div>' +
        '<div class="setting-item">' +
          '<label>Refresh Interval (seconds)</label>' +
          '<div class="setting-desc">Auto-refresh interval for market data</div>' +
          '<input type="number" id="set_refreshInterval" value="30" min="10" max="300">' +
        '</div>' +
        '<div class="setting-item">' +
          '<label>Scan Mode</label>' +
          '<div class="setting-desc">How to prioritize markets</div>' +
          '<select id="set_scanMode">' +
            '<option value="volume">By Volume (default)</option>' +
            '<option value="newest">Newest First</option>' +
            '<option value="ending-soon">Ending Soon</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:12px"><button class="btn btn-primary" onclick="saveScanSettings()">Save Scan Settings</button></div>' +
    '</div>';

    // Operation Mode
    html += '<div class="settings-section">' +
      '<h3>Operation Mode</h3>' +
      '<div class="settings-grid">' +
        '<div class="setting-item">' +
          '<label>Trading Mode</label>' +
          '<select id="set_observationOnly">' +
            '<option value="true" ' + (cfg.mode === 'OBSERVATION_ONLY' ? 'selected' : '') + '>Observation Only (safe)</option>' +
            '<option value="false" ' + (cfg.mode !== 'OBSERVATION_ONLY' ? 'selected' : '') + '>Live Trading</option>' +
          '</select>' +
        '</div>' +
        '<div class="setting-item">' +
          '<label>Manual Approval</label>' +
          '<select id="set_manualApproval">' +
            '<option value="true" selected>Required (recommended)</option>' +
            '<option value="false">Auto-execute</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:12px"><button class="btn btn-primary" onclick="saveOperationMode()">Save Mode</button></div>' +
    '</div>';

    document.getElementById('settingsContent').innerHTML = html;

    // Load current scan settings
    fetch('/api/settings').then(function(r) { return r.json(); }).then(function(s) {
      var el1 = document.getElementById('set_marketLimit');
      var el2 = document.getElementById('set_refreshInterval');
      var el3 = document.getElementById('set_scanMode');
      if (el1 && s.marketLimit) el1.value = s.marketLimit;
      if (el2 && s.refreshInterval) el2.value = s.refreshInterval;
      if (el3 && s.scanMode) el3.value = s.scanMode;
    }).catch(function() {});
  }

  function settingInput(envKey, label, desc, isConnected, type) {
    return '<div class="setting-item">' +
      '<label>' + label + ' <span class="setting-status ' + (isConnected ? 'connected' : 'missing') + '">' + (isConnected ? 'OK' : 'MISSING') + '</span></label>' +
      '<div class="setting-desc">' + desc + '</div>' +
      '<input type="' + type + '" id="set_' + envKey + '" placeholder="Enter ' + label + '...">' +
    '</div>';
  }

  function settingNumInput(envKey, label, desc, currentVal) {
    return '<div class="setting-item">' +
      '<label>' + label + '</label>' +
      '<div class="setting-desc">' + desc + '</div>' +
      '<input type="number" id="set_' + envKey + '" value="' + currentVal + '" step="any">' +
    '</div>';
  }

  async function saveApiKeys() {
    var keys = ['POLYMARKET_API_KEY','POLYMARKET_API_SECRET','POLYMARKET_API_PASSPHRASE','POLYMARKET_PRIVATE_KEY','ANTHROPIC_API_KEY','POLYGON_RPC_URL','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'];
    var updates = {};
    for (var i = 0; i < keys.length; i++) {
      var el = document.getElementById('set_' + keys[i]);
      if (el && el.value.trim()) updates[keys[i]] = el.value.trim();
    }
    if (Object.keys(updates).length === 0) { toast('No values to save', 'info'); return; }
    try {
      var r = await fetch('/api/founder/update-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      var data = await r.json();
      if (data.ok) {
        toast('Saved ' + data.updated.length + ' key(s). Restart may be needed for some changes.', 'success');
        // Clear inputs
        for (var j = 0; j < keys.length; j++) {
          var el2 = document.getElementById('set_' + keys[j]);
          if (el2) el2.value = '';
        }
        renderSettings();
        fetchBlockers();
      } else {
        toast('Save failed: ' + (data.error || 'Unknown'), 'error');
      }
    } catch (e) { toast('Save failed', 'error'); }
  }

  async function saveRiskLimits() {
    var updates = {};
    var el1 = document.getElementById('set_MAX_EXPOSURE_PER_MARKET');
    var el2 = document.getElementById('set_DAILY_MAX_EXPOSURE');
    var el3 = document.getElementById('set_MIN_EDGE_THRESHOLD');
    var el4 = document.getElementById('set_MIN_DEPTH_USDC');
    if (el1) updates.MAX_EXPOSURE_PER_MARKET = el1.value;
    if (el2) updates.DAILY_MAX_EXPOSURE = el2.value;
    if (el3) updates.MIN_EDGE_THRESHOLD = el3.value;
    if (el4) updates.MIN_DEPTH_USDC = el4.value;
    try {
      var r = await fetch('/api/founder/update-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      var data = await r.json();
      if (data.ok) { toast('Risk limits saved', 'success'); fetchBlockers(); }
      else toast('Failed: ' + (data.error || ''), 'error');
    } catch (e) { toast('Save failed', 'error'); }
  }

  async function saveScanSettings() {
    var marketLimit = parseInt(document.getElementById('set_marketLimit')?.value) || 200;
    var refreshInterval = parseInt(document.getElementById('set_refreshInterval')?.value) || 30;
    var scanMode = document.getElementById('set_scanMode')?.value || 'volume';
    try {
      var r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketLimit: marketLimit, refreshInterval: refreshInterval, scanMode: scanMode }),
      });
      var data = await r.json();
      if (data.ok) {
        toast('Scan settings saved — limit: ' + marketLimit + ', interval: ' + refreshInterval + 's', 'success');
        // Update refresh interval
        if (countdownInterval) clearInterval(countdownInterval);
        refreshCountdown = refreshInterval;
        startCountdown();
      } else toast('Failed', 'error');
    } catch (e) { toast('Save failed', 'error'); }
  }

  async function saveOperationMode() {
    var updates = {};
    var el1 = document.getElementById('set_observationOnly');
    var el2 = document.getElementById('set_manualApproval');
    if (el1) updates.OBSERVATION_ONLY = el1.value;
    if (el2) updates.MANUAL_APPROVAL_REQUIRED = el2.value;
    try {
      var r = await fetch('/api/founder/update-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      var data = await r.json();
      if (data.ok) {
        toast('Mode saved. Restart server for full effect.', 'success');
        loadConfig();
      }
    } catch (e) { toast('Save failed', 'error'); }
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

    // Keyboard shortcut: Escape closes modal
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeMarketModal();
    });
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

    // ── System Status & Activity Log ──
    if (pathname === '/api/system-status' && method === 'GET') {
      return json(res, getSystemStatus());
    }

    if (pathname === '/api/activity-log' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit')) || 100;
      return json(res, { log: activityLog.slice(0, limit), total: activityLog.length });
    }

    // ── Settings ──
    if (pathname === '/api/settings' && method === 'GET') {
      return json(res, state.settings);
    }

    if (pathname === '/api/settings' && method === 'POST') {
      const body = await readBody(req);
      if (body.marketLimit !== undefined) state.settings.marketLimit = Math.max(10, Math.min(5000, parseInt(body.marketLimit) || 200));
      if (body.refreshInterval !== undefined) state.settings.refreshInterval = Math.max(10, Math.min(300, parseInt(body.refreshInterval) || 30));
      if (body.scanMode !== undefined && ['volume', 'newest', 'ending-soon'].includes(body.scanMode)) state.settings.scanMode = body.scanMode;
      if (body.minEdgeDisplay !== undefined) state.settings.minEdgeDisplay = parseFloat(body.minEdgeDisplay) || 0;
      logActivity('config', 'Settings updated: ' + JSON.stringify(state.settings));
      return json(res, { ok: true, settings: state.settings });
    }

    // ── Env file updater ──
    if (pathname === '/api/founder/update-env' && method === 'POST') {
      const body = await readBody(req);
      const result = updateEnvFile(body);
      return json(res, result, result.ok ? 200 : 400);
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
      logActivity('config', 'Fund capital set: $' + size.toLocaleString());
      return json(res, { ok: true, fundSize: size, blockers: getBlockers() });
    }

    if (pathname === '/api/founder/approve-risks' && method === 'POST') {
      state.founder.risksApproved = true;
      if (!state.founder.completedSteps.includes('risks')) {
        state.founder.completedSteps.push('risks');
      }
      logActivity('config', 'Risk limits approved');
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
      logActivity('decision', verdict + ': ' + (market || marketId));
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
  logActivity('system', 'Server started on port ' + PORT);
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
