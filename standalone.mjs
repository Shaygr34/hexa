#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// ZVI v1 — Fund Operating System
// Agent-first autonomous trading platform for Polymarket
// Single-file · Zero dependencies · Node.js
// ═══════════════════════════════════════════════════════════════════════════════

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE_DIR = path.dirname(new URL(import.meta.url).pathname);
const ENV_PATH = path.join(BASE_DIR, '.env.local');
const STATE_PATH = path.join(BASE_DIR, 'zvi_state.json');
const STARTUP_TIME = Date.now();

// ─── .env.local loader ──────────────────────────────────────────────────────
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
      process.env[key] = val;
    }
    console.log('[env] Loaded .env.local');
  } catch (e) {
    console.log('[env] Could not load .env.local:', e.message);
  }
}
loadEnv();

// ═══════════════════════════════════════════════════════════════════════════════
// STATE STORE + PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

const store = {
  agents: [],
  approvalsQueue: [],
  auditLog: [],
  marketCache: { data: [], fetchedAt: 0, ttl: 15000 },
  llmCache: {},
  whaleWallets: [],
  whaleEvents: [],
  headlines: [],
  sentimentResults: [],
  strategyOpportunities: [],
  signals: [],
  thresholds: [],
  openOrders: [],
  founder: {
    capitalAllocated: false, fundSize: 6000, risksApproved: false,
    decisions: {}, positions: {}, capitalDeployed: 0, completedSteps: [],
  },
  settings: { marketLimit: 200, refreshInterval: 30, scanMode: 'volume', minEdgeDisplay: 0 },
  agentHeartbeats: {
    scanner: { lastSeen: Date.now(), status: 'running', interval: 30000 },
    signalEngine: { lastSeen: Date.now(), status: 'running', interval: 60000 },
    riskManager: { lastSeen: Date.now(), status: 'idle', interval: 120000 },
  },
  killSwitch: false,
  totalScans: 0,
  totalMarketsScanned: 0,
  pinnedMarkets: [],
  diagnostics: { lastRun: null, results: {} },
  commandHistory: [],
};

// ── Persistence ──
let persistTimer = null, persistDirty = false;
function markDirty() {
  persistDirty = true;
  if (!persistTimer) {
    persistTimer = setTimeout(() => { persistTimer = null; if (persistDirty) saveState(); }, 5000);
  }
}
function saveState() {
  try {
    const snap = {
      agents: store.agents, approvalsQueue: store.approvalsQueue,
      auditLog: store.auditLog.slice(-500), whaleWallets: store.whaleWallets,
      founder: store.founder, settings: store.settings,
      pinnedMarkets: store.pinnedMarkets, killSwitch: store.killSwitch,
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(snap, null, 2), 'utf-8');
    persistDirty = false;
  } catch (e) { console.error('[persist] Save error:', e.message); }
}
function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    if (data.agents) store.agents = data.agents;
    if (data.approvalsQueue) store.approvalsQueue = data.approvalsQueue;
    if (data.auditLog) store.auditLog = data.auditLog;
    if (data.whaleWallets) store.whaleWallets = data.whaleWallets;
    if (data.founder) Object.assign(store.founder, data.founder);
    if (data.settings) Object.assign(store.settings, data.settings);
    if (data.pinnedMarkets) store.pinnedMarkets = data.pinnedMarkets;
    if (data.killSwitch !== undefined) store.killSwitch = data.killSwitch;
    console.log('[persist] Loaded state from zvi_state.json');
  } catch { console.log('[persist] No saved state, starting fresh'); }
}
loadState();

// ── Audit + Activity Logs ──
function audit(level, event, data = {}, agentId = null) {
  const entry = { ts: new Date().toISOString(), level, agentId, event, data };
  store.auditLog.push(entry);
  if (store.auditLog.length > 2000) store.auditLog = store.auditLog.slice(-1000);
  markDirty();
  return entry;
}
const activityLog = [];
function logActivity(type, message) {
  activityLog.unshift({ type, message, timestamp: new Date().toISOString() });
  if (activityLog.length > 200) activityLog.length = 200;
}
logActivity('system', 'ZVI v1 starting up');

// ═══════════════════════════════════════════════════════════════════════════════
// POLYMARKET API CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

function httpGet(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpPost(url, body, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST', timeout,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

async function fetchMarkets() {
  const now = Date.now();
  if (store.marketCache.data.length > 0 && (now - store.marketCache.fetchedAt) < store.marketCache.ttl) {
    return store.marketCache.data;
  }
  try {
    const gammaUrl = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
    const limit = store.settings.marketLimit || 200;
    const allMarkets = [];
    let offset = 0;
    const batchSize = 100;
    while (offset < limit) {
      const url = `${gammaUrl}/markets?limit=${Math.min(batchSize, limit - offset)}&offset=${offset}&active=true&closed=false`;
      const batch = await httpGet(url);
      if (!Array.isArray(batch) || batch.length === 0) break;
      allMarkets.push(...batch);
      offset += batch.length;
      if (batch.length < batchSize) break;
    }
    const opportunities = allMarkets.map(m => {
      const outcomes = [];
      const outcomePrices = [];
      try {
        const op = JSON.parse(m.outcomePrices || '[]');
        const on = JSON.parse(m.outcomes || '[]');
        for (let i = 0; i < on.length; i++) { outcomes.push(on[i]); outcomePrices.push(parseFloat(op[i]) || 0); }
      } catch {}
      const yes = outcomePrices[0] || 0, no = outcomePrices[1] || 0;
      const sum = outcomePrices.reduce((a, b) => a + b, 0);
      const edge = Math.abs(1.0 - sum);
      const vol = parseFloat(m.volume) || 0, liq = parseFloat(m.liquidity) || 0;
      const edgeScore = Math.min(edge / 0.05, 1.0);
      const volScore = Math.min(vol / 500000, 1.0);
      const liqScore = Math.min(liq / 100000, 1.0);
      const confidence = (edgeScore * 0.4 + volScore * 0.35 + liqScore * 0.25) * 100;
      const negRisk = m.negRisk === true || m.negRisk === 'true';
      let daysToExpiry = null;
      if (m.endDate) {
        const diff = new Date(m.endDate).getTime() - now;
        if (diff > 0) daysToExpiry = Math.ceil(diff / 86400000);
      }
      return {
        id: m.conditionId || crypto.randomUUID(),
        market: m.question || m.title || 'Unknown',
        description: m.description || '',
        edge: parseFloat((edge * 100).toFixed(3)),
        bestBid: yes, bestAsk: no, priceSum: parseFloat(sum.toFixed(4)),
        outcomes, outcomePrices, volume: vol, liquidity: liq,
        confidence: parseFloat(confidence.toFixed(1)),
        link: m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
        slug: m.slug || '', negRisk, conditionId: m.conditionId || '',
        clobTokenIds: m.clobTokenIds || '', endDate: m.endDate || null,
        daysToExpiry, updatedAt: m.updatedAt || new Date().toISOString(), demo: false,
        numOutcomes: outcomes.length,
      };
    }).sort((a, b) => b.edge - a.edge);

    store.marketCache = { data: opportunities, fetchedAt: now, ttl: 15000 };
    store.agentHeartbeats.scanner.lastSeen = now;
    store.agentHeartbeats.scanner.status = 'running';
    store.totalScans++;
    store.totalMarketsScanned += allMarkets.length;
    logActivity('scan', `Scanned ${allMarkets.length} markets, found ${opportunities.filter(o => o.edge > 0.5).length} with edge > 0.5%`);
    return opportunities;
  } catch (err) {
    console.error('[gamma] Fetch error:', err.message);
    logActivity('error', 'Gamma API fetch failed: ' + err.message);
    store.agentHeartbeats.scanner.status = 'demo';
    if (store.marketCache.data.length > 0) return store.marketCache.data;
    const demo = getDemoOpportunities();
    store.marketCache = { data: demo, fetchedAt: now, ttl: 30000 };
    return demo;
  }
}

function getDemoOpportunities() {
  const markets = [
    { market: 'Will Trump win the 2028 presidential election?', yes: 0.35, no: 0.62, vol: 1842000, liq: 520000, negRisk: false },
    { market: 'Fed rate cut before July 2026?', yes: 0.72, no: 0.31, vol: 980000, liq: 310000, negRisk: false },
    { market: 'Bitcoin above $150k by end of 2026?', yes: 0.28, no: 0.69, vol: 2100000, liq: 890000, negRisk: false },
    { market: 'Ukraine ceasefire before April 2026?', yes: 0.41, no: 0.55, vol: 750000, liq: 210000, negRisk: true },
    { market: 'S&P 500 above 6500 by March 2026?', yes: 0.58, no: 0.45, vol: 1200000, liq: 420000, negRisk: false },
    { market: 'Will AI model beat IMO gold medalist in 2026?', yes: 0.62, no: 0.41, vol: 480000, liq: 150000, negRisk: true },
    { market: 'US recession in 2026?', yes: 0.22, no: 0.75, vol: 3200000, liq: 1100000, negRisk: false },
    { market: 'Ethereum ETF inflows > $10B by June 2026?', yes: 0.45, no: 0.52, vol: 620000, liq: 280000, negRisk: false },
    { market: 'Israel-Saudi normalization deal in 2026?', yes: 0.18, no: 0.78, vol: 340000, liq: 95000, negRisk: true },
    { market: 'GPT-5 released before September 2026?', yes: 0.55, no: 0.48, vol: 890000, liq: 370000, negRisk: false },
    { market: 'Tesla stock above $500 by mid-2026?', yes: 0.30, no: 0.67, vol: 1500000, liq: 600000, negRisk: false },
    { market: 'Next Supreme Court retirement in 2026?', yes: 0.33, no: 0.64, vol: 290000, liq: 85000, negRisk: false },
  ];
  return markets.map((m, i) => {
    const sum = m.yes + m.no, edge = Math.abs(1.0 - sum);
    const edgeScore = Math.min(edge / 0.05, 1.0), volScore = Math.min(m.vol / 500000, 1.0), liqScore = Math.min(m.liq / 100000, 1.0);
    const confidence = (edgeScore * 0.4 + volScore * 0.35 + liqScore * 0.25) * 100;
    return {
      id: crypto.randomUUID(), market: m.market,
      description: 'Demo market — connect Polymarket API for live data',
      edge: parseFloat((edge * 100).toFixed(3)), bestBid: m.yes, bestAsk: m.no,
      priceSum: parseFloat(sum.toFixed(4)), outcomes: ['Yes', 'No'], outcomePrices: [m.yes, m.no],
      volume: m.vol, liquidity: m.liq, confidence: parseFloat(confidence.toFixed(1)),
      link: 'https://polymarket.com', slug: '', negRisk: m.negRisk,
      conditionId: 'demo-' + i, endDate: null, daysToExpiry: null,
      updatedAt: new Date().toISOString(), demo: true, numOutcomes: 2,
    };
  }).sort((a, b) => b.edge - a.edge);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RISK ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function getRiskLimits() {
  return {
    maxExposurePerMarket: parseInt(process.env.MAX_EXPOSURE_PER_MARKET) || 500,
    dailyMaxExposure: parseInt(process.env.DAILY_MAX_EXPOSURE) || 2000,
    minEdgeThreshold: parseFloat(process.env.MIN_EDGE_THRESHOLD) || 0.02,
    minDepthUsdc: parseInt(process.env.MIN_DEPTH_USDC) || 100,
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS) || 20,
    cooldownMs: parseInt(process.env.TRADE_COOLDOWN_MS) || 30000,
  };
}

function checkRisk(agent, opportunity, action) {
  const reasons = [];
  const limits = getRiskLimits();
  const agentCfg = agent?.config || {};

  // Kill switch
  if (store.killSwitch) { reasons.push('KILL SWITCH ACTIVE — all trading halted'); return { allowed: false, reasons }; }

  // Agent mode check
  if (agentCfg.mode === 'OBSERVE') { reasons.push('Agent in OBSERVE mode'); return { allowed: false, reasons }; }

  // Per-trade max
  const perTradeMax = agentCfg.perTradeMax || limits.maxExposurePerMarket;
  if (action.size > perTradeMax) reasons.push(`Trade size $${action.size} exceeds per-trade max $${perTradeMax}`);

  // Per-market exposure
  const existingExposure = Object.values(store.founder.positions)
    .filter(p => p.marketId === opportunity.id)
    .reduce((s, p) => s + (p.recommendedSize || 0), 0);
  const perMarketMax = agentCfg.perMarketMax || limits.maxExposurePerMarket;
  if (existingExposure + action.size > perMarketMax)
    reasons.push(`Market exposure $${existingExposure + action.size} exceeds max $${perMarketMax}`);

  // Daily max
  const dailyMax = agentCfg.dailyMax || limits.dailyMaxExposure;
  if (store.founder.capitalDeployed + action.size > dailyMax)
    reasons.push(`Daily exposure $${store.founder.capitalDeployed + action.size} exceeds max $${dailyMax}`);

  // Min edge
  const minEdge = agentCfg.minEdgePct || (limits.minEdgeThreshold * 100);
  if (opportunity.edge < minEdge) reasons.push(`Edge ${opportunity.edge.toFixed(2)}% below min ${minEdge}%`);

  // Liquidity check
  if (opportunity.liquidity < limits.minDepthUsdc)
    reasons.push(`Liquidity $${opportunity.liquidity} below min $${limits.minDepthUsdc}`);

  // Max open positions
  const openCount = Object.keys(store.founder.positions).length;
  if (openCount >= limits.maxOpenPositions)
    reasons.push(`Open positions (${openCount}) at max (${limits.maxOpenPositions})`);

  // Budget check
  const budget = agentCfg.budgetUSDC || store.founder.fundSize;
  const agentDeployed = store.strategyOpportunities
    .filter(o => o.agentId === agent?.id && o.status === 'executed')
    .reduce((s, o) => s + (o.tradeSize || 0), 0);
  if (agentDeployed + action.size > budget)
    reasons.push(`Agent budget exhausted: $${agentDeployed + action.size} > $${budget}`);

  return { allowed: reasons.length === 0, reasons };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY RUNNERS
// ═══════════════════════════════════════════════════════════════════════════════

// ── S1: NegRisk Arbitrage Scanner ──
async function runNegRiskArb(agent) {
  const startTime = Date.now();
  try {
    const markets = store.marketCache.data.length > 0 ? store.marketCache.data : await fetchMarkets();
    const negRiskMarkets = markets.filter(m => m.negRisk || m.numOutcomes > 2);
    const minEdge = agent.config.minEdgePct || 0.5;
    const minLiquidity = agent.config.minLiquidity || 1000;

    const opportunities = negRiskMarkets.map(m => {
      const sumYes = m.outcomePrices ? m.outcomePrices.reduce((a, b) => a + b, 0) : (m.bestBid + m.bestAsk);
      const edgePct = sumYes < 1.0 ? (1.0 - sumYes) * 100 : sumYes > 1.0 ? (sumYes - 1.0) * 100 : 0;
      const direction = sumYes < 1.0 ? 'BUY_ALL_YES' : sumYes > 1.0 ? 'BUY_ALL_NO' : 'NONE';
      const depthScore = Math.min(m.liquidity / 10000, 1.0);
      const slippageEst = m.liquidity > 0 ? Math.max(0.1, 500 / m.liquidity * 100) : 99;
      const netEdge = Math.max(0, edgePct - slippageEst);
      const confidence = depthScore * 0.4 + Math.min(edgePct / 5, 1.0) * 0.3 + Math.min(m.volume / 1000000, 1.0) * 0.3;

      return {
        id: crypto.randomUUID(), agentId: agent.id, strategyType: 'negrisk_arb',
        marketId: m.id || m.conditionId, title: m.market,
        edgePct: parseFloat(edgePct.toFixed(3)), netEdge: parseFloat(netEdge.toFixed(3)),
        confidence: parseFloat((confidence * 100).toFixed(1)),
        liquidity: m.liquidity, volume24h: m.volume,
        action: edgePct >= minEdge && direction !== 'NONE' ? 'ARB_BASKET' : 'PASS',
        direction, sumYes: parseFloat(sumYes.toFixed(4)),
        numOutcomes: m.numOutcomes || m.outcomes?.length || 2,
        requiresApproval: true,
        depthScore: parseFloat((depthScore * 100).toFixed(0)),
        slippageEst: parseFloat(slippageEst.toFixed(2)),
        rationaleSummary: edgePct >= minEdge
          ? `${direction} arb: sum=${sumYes.toFixed(4)}, edge=${edgePct.toFixed(2)}%, net=${netEdge.toFixed(2)}% after slippage`
          : `Edge ${edgePct.toFixed(2)}% below threshold ${minEdge}%`,
        explain: {
          inputs: { sumYes, outcomes: m.outcomes, outcomePrices: m.outcomePrices, liquidity: m.liquidity, volume: m.volume },
          math: `sumYes = ${m.outcomePrices?.join(' + ') || `${m.bestBid} + ${m.bestAsk}`} = ${sumYes.toFixed(4)}; edge = |1.0 - ${sumYes.toFixed(4)}| * 100 = ${edgePct.toFixed(2)}%`,
          assumptions: ['Prices reflect best ask for each outcome', 'Slippage estimated from liquidity depth', 'Assumes simultaneous execution of all legs'],
          failureModes: ['Partial fill on one leg', 'Price movement during execution', 'Orderbook thin on one outcome', 'Fee structure unknown — may reduce edge'],
        },
        timestamp: new Date().toISOString(), status: 'new',
        link: m.link || 'https://polymarket.com',
      };
    }).filter(o => o.edgePct > 0).sort((a, b) => b.edgePct - a.edgePct);

    // Update agent stats
    agent.stats.scanned = negRiskMarkets.length;
    agent.stats.opportunities = opportunities.filter(o => o.action !== 'PASS').length;
    agent.health.lastRunAt = new Date().toISOString();
    agent.health.polymarketOk = true;

    // Push to approvals if qualifying
    opportunities.filter(o => o.action !== 'PASS').forEach(o => {
      if (!store.approvalsQueue.find(a => a.marketId === o.marketId && a.agentId === o.agentId && a.status === 'pending')) {
        store.approvalsQueue.push({
          id: crypto.randomUUID(), ts: new Date().toISOString(), agentId: agent.id,
          marketId: o.marketId, actionType: o.action, payload: o,
          rationale: o.rationaleSummary, risk: o.explain.failureModes.join('; '),
          expectedEdge: o.edgePct, status: 'pending',
        });
        agent.stats.approvalsPending++;
      }
    });

    audit('info', 'negrisk_arb_run', { scanned: negRiskMarkets.length, opportunities: opportunities.length, elapsed: Date.now() - startTime }, agent.id);
    markDirty();
    return opportunities;
  } catch (err) {
    agent.health.errors.push({ ts: new Date().toISOString(), msg: err.message });
    if (agent.health.errors.length > 20) agent.health.errors = agent.health.errors.slice(-10);
    audit('error', 'negrisk_arb_fail', { error: err.message }, agent.id);
    return [];
  }
}

// ── S2: LLM Probability Mispricing ──
async function runLLMProbability(agent) {
  const startTime = Date.now();
  try {
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 10;
    const hasOpenAI = !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 10;

    if (!hasAnthropic && !hasOpenAI) {
      agent.health.llmOk = false;
      agent.health.lastRunAt = new Date().toISOString();
      agent.health.errors.push({ ts: new Date().toISOString(), msg: 'No LLM API key configured (need ANTHROPIC_API_KEY or OPENAI_API_KEY)' });
      return [{ id: crypto.randomUUID(), agentId: agent.id, strategyType: 'llm_probability',
        title: 'LLM Module Disabled', action: 'DISABLED', requiresApproval: false,
        rationaleSummary: 'Missing API key: configure ANTHROPIC_API_KEY or OPENAI_API_KEY in Settings',
        explain: { inputs: {}, math: 'N/A', assumptions: [], failureModes: ['No LLM API key'] },
        timestamp: new Date().toISOString(), status: 'disabled' }];
    }

    // Select candidate markets: pinned first, then top volume
    const markets = store.marketCache.data.length > 0 ? store.marketCache.data : await fetchMarkets();
    const pinned = markets.filter(m => store.pinnedMarkets.includes(m.id));
    const topVol = markets.filter(m => !store.pinnedMarkets.includes(m.id)).sort((a, b) => b.volume - a.volume).slice(0, 5);
    const candidates = [...pinned, ...topVol].slice(0, 10);

    const opportunities = [];
    for (const m of candidates) {
      // Check LLM cache
      const cacheKey = m.id || m.conditionId;
      const cached = store.llmCache[cacheKey];
      const cacheTTL = (agent.config.llmCacheTTL || 30) * 60000;
      if (cached && (Date.now() - cached.timestamp) < cacheTTL) {
        opportunities.push(cached.opportunity);
        continue;
      }

      // Build prompt
      const brief = `Market: "${m.market}"\nDescription: ${m.description || 'N/A'}\nOutcomes: ${(m.outcomes || ['Yes','No']).join(', ')}\nCurrent YES price: ${m.bestBid}\nCurrent NO price: ${m.bestAsk}\nVolume 24h: $${m.volume}\nExpires: ${m.endDate || 'Unknown'}`;
      const systemPrompt = 'You are a prediction market analyst. Estimate the TRUE probability of the YES outcome. Be calibrated — account for base rates and known information. Respond in JSON only: {"probability": 0.XX, "confidence": 0.XX, "assumptions": ["..."], "sources": ["..."]}';

      let llmResult = null;
      try {
        if (hasAnthropic) {
          const resp = await httpPost('https://api.anthropic.com/v1/messages', {
            model: 'claude-sonnet-4-5-20250929', max_tokens: 500,
            system: systemPrompt,
            messages: [{ role: 'user', content: brief }],
          }, { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
          const text = resp.content?.[0]?.text || '';
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) llmResult = JSON.parse(jsonMatch[0]);
        } else if (hasOpenAI) {
          const resp = await httpPost('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini', max_tokens: 500,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: brief }],
          }, { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY });
          const text = resp.choices?.[0]?.message?.content || '';
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) llmResult = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.error('[llm] API error:', e.message);
        llmResult = null;
      }

      if (!llmResult) continue;

      const llmProb = parseFloat(llmResult.probability) || 0.5;
      const llmConf = parseFloat(llmResult.confidence) || 0.5;
      const marketProb = m.bestBid || 0.5;
      const edgePct = (llmProb - marketProb) * 100;
      const absEdge = Math.abs(edgePct);
      const side = edgePct > 0 ? 'BUY_YES' : edgePct < 0 ? 'BUY_NO' : 'PASS';

      const opp = {
        id: crypto.randomUUID(), agentId: agent.id, strategyType: 'llm_probability',
        marketId: cacheKey, title: m.market,
        edgePct: parseFloat(absEdge.toFixed(2)), confidence: parseFloat((llmConf * 100).toFixed(1)),
        liquidity: m.liquidity, volume24h: m.volume,
        action: absEdge >= (agent.config.minEdgePct || 2) ? side : 'PASS',
        requiresApproval: true,
        llmProbability: llmProb, marketProbability: marketProb, side,
        rationaleSummary: `LLM estimates ${(llmProb * 100).toFixed(0)}% vs market ${(marketProb * 100).toFixed(0)}% → ${absEdge.toFixed(1)}% edge ${side}`,
        explain: {
          inputs: { marketPrice: marketProb, llmEstimate: llmProb, confidence: llmConf, model: hasAnthropic ? 'claude-sonnet-4-5-20250929' : 'gpt-4o-mini' },
          math: `edgePct = (LLM ${llmProb.toFixed(3)} - Market ${marketProb.toFixed(3)}) * 100 = ${edgePct.toFixed(2)}%`,
          assumptions: llmResult.assumptions || ['LLM estimate based on training data', 'Market may have insider info'],
          failureModes: ['LLM miscalibration', 'Market has information LLM lacks', 'Resolution criteria ambiguity', 'Low confidence estimate'],
          sources: llmResult.sources || [],
          prompt: brief, rawResponse: llmResult,
        },
        timestamp: new Date().toISOString(), status: 'new',
        link: m.link || 'https://polymarket.com',
      };

      opportunities.push(opp);
      store.llmCache[cacheKey] = { opportunity: opp, timestamp: Date.now() };

      // Push to approvals if qualifying
      if (opp.action !== 'PASS') {
        store.approvalsQueue.push({
          id: crypto.randomUUID(), ts: new Date().toISOString(), agentId: agent.id,
          marketId: cacheKey, actionType: opp.action, payload: opp,
          rationale: opp.rationaleSummary, risk: 'LLM miscalibration; market may have superior info',
          expectedEdge: opp.edgePct, status: 'pending',
        });
        agent.stats.approvalsPending++;
      }
    }

    agent.stats.scanned = candidates.length;
    agent.stats.opportunities = opportunities.filter(o => o.action !== 'PASS' && o.action !== 'DISABLED').length;
    agent.health.lastRunAt = new Date().toISOString();
    agent.health.llmOk = true;

    audit('info', 'llm_probability_run', { candidates: candidates.length, opportunities: opportunities.length, elapsed: Date.now() - startTime }, agent.id);
    markDirty();
    return opportunities;
  } catch (err) {
    agent.health.errors.push({ ts: new Date().toISOString(), msg: err.message });
    audit('error', 'llm_probability_fail', { error: err.message }, agent.id);
    return [];
  }
}

// ── S3: Sentiment / Headlines ──
async function runSentimentHeadlines(agent) {
  const startTime = Date.now();
  try {
    const hasXAI = !!process.env.XAI_API_KEY && process.env.XAI_API_KEY.length > 5;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 10;

    if (store.headlines.length === 0) {
      agent.health.lastRunAt = new Date().toISOString();
      return [{
        id: crypto.randomUUID(), agentId: agent.id, strategyType: 'sentiment',
        title: 'Awaiting Headlines', action: 'WAITING', requiresApproval: false,
        rationaleSummary: 'Paste headlines in the Sentiment tab to analyze market impact',
        explain: { inputs: {}, math: 'N/A', assumptions: [], failureModes: ['No headlines provided'] },
        timestamp: new Date().toISOString(), status: 'waiting',
      }];
    }

    const recentHeadlines = store.headlines.slice(0, 20);
    const markets = store.marketCache.data.slice(0, 30);
    const marketList = markets.map(m => `- "${m.market}" (YES: ${m.bestBid}, Vol: $${m.volume})`).join('\n');

    const prompt = `Analyze these headlines for prediction market impact:\n\nHEADLINES:\n${recentHeadlines.map(h => `- ${h.text} [${h.source || 'unknown'}]`).join('\n')}\n\nACTIVE MARKETS:\n${marketList}\n\nFor each headline, respond in JSON array: [{"headline": "...", "impactedMarkets": ["market title"], "direction": "bullish_yes|bearish_yes|neutral", "confidence": 0.X, "rationale": "..."}]`;

    let results = [];
    try {
      if (hasXAI) {
        const resp = await httpPost('https://api.x.ai/v1/chat/completions', {
          model: 'grok-2-latest', max_tokens: 1500,
          messages: [{ role: 'system', content: 'You analyze news for prediction market impact. Respond in JSON only.' }, { role: 'user', content: prompt }],
        }, { 'Authorization': 'Bearer ' + process.env.XAI_API_KEY });
        const text = resp.choices?.[0]?.message?.content || '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) results = JSON.parse(jsonMatch[0]);
      } else if (hasAnthropic) {
        const resp = await httpPost('https://api.anthropic.com/v1/messages', {
          model: 'claude-sonnet-4-5-20250929', max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
        }, { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
        const text = resp.content?.[0]?.text || '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) results = JSON.parse(jsonMatch[0]);
      } else {
        // Simple keyword matching fallback
        const keywords = { trump: ['trump', 'president', 'election'], fed: ['fed', 'rate', 'interest', 'powell'], crypto: ['bitcoin', 'ethereum', 'crypto', 'btc'], war: ['ukraine', 'russia', 'ceasefire', 'war', 'israel'] };
        for (const h of recentHeadlines) {
          const lower = h.text.toLowerCase();
          for (const [topic, words] of Object.entries(keywords)) {
            if (words.some(w => lower.includes(w))) {
              const matched = markets.filter(m => words.some(w => m.market.toLowerCase().includes(w)));
              if (matched.length > 0) {
                results.push({ headline: h.text, impactedMarkets: matched.map(m => m.market).slice(0, 3), direction: 'neutral', confidence: 0.3, rationale: `Keyword match: ${topic}` });
              }
            }
          }
        }
      }
    } catch (e) { console.error('[sentiment] Analysis error:', e.message); }

    store.sentimentResults = results;
    const opportunities = results.map(r => ({
      id: crypto.randomUUID(), agentId: agent.id, strategyType: 'sentiment',
      title: r.headline?.slice(0, 100) || 'Unknown', marketId: null,
      impactedMarkets: r.impactedMarkets || [],
      direction: r.direction || 'neutral', edgePct: 0,
      confidence: parseFloat(((r.confidence || 0.5) * 100).toFixed(0)),
      action: 'OBSERVE', requiresApproval: false,
      rationaleSummary: r.rationale || 'Sentiment analysis',
      explain: {
        inputs: { headline: r.headline, source: hasXAI ? 'Grok' : hasAnthropic ? 'Claude' : 'keyword-match' },
        math: 'Qualitative sentiment analysis', assumptions: ['Headlines are accurate', 'Market hasn\'t priced in yet'],
        failureModes: ['Old news already priced in', 'Misinterpretation of headline', 'Market structure differs from sentiment'],
      },
      timestamp: new Date().toISOString(), status: 'new',
    }));

    agent.stats.scanned = recentHeadlines.length;
    agent.stats.opportunities = results.length;
    agent.health.lastRunAt = new Date().toISOString();

    audit('info', 'sentiment_run', { headlines: recentHeadlines.length, results: results.length, elapsed: Date.now() - startTime }, agent.id);
    markDirty();
    return opportunities;
  } catch (err) {
    agent.health.errors.push({ ts: new Date().toISOString(), msg: err.message });
    audit('error', 'sentiment_fail', { error: err.message }, agent.id);
    return [];
  }
}

// ── S4: Whale Pocket-Watching ──
async function runWhaleWatch(agent) {
  const startTime = Date.now();
  try {
    if (store.whaleWallets.length === 0) {
      agent.health.lastRunAt = new Date().toISOString();
      return [{
        id: crypto.randomUUID(), agentId: agent.id, strategyType: 'whale_watch',
        title: 'No Wallets Configured', action: 'WAITING', requiresApproval: false,
        rationaleSummary: 'Add whale wallet addresses in the Whale Watch tab to start tracking',
        explain: { inputs: {}, math: 'N/A', assumptions: [], failureModes: ['No wallets to watch'] },
        timestamp: new Date().toISOString(), status: 'waiting',
      }];
    }

    // Try Polymarket activity endpoint or use simulation
    const events = [];
    const markets = store.marketCache.data.slice(0, 50);

    for (const wallet of store.whaleWallets) {
      try {
        const gammaUrl = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
        const resp = await httpGet(`${gammaUrl}/activity?address=${wallet.address}&limit=10`);
        if (Array.isArray(resp)) {
          for (const act of resp) {
            events.push({
              id: crypto.randomUUID(), wallet: wallet.address, alias: wallet.alias || wallet.address.slice(0, 8),
              market: act.title || act.question || 'Unknown', side: act.side || 'unknown',
              size: parseFloat(act.size) || 0, price: parseFloat(act.price) || 0,
              timestamp: act.timestamp || new Date().toISOString(), source: 'polymarket_api',
            });
          }
        }
      } catch {
        // API may not support this — generate stub event
        if (markets.length > 0) {
          const randomMkt = markets[Math.floor(Math.random() * Math.min(5, markets.length))];
          events.push({
            id: crypto.randomUUID(), wallet: wallet.address, alias: wallet.alias || wallet.address.slice(0, 8),
            market: randomMkt.market, side: Math.random() > 0.5 ? 'YES' : 'NO',
            size: 0, price: 0, timestamp: new Date().toISOString(), source: 'stub',
          });
        }
      }
    }

    store.whaleEvents = [...events, ...store.whaleEvents].slice(0, 200);

    // Convergence detection: K whales on same market/side within T minutes
    const K = agent.config.convergenceThreshold || 2;
    const T = (agent.config.convergenceWindowMin || 60) * 60000;
    const recentEvents = store.whaleEvents.filter(e => Date.now() - new Date(e.timestamp).getTime() < T);
    const marketSideCounts = {};
    for (const e of recentEvents) {
      const key = `${e.market}::${e.side}`;
      if (!marketSideCounts[key]) marketSideCounts[key] = { market: e.market, side: e.side, wallets: new Set(), events: [] };
      marketSideCounts[key].wallets.add(e.wallet);
      marketSideCounts[key].events.push(e);
    }

    const convergenceAlerts = Object.values(marketSideCounts)
      .filter(g => g.wallets.size >= K)
      .map(g => ({
        id: crypto.randomUUID(), agentId: agent.id, strategyType: 'whale_watch',
        title: `CONVERGENCE: ${g.wallets.size} whales → ${g.market} (${g.side})`,
        marketId: null, edgePct: 0, confidence: Math.min(g.wallets.size * 30, 90),
        action: 'FOLLOW', requiresApproval: true,
        rationaleSummary: `${g.wallets.size} tracked wallets entered ${g.side} on "${g.market}" within ${agent.config.convergenceWindowMin || 60}min`,
        explain: {
          inputs: { wallets: [...g.wallets], side: g.side, market: g.market, eventCount: g.events.length },
          math: `convergence = ${g.wallets.size} unique wallets >= threshold ${K}`,
          assumptions: ['Whale activity indicates informed trading', 'Time window captures correlated activity'],
          failureModes: ['Whales may be hedging', 'Coincidental timing', 'Different position sizes'],
        },
        timestamp: new Date().toISOString(), status: 'new',
      }));

    // Push convergence alerts to approvals
    convergenceAlerts.forEach(a => {
      if (!store.approvalsQueue.find(q => q.rationale === a.rationaleSummary && q.status === 'pending')) {
        store.approvalsQueue.push({
          id: crypto.randomUUID(), ts: new Date().toISOString(), agentId: agent.id,
          marketId: a.marketId, actionType: 'FOLLOW', payload: a,
          rationale: a.rationaleSummary, risk: 'Whale herding may be misleading',
          expectedEdge: 0, status: 'pending',
        });
        agent.stats.approvalsPending++;
      }
    });

    agent.stats.scanned = store.whaleWallets.length;
    agent.stats.opportunities = convergenceAlerts.length;
    agent.health.lastRunAt = new Date().toISOString();

    audit('info', 'whale_watch_run', { wallets: store.whaleWallets.length, events: events.length, convergence: convergenceAlerts.length, elapsed: Date.now() - startTime }, agent.id);
    markDirty();
    return [...convergenceAlerts, ...events.slice(0, 10).map(e => ({
      id: e.id, agentId: agent.id, strategyType: 'whale_watch',
      title: `${e.alias}: ${e.side} on "${e.market}"`, action: 'INFO',
      requiresApproval: false, rationaleSummary: `Whale ${e.alias} traded ${e.side}${e.size ? ` $${e.size}` : ''}`,
      explain: { inputs: e, math: 'N/A', assumptions: [], failureModes: [] },
      timestamp: e.timestamp, status: 'info', source: e.source,
    }))];
  } catch (err) {
    agent.health.errors.push({ ts: new Date().toISOString(), msg: err.message });
    audit('error', 'whale_watch_fail', { error: err.message }, agent.id);
    return [];
  }
}

const STRATEGY_RUNNERS = {
  negrisk_arb: runNegRiskArb,
  llm_probability: runLLMProbability,
  sentiment: runSentimentHeadlines,
  whale_watch: runWhaleWatch,
};

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

function createAgent(config) {
  const agent = {
    id: crypto.randomUUID(), name: config.name || `Agent-${store.agents.length + 1}`,
    strategyType: config.strategyType || 'negrisk_arb',
    status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    config: {
      mode: config.mode || 'OBSERVE', budgetUSDC: config.budgetUSDC || 1000,
      perTradeMax: config.perTradeMax || 200, dailyMax: config.dailyMax || 500,
      minEdgePct: config.minEdgePct || 1.0, approvalMode: config.approvalMode || 'REQUIRE_ALL',
      allowLive: false, refreshSec: config.refreshSec || 60,
      marketsScope: config.marketsScope || 'all', latencyHint: config.latencyHint || 'normal',
      minLiquidity: config.minLiquidity || 1000, convergenceThreshold: config.convergenceThreshold || 2,
      convergenceWindowMin: config.convergenceWindowMin || 60, llmCacheTTL: config.llmCacheTTL || 30,
      perMarketMax: config.perMarketMax || 500,
    },
    health: { lastRunAt: null, errors: [], rpcOk: false, polymarketOk: false, llmOk: false },
    stats: { scanned: 0, opportunities: 0, approvalsPending: 0, executed: 0, pnlEst: 0 },
    lastOpportunities: [],
  };
  store.agents.push(agent);
  audit('info', 'agent_created', { name: agent.name, strategy: agent.strategyType }, agent.id);
  logActivity('system', `Agent "${agent.name}" created (${agent.strategyType})`);
  markDirty();
  return agent;
}

function updateAgent(id, updates) {
  const agent = store.agents.find(a => a.id === id);
  if (!agent) return null;
  if (updates.name) agent.name = updates.name;
  if (updates.status) agent.status = updates.status;
  if (updates.config) Object.assign(agent.config, updates.config);
  agent.updatedAt = new Date().toISOString();
  audit('info', 'agent_updated', updates, id);
  markDirty();
  return agent;
}

function deleteAgent(id) {
  const idx = store.agents.findIndex(a => a.id === id);
  if (idx === -1) return false;
  const agent = store.agents[idx];
  store.agents.splice(idx, 1);
  store.approvalsQueue = store.approvalsQueue.filter(a => a.agentId !== id);
  audit('info', 'agent_deleted', { name: agent.name }, id);
  logActivity('system', `Agent "${agent.name}" deleted`);
  markDirty();
  return true;
}

async function runAgent(agentId) {
  const agent = store.agents.find(a => a.id === agentId);
  if (!agent || agent.status !== 'running') return [];
  if (store.killSwitch) { agent.status = 'paused'; return []; }
  const runner = STRATEGY_RUNNERS[agent.strategyType];
  if (!runner) return [];
  const opps = await runner(agent);
  agent.lastOpportunities = opps;
  store.strategyOpportunities = store.strategyOpportunities.filter(o => o.agentId !== agentId);
  store.strategyOpportunities.push(...opps);
  return opps;
}

async function runAllAgents() {
  if (store.killSwitch) return;
  for (const agent of store.agents) {
    if (agent.status === 'running') {
      try { await runAgent(agent.id); } catch (e) { console.error(`[agent] ${agent.name} error:`, e.message); }
    }
  }
}

// Agent scheduler
let agentSchedulerInterval = null;
function startAgentScheduler() {
  if (agentSchedulerInterval) return;
  agentSchedulerInterval = setInterval(async () => {
    if (store.killSwitch) return;
    const now = Date.now();
    for (const agent of store.agents) {
      if (agent.status !== 'running') continue;
      const lastRun = agent.health.lastRunAt ? new Date(agent.health.lastRunAt).getTime() : 0;
      const interval = (agent.config.refreshSec || 60) * 1000;
      if (now - lastRun >= interval) {
        try { await runAgent(agent.id); } catch (e) { console.error(`[scheduler] ${agent.name}:`, e.message); }
      }
    }
  }, 10000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOB TRADE EXECUTION (Gated)
// ═══════════════════════════════════════════════════════════════════════════════

function canExecuteTrades() {
  const hasKeys = !!process.env.POLYMARKET_API_KEY && !!process.env.POLYMARKET_API_SECRET;
  const hasWallet = !!process.env.POLYMARKET_PRIVATE_KEY;
  const isLive = process.env.OBSERVATION_ONLY !== 'true';
  return { canTrade: hasKeys && hasWallet && isLive && !store.killSwitch,
    missing: [!hasKeys && 'CLOB API keys', !hasWallet && 'Wallet key', !isLive && 'Live mode not enabled', store.killSwitch && 'Kill switch active'].filter(Boolean) };
}

async function createClobOrder(params) {
  const { canTrade, missing } = canExecuteTrades();
  if (!canTrade) {
    audit('warn', 'trade_blocked', { missing, params });
    return { ok: false, error: 'Cannot trade: ' + missing.join(', '), simulated: false };
  }

  // Double-check with type-to-confirm for live trades
  if (!params._confirmed) {
    return { ok: false, error: 'Live trade requires confirmation (_confirmed: true)', needsConfirmation: true };
  }

  try {
    const clobUrl = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
    const order = {
      tokenID: params.tokenId, price: params.price, size: params.size,
      side: params.side, type: params.type || 'limit',
    };

    // In SIMULATE mode, don't actually place
    if (params.simulate) {
      audit('info', 'trade_simulated', order);
      logActivity('trade', `SIMULATED ${params.side} $${params.size} @ ${params.price}`);
      return { ok: true, simulated: true, order, message: 'Order simulated (not placed)' };
    }

    const resp = await httpPost(`${clobUrl}/order`, order, {
      'POLY-API-KEY': process.env.POLYMARKET_API_KEY,
      'POLY-SECRET': process.env.POLYMARKET_API_SECRET,
      'POLY-PASSPHRASE': process.env.POLYMARKET_API_PASSPHRASE || '',
    });

    audit('info', 'trade_executed', { order, response: resp });
    logActivity('trade', `EXECUTED ${params.side} $${params.size} @ ${params.price}`);
    return { ok: true, simulated: false, order, response: resp };
  } catch (err) {
    audit('error', 'trade_failed', { error: err.message, params });
    return { ok: false, error: err.message };
  }
}

async function cancelClobOrder(orderId) {
  const { canTrade, missing } = canExecuteTrades();
  if (!canTrade) return { ok: false, error: 'Cannot trade: ' + missing.join(', ') };
  try {
    const clobUrl = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
    const resp = await httpPost(`${clobUrl}/cancel`, { orderID: orderId }, {
      'POLY-API-KEY': process.env.POLYMARKET_API_KEY,
      'POLY-SECRET': process.env.POLYMARKET_API_SECRET,
    });
    audit('info', 'order_cancelled', { orderId, response: resp });
    return { ok: true, response: resp };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fetchOpenOrders() {
  try {
    const clobUrl = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
    const resp = await httpGet(`${clobUrl}/orders?isActive=true`);
    store.openOrders = Array.isArray(resp) ? resp : [];
    return store.openOrders;
  } catch { return store.openOrders; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELF-DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════════════════

async function runDiagnostics() {
  const results = {};

  // Polygon RPC
  results.polygonRpc = { status: 'unchecked', message: '' };
  if (process.env.POLYGON_RPC_URL) {
    try {
      const resp = await httpPost(process.env.POLYGON_RPC_URL, { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 });
      results.polygonRpc = resp.result ? { status: 'ok', message: 'Block: ' + parseInt(resp.result, 16) } : { status: 'error', message: 'Bad response' };
    } catch (e) { results.polygonRpc = { status: 'error', message: e.message }; }
  } else { results.polygonRpc = { status: 'missing', message: 'POLYGON_RPC_URL not set' }; }

  // Polymarket API
  results.polymarketApi = { status: 'unchecked', message: '' };
  try {
    const resp = await httpGet((process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com') + '/markets?limit=1');
    results.polymarketApi = Array.isArray(resp) ? { status: 'ok', message: 'Connected' } : { status: 'error', message: 'Unexpected response' };
  } catch (e) { results.polymarketApi = { status: 'error', message: e.message }; }

  // CLOB Auth
  results.clobAuth = { status: 'unchecked', message: '' };
  if (process.env.POLYMARKET_API_KEY) {
    results.clobAuth = { status: 'configured', message: 'Key present (auth not tested until first trade)' };
  } else { results.clobAuth = { status: 'missing', message: 'POLYMARKET_API_KEY not set' }; }

  // Wallet
  results.wallet = { status: 'unchecked', message: '' };
  if (process.env.POLYMARKET_PRIVATE_KEY) {
    const key = process.env.POLYMARKET_PRIVATE_KEY;
    const valid = /^(0x)?[0-9a-fA-F]{64}$/.test(key);
    results.wallet = valid ? { status: 'ok', message: 'Valid format (0x...)' } : { status: 'warning', message: 'Key present but format may be invalid' };
  } else { results.wallet = { status: 'missing', message: 'POLYMARKET_PRIVATE_KEY not set' }; }

  // LLM APIs
  results.anthropic = process.env.ANTHROPIC_API_KEY ? { status: 'configured', message: 'Key present' } : { status: 'missing', message: 'ANTHROPIC_API_KEY not set' };
  results.openai = process.env.OPENAI_API_KEY ? { status: 'configured', message: 'Key present' } : { status: 'missing', message: 'OPENAI_API_KEY not set' };
  results.xai = process.env.XAI_API_KEY ? { status: 'configured', message: 'Key present' } : { status: 'missing', message: 'XAI_API_KEY not set' };

  // USDC Balance (stub)
  results.usdcBalance = { status: 'unknown', message: 'Balance check not implemented — requires on-chain query' };

  store.diagnostics = { lastRun: new Date().toISOString(), results };
  audit('info', 'diagnostics_run', results);
  return results;
}

// ── Test Endpoints ──
async function testPolymarketAuth() {
  const start = Date.now();
  try {
    const gammaUrl = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
    const resp = await httpGet(`${gammaUrl}/markets?limit=1`);
    const latency = Date.now() - start;
    if (Array.isArray(resp) && resp.length > 0) {
      return { ok: true, latency, message: `Connected (${latency}ms) — ${resp[0].question?.slice(0, 60) || 'market data received'}` };
    }
    return { ok: false, latency, message: 'Unexpected response format' };
  } catch (e) { return { ok: false, latency: Date.now() - start, message: e.message }; }
}

async function testLLMApi(provider) {
  const start = Date.now();
  try {
    if (provider === 'anthropic' || (!provider && process.env.ANTHROPIC_API_KEY)) {
      if (!process.env.ANTHROPIC_API_KEY) return { ok: false, message: 'ANTHROPIC_API_KEY not set' };
      const resp = await httpPost('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-5-20250929', max_tokens: 20,
        messages: [{ role: 'user', content: 'Reply with just the word "pong"' }],
      }, { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
      const latency = Date.now() - start;
      const text = resp.content?.[0]?.text || '';
      if (resp.error) return { ok: false, latency, message: resp.error.message || 'API error', provider: 'anthropic' };
      return { ok: true, latency, message: `Anthropic OK (${latency}ms): "${text.slice(0, 30)}"`, provider: 'anthropic' };
    }
    if (provider === 'openai' || (!provider && process.env.OPENAI_API_KEY)) {
      if (!process.env.OPENAI_API_KEY) return { ok: false, message: 'OPENAI_API_KEY not set' };
      const resp = await httpPost('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini', max_tokens: 20,
        messages: [{ role: 'user', content: 'Reply with just the word "pong"' }],
      }, { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY });
      const latency = Date.now() - start;
      const text = resp.choices?.[0]?.message?.content || '';
      if (resp.error) return { ok: false, latency, message: resp.error.message || 'API error', provider: 'openai' };
      return { ok: true, latency, message: `OpenAI OK (${latency}ms): "${text.slice(0, 30)}"`, provider: 'openai' };
    }
    if (provider === 'xai' || (!provider && process.env.XAI_API_KEY)) {
      if (!process.env.XAI_API_KEY) return { ok: false, message: 'XAI_API_KEY not set' };
      const resp = await httpPost('https://api.x.ai/v1/chat/completions', {
        model: 'grok-2-latest', max_tokens: 20,
        messages: [{ role: 'user', content: 'Reply with just the word "pong"' }],
      }, { 'Authorization': 'Bearer ' + process.env.XAI_API_KEY });
      const latency = Date.now() - start;
      const text = resp.choices?.[0]?.message?.content || '';
      if (resp.error) return { ok: false, latency, message: resp.error.message || 'API error', provider: 'xai' };
      return { ok: true, latency, message: `xAI OK (${latency}ms): "${text.slice(0, 30)}"`, provider: 'xai' };
    }
    return { ok: false, message: 'No LLM API key configured' };
  } catch (e) { return { ok: false, latency: Date.now() - start, message: e.message }; }
}

async function testPolygonRpc() {
  const start = Date.now();
  if (!process.env.POLYGON_RPC_URL) return { ok: false, message: 'POLYGON_RPC_URL not set' };
  try {
    const resp = await httpPost(process.env.POLYGON_RPC_URL, { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 });
    const latency = Date.now() - start;
    if (resp.result) {
      const block = parseInt(resp.result, 16);
      return { ok: true, latency, message: `Connected (${latency}ms) — Block #${block.toLocaleString()}`, blockNumber: block };
    }
    return { ok: false, latency, message: resp.error?.message || 'Bad response' };
  } catch (e) { return { ok: false, latency: Date.now() - start, message: e.message }; }
}

async function testClobAuth() {
  const start = Date.now();
  if (!process.env.POLYMARKET_API_KEY) return { ok: false, message: 'POLYMARKET_API_KEY not set' };
  try {
    const clobUrl = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
    const resp = await httpGet(`${clobUrl}/time`);
    const latency = Date.now() - start;
    return { ok: true, latency, message: `CLOB reachable (${latency}ms)` };
  } catch (e) { return { ok: false, latency: Date.now() - start, message: e.message }; }
}

function getBlockersForStrategy(strategyType) {
  const d = store.diagnostics.results;
  const blockers = [];
  if (!d.polymarketApi || d.polymarketApi.status !== 'ok') blockers.push('Polymarket API not connected');
  if (strategyType === 'llm_probability') {
    if ((!d.anthropic || d.anthropic.status === 'missing') && (!d.openai || d.openai.status === 'missing'))
      blockers.push('No LLM API key (need ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  }
  if (strategyType === 'sentiment') {
    if (store.headlines.length === 0) blockers.push('No headlines pasted yet');
  }
  if (strategyType === 'whale_watch') {
    if (store.whaleWallets.length === 0) blockers.push('No whale wallets configured');
  }
  return blockers;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMANDER (Simple command parser)
// ═══════════════════════════════════════════════════════════════════════════════

async function parseCommand(text) {
  const cmd = text.trim().toLowerCase();
  store.commandHistory.push({ text, ts: new Date().toISOString() });

  if (cmd === 'help' || cmd === '?') {
    return { type: 'help', message: 'Commands: create agent <strategy>, list agents, status, set min edge <N>, kill switch on/off, run agent <name>, diagnostics, why is <strategy> disabled?' };
  }

  if (cmd === 'status') {
    const running = store.agents.filter(a => a.status === 'running').length;
    const pending = store.approvalsQueue.filter(a => a.status === 'pending').length;
    return { type: 'status', message: `Agents: ${store.agents.length} (${running} running) | Pending approvals: ${pending} | Kill switch: ${store.killSwitch ? 'ON' : 'OFF'} | Markets cached: ${store.marketCache.data.length}` };
  }

  if (cmd === 'list agents') {
    return { type: 'list', message: store.agents.length === 0 ? 'No agents created yet.' : store.agents.map(a => `- ${a.name} [${a.strategyType}] ${a.status} | scanned: ${a.stats.scanned} | opps: ${a.stats.opportunities}`).join('\n') };
  }

  if (cmd.startsWith('create agent')) {
    const strategies = ['negrisk_arb', 'llm_probability', 'sentiment', 'whale_watch'];
    const parts = cmd.split(/\s+/);
    let strategy = parts[2] || '';
    if (!strategies.includes(strategy)) {
      const match = strategies.find(s => s.includes(strategy));
      strategy = match || 'negrisk_arb';
    }
    const agent = createAgent({ strategyType: strategy, name: `${strategy}-${Date.now().toString(36)}` });
    return { type: 'created', message: `Created agent "${agent.name}" (${strategy}) in OBSERVE mode. ID: ${agent.id}` };
  }

  if (cmd.startsWith('set min edge')) {
    const n = parseFloat(cmd.replace('set min edge', '').trim());
    if (isNaN(n)) return { type: 'error', message: 'Usage: set min edge <number>' };
    store.agents.forEach(a => { a.config.minEdgePct = n; });
    return { type: 'config', message: `Set min edge to ${n}% for all agents` };
  }

  if (cmd === 'kill switch on') {
    store.killSwitch = true; markDirty();
    store.agents.forEach(a => { a.status = 'paused'; });
    audit('warn', 'kill_switch_on', {});
    logActivity('system', 'KILL SWITCH ACTIVATED');
    return { type: 'kill', message: 'KILL SWITCH ON — All agents paused, trading halted.' };
  }

  if (cmd === 'kill switch off') {
    store.killSwitch = false; markDirty();
    audit('info', 'kill_switch_off', {});
    logActivity('system', 'Kill switch deactivated');
    return { type: 'kill', message: 'Kill switch OFF — Agents can resume.' };
  }

  if (cmd === 'diagnostics' || cmd === 'diag') {
    await runDiagnostics();
    const d = store.diagnostics.results;
    const lines = Object.entries(d).map(([k, v]) => `  ${k}: ${v.status} — ${v.message}`);
    return { type: 'diagnostics', message: 'Diagnostics:\n' + lines.join('\n') };
  }

  if (cmd.startsWith('run agent')) {
    const name = cmd.replace('run agent', '').trim();
    const agent = store.agents.find(a => a.name.toLowerCase().includes(name) || a.id === name);
    if (!agent) return { type: 'error', message: 'Agent not found: ' + name };
    const opps = await runAgent(agent.id);
    return { type: 'run', message: `Ran ${agent.name}: ${opps.length} opportunities found` };
  }

  // Fallback: try LLM if available
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const resp = await httpPost('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-5-20250929', max_tokens: 300,
        system: 'You are ZVI, a fund OS assistant. Parse user commands into agent configuration. Respond concisely. Available strategies: negrisk_arb, llm_probability, sentiment, whale_watch.',
        messages: [{ role: 'user', content: text }],
      }, { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
      return { type: 'llm', message: resp.content?.[0]?.text || 'No response from LLM' };
    } catch { /* fall through */ }
  }

  return { type: 'unknown', message: `Unknown command: "${text}". Type "help" for commands.` };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG, BLOCKERS, SYSTEM STATUS
// ═══════════════════════════════════════════════════════════════════════════════

function getConfig() {
  return {
    mode: process.env.OBSERVATION_ONLY === 'true' ? 'OBSERVATION_ONLY' : 'LIVE',
    autoExec: process.env.AUTO_EXEC === 'true',
    killSwitch: store.killSwitch,
    manualApproval: process.env.MANUAL_APPROVAL_REQUIRED !== 'false',
    secrets: {
      polygonRpc: !!process.env.POLYGON_RPC_URL,
      anthropicKey: !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 10,
      polymarketGamma: !!process.env.POLYMARKET_GAMMA_URL || true, // default URL works
      polymarketClob: !!process.env.POLYMARKET_API_KEY,
      polymarketPrivateKey: !!process.env.POLYMARKET_PRIVATE_KEY,
      openaiKey: !!process.env.OPENAI_API_KEY,
      xaiKey: !!process.env.XAI_API_KEY,
      telegram: !!process.env.TELEGRAM_BOT_TOKEN,
    },
    riskLimits: getRiskLimits(),
  };
}

function checkThresholds(symbol, price) {
  const triggered = [];
  for (const t of store.thresholds) {
    const hit = (t.direction === 'above' && price >= t.thresholdPrice) || (t.direction === 'below' && price <= t.thresholdPrice);
    if (hit && t.symbol === symbol) {
      const signal = {
        id: crypto.randomUUID(), symbol: t.symbol, price,
        threshold: t.thresholdPrice, direction: t.direction,
        triggeredAt: new Date().toISOString(),
        brief: `Signal: ${t.symbol} crossed ${t.direction} ${t.thresholdPrice}. Current: ${price}.`,
      };
      store.signals.push(signal);
      triggered.push(signal);
    }
  }
  store.agentHeartbeats.signalEngine.lastSeen = Date.now();
  return triggered;
}

function getBlockers() {
  const cfg = getConfig();
  const blockers = [];
  const missingApi = [];
  if (!process.env.POLYMARKET_API_KEY) missingApi.push('POLYMARKET_API_KEY');
  if (!process.env.POLYMARKET_API_SECRET) missingApi.push('POLYMARKET_API_SECRET');
  if (!process.env.POLYMARKET_API_PASSPHRASE) missingApi.push('POLYMARKET_API_PASSPHRASE');

  blockers.push({
    id: 'api-keys', priority: 1, title: 'Connect API Keys',
    desc: 'Polymarket CLOB + LLM keys for strategies.',
    status: missingApi.length === 0 ? 'done' : 'blocked', missing: missingApi,
    action: 'Add keys in Settings', category: 'critical',
  });

  const hasWallet = !!process.env.POLYMARKET_PRIVATE_KEY;
  blockers.push({
    id: 'wallet', priority: 2, title: 'Connect Wallet',
    desc: 'Private key for signing Polygon transactions.',
    status: hasWallet ? 'done' : 'blocked', missing: hasWallet ? [] : ['POLYMARKET_PRIVATE_KEY'],
    action: 'Add POLYMARKET_PRIVATE_KEY', category: 'critical',
  });

  blockers.push({
    id: 'capital', priority: 3, title: 'Fund Capital',
    desc: 'USDC allocation: $' + store.founder.fundSize.toLocaleString(),
    status: store.founder.capitalAllocated ? 'done' : 'action-needed', missing: [],
    action: 'Set fund size and confirm', category: 'setup', interactive: true,
    fundSize: store.founder.fundSize,
  });

  blockers.push({
    id: 'risks', priority: 4, title: 'Approve Risk Limits',
    desc: 'Max/market: $' + cfg.riskLimits.maxExposurePerMarket + ' | Daily: $' + cfg.riskLimits.dailyMaxExposure,
    status: store.founder.risksApproved ? 'done' : 'action-needed', missing: [],
    action: 'Review and approve', category: 'setup', interactive: true,
    limits: cfg.riskLimits,
  });

  const prevDone = blockers.every(b => b.status === 'done');
  const pending = store.approvalsQueue.filter(a => a.status === 'pending').length;
  blockers.push({
    id: 'trade', priority: 5, title: 'Approvals / Decisions',
    desc: prevDone ? `${pending} pending approvals. ${Object.keys(store.founder.decisions).length} decisions made.` : 'Complete steps above first.',
    status: prevDone ? 'ready' : 'locked', missing: [], action: 'Review approvals',
    category: 'trade', pendingApprovals: pending,
  });

  const currentStep = blockers.findIndex(b => b.status !== 'done');
  return {
    blockers, currentStep: currentStep === -1 ? blockers.length : currentStep + 1,
    totalSteps: blockers.length, allClear: prevDone,
    founder: { fundSize: store.founder.fundSize, capitalAllocated: store.founder.capitalAllocated,
      risksApproved: store.founder.risksApproved, capitalDeployed: store.founder.capitalDeployed,
      decisions: store.founder.decisions },
  };
}

function recommendPosition(opp) {
  const fundSize = store.founder.fundSize;
  const maxPer = parseInt(process.env.MAX_EXPOSURE_PER_MARKET) || 500;
  const edgeFrac = opp.edge / 100, confFrac = opp.confidence / 100;
  const kellySize = Math.round(edgeFrac * confFrac * fundSize * 0.25);
  const size = Math.min(Math.max(kellySize, 10), maxPer);
  return { size, pctOfFund: ((size / fundSize) * 100).toFixed(1), maxPerMarket: maxPer };
}

function getSystemStatus() {
  const cfg = getConfig();
  const uptime = Math.round((Date.now() - STARTUP_TIME) / 1000);
  return {
    uptime,
    uptimeFormatted: uptime > 3600 ? Math.floor(uptime / 3600) + 'h ' + Math.floor((uptime % 3600) / 60) + 'm' : uptime > 60 ? Math.floor(uptime / 60) + 'm ' + (uptime % 60) + 's' : uptime + 's',
    mode: cfg.mode, totalScans: store.totalScans, totalMarketsScanned: store.totalMarketsScanned,
    marketsInCache: store.marketCache.data.length,
    dataSource: store.agentHeartbeats.scanner.status === 'demo' ? 'demo' : 'live',
    secrets: cfg.secrets, riskLimits: cfg.riskLimits, settings: store.settings,
    killSwitch: store.killSwitch, agentsCount: store.agents.length,
    pendingApprovals: store.approvalsQueue.filter(a => a.status === 'pending').length,
    founder: {
      capitalAllocated: store.founder.capitalAllocated, fundSize: store.founder.fundSize,
      risksApproved: store.founder.risksApproved, capitalDeployed: store.founder.capitalDeployed,
      totalDecisions: Object.keys(store.founder.decisions).length,
      buys: Object.values(store.founder.decisions).filter(d => d.verdict === 'BUY').length,
      passes: Object.values(store.founder.decisions).filter(d => d.verdict === 'PASS').length,
    },
    agents: store.agentHeartbeats, activityCount: activityLog.length,
    diagnostics: store.diagnostics,
  };
}

// ── System Report Generator ──
function generateSystemReport() {
  const cfg = getConfig();
  const blockers = getBlockers();
  const status = getSystemStatus();
  const report = { generated: new Date().toISOString(), sections: [] };

  // Connections
  const connItems = [];
  connItems.push({ name: 'Polymarket Gamma API', status: store.diagnostics.results?.polymarketApi?.status || 'unchecked', detail: store.diagnostics.results?.polymarketApi?.message || 'Run diagnostics' });
  connItems.push({ name: 'CLOB Auth', status: cfg.secrets.polymarketClob ? 'configured' : 'missing', detail: cfg.secrets.polymarketClob ? 'Key present' : 'POLYMARKET_API_KEY not set' });
  connItems.push({ name: 'Wallet', status: cfg.secrets.polymarketPrivateKey ? 'configured' : 'missing', detail: cfg.secrets.polymarketPrivateKey ? 'Key present' : 'POLYMARKET_PRIVATE_KEY not set' });
  connItems.push({ name: 'Polygon RPC', status: cfg.secrets.polygonRpc ? 'configured' : 'missing', detail: store.diagnostics.results?.polygonRpc?.message || 'Not tested' });
  connItems.push({ name: 'Anthropic', status: cfg.secrets.anthropicKey ? 'configured' : 'missing', detail: cfg.secrets.anthropicKey ? 'Key present' : 'Not set' });
  connItems.push({ name: 'xAI', status: cfg.secrets.xaiKey ? 'configured' : 'missing', detail: cfg.secrets.xaiKey ? 'Key present' : 'Not set' });
  report.sections.push({ title: 'Connections', items: connItems });

  // Running agents
  const agentItems = store.agents.map(a => ({
    name: `${a.name} (${a.strategyType})`, status: a.status,
    detail: `Scanned: ${a.stats.scanned} | Opps: ${a.stats.opportunities} | Last: ${a.health.lastRunAt ? new Date(a.health.lastRunAt).toLocaleTimeString() : 'never'}`,
  }));
  if (agentItems.length === 0) agentItems.push({ name: 'No agents', status: 'missing', detail: 'Create agents in the Agents tab' });
  report.sections.push({ title: 'Agents', items: agentItems });

  // Last scan
  const scanItems = [];
  const cache = store.marketCache;
  scanItems.push({ name: 'Markets cached', status: cache.data.length > 0 ? 'ok' : 'empty', detail: `${cache.data.length} markets, fetched ${cache.fetchedAt ? Math.round((Date.now() - cache.fetchedAt) / 1000) + 's ago' : 'never'}` });
  scanItems.push({ name: 'Data source', status: status.dataSource === 'live' ? 'ok' : 'demo', detail: status.dataSource === 'live' ? 'Live Polymarket data' : 'Demo/fallback data' });
  scanItems.push({ name: 'Total scans', status: 'info', detail: store.totalScans.toString() });
  const highEdge = cache.data.filter(m => m.edge > 1).length;
  scanItems.push({ name: 'High-edge opportunities', status: highEdge > 0 ? 'ok' : 'info', detail: `${highEdge} markets with >1% edge` });
  report.sections.push({ title: 'Last Scan', items: scanItems });

  // Top blockers
  const topBlockers = [];
  if (!cfg.secrets.polymarketClob) topBlockers.push({ name: 'Add Polymarket CLOB API keys', status: 'blocked', detail: 'Required for live trading' });
  if (!cfg.secrets.polymarketPrivateKey) topBlockers.push({ name: 'Connect wallet private key', status: 'blocked', detail: 'Required for signing transactions' });
  if (!store.founder.capitalAllocated) topBlockers.push({ name: 'Set fund capital allocation', status: 'action', detail: 'Confirm how much USDC to allocate' });
  if (!store.founder.risksApproved) topBlockers.push({ name: 'Approve risk limits', status: 'action', detail: 'Review and approve position limits' });
  if (store.agents.length === 0) topBlockers.push({ name: 'Create strategy agents', status: 'action', detail: 'Deploy at least one agent to start scanning' });
  if (!cfg.secrets.anthropicKey && !cfg.secrets.openaiKey) topBlockers.push({ name: 'Add LLM API key', status: 'info', detail: 'Needed for LLM Probability and Sentiment strategies' });
  report.sections.push({ title: 'Top Blockers', items: topBlockers.slice(0, 5) });

  return report;
}

// ── Founder Console Chat ──
async function founderConsoleChat(question) {
  const q = question.toLowerCase().trim();
  const cfg = getConfig();
  const status = getSystemStatus();

  // Deterministic answers for common questions
  if (q.includes('what') && q.includes('missing')) {
    const missing = [];
    if (!cfg.secrets.polymarketClob) missing.push('Polymarket CLOB API keys (POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE)');
    if (!cfg.secrets.polymarketPrivateKey) missing.push('Wallet private key (POLYMARKET_PRIVATE_KEY)');
    if (!cfg.secrets.polygonRpc) missing.push('Polygon RPC URL (POLYGON_RPC_URL)');
    if (!cfg.secrets.anthropicKey && !cfg.secrets.openaiKey) missing.push('LLM API key (ANTHROPIC_API_KEY or OPENAI_API_KEY)');
    if (!store.founder.capitalAllocated) missing.push('Capital allocation (set in Action Queue step 3)');
    if (!store.founder.risksApproved) missing.push('Risk limits approval (Action Queue step 4)');
    return { answer: missing.length > 0 ? `Missing items:\n${missing.map((m, i) => `${i + 1}. ${m}`).join('\n')}` : 'All prerequisites are configured! You\'re ready to trade.', source: 'system' };
  }

  if (q.includes('negrisk') || q.includes('neg risk') || q.includes('neg-risk')) {
    const blockers = getBlockersForStrategy('negrisk_arb');
    const agents = store.agents.filter(a => a.strategyType === 'negrisk_arb');
    const nr = store.marketCache.data.filter(m => m.negRisk);
    return { answer: `NegRisk Arbitrage Status:\n- ${agents.length} agent(s) running\n- ${nr.length} NegRisk markets in cache\n- Blockers: ${blockers.length > 0 ? blockers.join('; ') : 'None'}\n\nThis strategy identifies multi-outcome markets where the sum of outcome prices deviates from 1.0, creating arbitrage opportunities.${agents.length === 0 ? '\n\nAction: Create a NegRisk agent in the Agents tab to start scanning.' : ''}`, source: 'system' };
  }

  if (q.includes('llm') || q.includes('probability') || q.includes('mispricing')) {
    const blockers = getBlockersForStrategy('llm_probability');
    const agents = store.agents.filter(a => a.strategyType === 'llm_probability');
    return { answer: `LLM Probability Status:\n- ${agents.length} agent(s) running\n- LLM available: ${cfg.secrets.anthropicKey ? 'Anthropic' : cfg.secrets.openaiKey ? 'OpenAI' : 'NONE'}\n- Blockers: ${blockers.length > 0 ? blockers.join('; ') : 'None'}\n\nThis strategy asks LLMs to estimate true probabilities and compares to market prices.${!cfg.secrets.anthropicKey && !cfg.secrets.openaiKey ? '\n\nAction: Add ANTHROPIC_API_KEY or OPENAI_API_KEY in Settings.' : ''}`, source: 'system' };
  }

  if (q.includes('sentiment') || q.includes('headline')) {
    const agents = store.agents.filter(a => a.strategyType === 'sentiment');
    return { answer: `Sentiment Analysis Status:\n- ${agents.length} agent(s)\n- Headlines loaded: ${store.headlines.length}\n- LLM for analysis: ${cfg.secrets.xaiKey ? 'xAI/Grok' : cfg.secrets.anthropicKey ? 'Anthropic' : 'Keyword matching (no LLM key)'}\n\nPaste headlines in the Sentiment tab to analyze market impact.`, source: 'system' };
  }

  if (q.includes('whale')) {
    return { answer: `Whale Watch Status:\n- Tracked wallets: ${store.whaleWallets.length}\n- Events logged: ${store.whaleEvents.length}\n- ${store.whaleWallets.length === 0 ? 'Add wallet addresses in the Whale Watch tab to start tracking.' : 'Monitoring ' + store.whaleWallets.map(w => w.alias).join(', ')}`, source: 'system' };
  }

  if (q.includes('status') || q.includes('summary') || q.includes('overview')) {
    return { answer: `System Status:\n- Uptime: ${status.uptimeFormatted}\n- Mode: ${status.mode}\n- Data: ${status.dataSource}\n- Markets: ${status.marketsInCache}\n- Agents: ${status.agentsCount} (${store.agents.filter(a => a.status === 'running').length} running)\n- Pending approvals: ${status.pendingApprovals}\n- Kill switch: ${status.killSwitch ? 'ON' : 'OFF'}\n- Fund: $${status.founder.fundSize.toLocaleString()} (deployed: $${status.founder.capitalDeployed.toLocaleString()})`, source: 'system' };
  }

  if (q.includes('no opportunities') || q.includes('no opps') || q.includes('why are no')) {
    const reasons = [];
    if (status.dataSource === 'demo') reasons.push('Using demo data — Polymarket API may be unreachable');
    if (store.agents.length === 0) reasons.push('No agents created — create agents to scan for opportunities');
    if (store.agents.every(a => a.status === 'paused')) reasons.push('All agents are paused');
    if (store.killSwitch) reasons.push('Kill switch is ON — all agents halted');
    if (store.totalScans === 0) reasons.push('No scans completed yet — wait for first scan cycle');
    return { answer: reasons.length > 0 ? `Possible reasons:\n${reasons.map((r, i) => `${i + 1}. ${r}`).join('\n')}` : 'Agents are running and scanning. Opportunities appear when edge > minEdge threshold. Try lowering the min edge in agent config or wait for market conditions to change.', source: 'system' };
  }

  if (q === 'help' || q === '?') {
    return { answer: 'Ask me about:\n- "What\'s missing?" — see unfilled prerequisites\n- "NegRisk status" — NegRisk arb strategy details\n- "LLM status" — LLM probability strategy details\n- "Why are no opportunities showing?" — debug empty results\n- "System status" — overall system summary\n- "Last scan" — latest scan results\n- Or any question about the system state', source: 'system' };
  }

  if (q.includes('last scan') || q.includes('scan result')) {
    const cache = store.marketCache;
    const highEdge = cache.data.filter(m => m.edge > 1);
    return { answer: `Last Scan:\n- ${cache.data.length} markets cached\n- Source: ${status.dataSource}\n- Fetched: ${cache.fetchedAt ? Math.round((Date.now() - cache.fetchedAt) / 1000) + 's ago' : 'never'}\n- High-edge (>1%): ${highEdge.length}\n- Top 3:${highEdge.slice(0, 3).map(m => `\n  - ${m.market.slice(0, 50)}: ${m.edge.toFixed(2)}%`).join('') || '\n  (none)'}`, source: 'system' };
  }

  // If LLM available, use it for unknown questions
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const ctx = `System status: ${JSON.stringify({ mode: status.mode, uptime: status.uptimeFormatted, agents: status.agentsCount, markets: status.marketsInCache, killSwitch: status.killSwitch, dataSource: status.dataSource, pendingApprovals: status.pendingApprovals, secrets: cfg.secrets, founder: status.founder })}`;
      const resp = await httpPost('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-5-20250929', max_tokens: 300,
        system: 'You are ZVI, a fund operating system assistant. Answer the founder\'s question about the system using the provided runtime state. Be concise and actionable. Current state: ' + ctx,
        messages: [{ role: 'user', content: question }],
      }, { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
      return { answer: resp.content?.[0]?.text || 'No response', source: 'llm' };
    } catch (e) { return { answer: `LLM unavailable: ${e.message}\n\nType "help" for built-in questions.`, source: 'error' }; }
  }

  return { answer: `I don't have enough context for that question. Try:\n- "What's missing?"\n- "System status"\n- "NegRisk status"\n- "Why are no opportunities showing?"\n- "help" for full list`, source: 'system' };
}

// ── .env.local updater ──
function updateEnvFile(updates) {
  const ALLOWED = new Set([
    'POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE',
    'POLYMARKET_PRIVATE_KEY', 'POLYMARKET_GAMMA_URL', 'POLYMARKET_CLOB_URL',
    'POLYGON_RPC_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY',
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'WEBHOOK_URL',
    'MAX_EXPOSURE_PER_MARKET', 'DAILY_MAX_EXPOSURE', 'MIN_EDGE_THRESHOLD', 'MIN_DEPTH_USDC',
    'OBSERVATION_ONLY', 'MANUAL_APPROVAL_REQUIRED', 'AUTO_EXEC', 'KILL_SWITCH',
  ]);
  const filtered = {};
  for (const [k, v] of Object.entries(updates)) { if (ALLOWED.has(k)) filtered[k] = v; }
  if (Object.keys(filtered).length === 0) return { ok: false, error: 'No valid keys' };
  try {
    let content = '';
    try { content = fs.readFileSync(ENV_PATH, 'utf-8'); } catch { content = ''; }
    for (const [k, v] of Object.entries(filtered)) {
      const re = new RegExp('^' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=.*$', 'm');
      if (re.test(content)) content = content.replace(re, k + '=' + v);
      else content += '\n' + k + '=' + v;
      process.env[k] = v;
    }
    fs.writeFileSync(ENV_PATH, content, 'utf-8');
    logActivity('config', 'Updated .env.local: ' + Object.keys(filtered).join(', '));
    return { ok: true, updated: Object.keys(filtered) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function jsonResp(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD HTML
// ═══════════════════════════════════════════════════════════════════════════════

function redactKey(val) {
  if (!val || val.length < 8) return val ? '***' : '';
  return val.slice(0, 4) + '...' + val.slice(-4);
}

function dashboardHTML() {
  const cfg = getConfig();
  const initialBlockers = getBlockers();
  const initialOpps = getDemoOpportunities();
  const initialReport = generateSystemReport();
  const EMBEDDED = JSON.stringify({ blockers: initialBlockers, opportunities: initialOpps, agents: store.agents, approvals: store.approvalsQueue.filter(a => a.status === 'pending'), killSwitch: store.killSwitch, report: initialReport }).replace(/<\//g, '<\\/');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZVI v1 — Fund Operating System</title>
<style>
:root{--bg0:#0a0a0f;--bg1:#0f0f18;--bg2:#12121a;--bg3:#1a1a2e;--bd:#2a2a3e;--bd2:#3b3b55;--t1:#e4e4ef;--t2:#8888a0;--t3:#5a5a72;--blue:#6366f1;--cyan:#06b6d4;--green:#22c55e;--yellow:#eab308;--red:#ef4444;--purple:#8b5cf6;--mono:'SF Mono','Fira Code','JetBrains Mono',monospace;--sans:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif}
body.hexa-light{--bg0:#faf9f6;--bg1:#ffffff;--bg2:#f5f3ef;--bg3:#ebe8e2;--bd:#d4d0c8;--bd2:#c5c0b6;--t1:#1a1a1a;--t2:#555550;--t3:#8a8680;--blue:#2d6a4f;--cyan:#2d6a4f;--green:#2d6a4f;--yellow:#b8860b;--red:#c0392b;--purple:#6a4c93}
body.hexa-light .topbar{background:linear-gradient(180deg,#f5f3ef,#ffffff);border-bottom-color:var(--bd)}
body.hexa-light .logo{background:linear-gradient(135deg,#2d6a4f,#40916c);-webkit-background-clip:text}
body.hexa-light .tabs{background:#fff}
body.hexa-light .tab.active{color:#2d6a4f;border-bottom-color:#2d6a4f}
body.hexa-light .aq{background:linear-gradient(180deg,rgba(45,106,79,.04),transparent)}
body.hexa-light .commander{background:#fff}
body.hexa-light ::-webkit-scrollbar-track{background:#faf9f6}
body.hexa-light ::-webkit-scrollbar-thumb{background:#d4d0c8}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg0);color:var(--t1);font-family:var(--sans);font-size:14px;line-height:1.5;overflow-x:hidden}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:var(--bg0)}::-webkit-scrollbar-thumb{background:var(--bd);border-radius:3px}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:56px;background:linear-gradient(180deg,#111c30,var(--bg1));border-bottom:1px solid var(--bd);position:sticky;top:0;z-index:100}
.topbar-left{display:flex;align-items:center;gap:16px}
.logo{font-family:var(--mono);font-size:16px;font-weight:700;background:linear-gradient(135deg,var(--blue),var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.logo-sub{font-size:11px;color:var(--t3);font-family:var(--mono);letter-spacing:1px;text-transform:uppercase}
.topbar-right{display:flex;align-items:center;gap:12px}
.mode-badge{padding:4px 12px;border-radius:4px;font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase}
.mode-obs{background:rgba(245,158,11,.15);color:var(--yellow);border:1px solid rgba(245,158,11,.3)}
.mode-live{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{border-color:rgba(239,68,68,.3)}50%{border-color:rgba(239,68,68,.7)}}
.secret-badges{display:flex;gap:6px}
.secret-badge{display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:3px;font-size:10px;font-family:var(--mono);background:var(--bg2);border:1px solid var(--bd)}
.dot{width:6px;height:6px;border-radius:50%}.dot-g{background:var(--green);box-shadow:0 0 4px var(--green)}.dot-r{background:var(--red);box-shadow:0 0 4px var(--red)}
.kill-btn{padding:4px 10px;border-radius:4px;font-family:var(--mono);font-size:10px;font-weight:700;cursor:pointer;border:1px solid rgba(239,68,68,.4);background:rgba(239,68,68,.1);color:var(--red);transition:all .15s}
.kill-btn:hover{background:rgba(239,68,68,.3)}.kill-btn.active{background:var(--red);color:#fff}
.tabs{display:flex;gap:0;padding:0 24px;background:var(--bg1);border-bottom:1px solid var(--bd);overflow-x:auto}
.tab{padding:12px 16px;font-size:12px;font-weight:500;color:var(--t2);cursor:pointer;border-bottom:2px solid transparent;transition:all .2s;user-select:none;white-space:nowrap}
.tab:hover{color:var(--t1);background:rgba(255,255,255,.02)}.tab.active{color:var(--cyan);border-bottom-color:var(--cyan)}
.tab .cnt{display:inline-block;margin-left:5px;padding:1px 5px;border-radius:8px;font-size:9px;font-family:var(--mono);background:var(--bg2);color:var(--t3);min-width:16px;text-align:center}
.tab.active .cnt{background:rgba(6,182,212,.15);color:var(--cyan)}
.content{padding:20px 24px}.panel{display:none}.panel.active{display:block}
.aq{padding:14px 24px;background:linear-gradient(180deg,rgba(99,102,241,.04),transparent);border-bottom:1px solid var(--bd)}
.aq-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.aq-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--blue);font-family:var(--mono)}
.aq-progress{font-family:var(--mono);font-size:11px;color:var(--t3)}
.aq-steps{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}
.aq-step{flex:1;min-width:160px;padding:10px 12px;border:1px solid var(--bd);border-radius:8px;cursor:pointer;transition:all .2s}
.aq-step:hover:not(.step-locked){border-color:var(--cyan)}
.step-blocked{border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.04)}
.step-current{border-color:var(--blue);background:rgba(99,102,241,.06);box-shadow:0 0 20px rgba(99,102,241,.08)}
.step-done{border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.04);opacity:.65}
.step-locked{opacity:.3;pointer-events:none}
.aq-num{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;font-size:9px;font-weight:700;font-family:var(--mono);margin-bottom:4px}
.step-blocked .aq-num{background:rgba(239,68,68,.2);color:var(--red)}.step-current .aq-num{background:rgba(99,102,241,.2);color:var(--blue)}.step-done .aq-num{background:rgba(34,197,94,.2);color:var(--green)}.step-locked .aq-num{background:rgba(90,90,114,.15);color:var(--t3)}
.aq-step-title{font-size:11px;font-weight:600;color:var(--t1);margin-bottom:2px}.aq-step-desc{font-size:9px;color:var(--t3);line-height:1.5;font-family:var(--mono)}
.aq-missing{margin-top:4px;font-family:var(--mono);font-size:9px;color:var(--red)}
.aq-expanded{margin-top:6px;padding-top:6px;border-top:1px solid var(--bd)}
.aq-row{display:flex;gap:6px;margin-top:4px;align-items:center}
.aq-row input{flex:1;padding:4px 6px;background:var(--bg0);border:1px solid var(--bd);border-radius:4px;color:var(--t1);font-family:var(--mono);font-size:10px;outline:none}
.aq-row input:focus{border-color:var(--cyan)}.aq-row label{font-family:var(--mono);font-size:8px;color:var(--t3);text-transform:uppercase;min-width:40px}
.ss{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:16px}
.sc{background:var(--bg2);border:1px solid var(--bd);border-radius:8px;padding:14px;position:relative;overflow:hidden}
.sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.sc.blue::before{background:var(--blue)}.sc.green::before{background:var(--green)}.sc.yellow::before{background:var(--yellow)}.sc.purple::before{background:var(--purple)}.sc.cyan::before{background:var(--cyan)}.sc.red::before{background:var(--red)}
.sc-l{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono);margin-bottom:3px}
.sc-v{font-size:22px;font-weight:700;font-family:var(--mono)}.sc-s{font-size:10px;color:var(--t2);margin-top:2px}
.tw{background:var(--bg2);border:1px solid var(--bd);border-radius:8px;overflow:hidden}
.th{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--bd)}
.th-title{font-size:13px;font-weight:600}.th-actions{display:flex;gap:8px;align-items:center}
.btn{padding:5px 12px;border-radius:4px;font-size:11px;font-family:var(--mono);border:1px solid var(--bd);background:var(--bg1);color:var(--t2);cursor:pointer;transition:all .15s}
.btn:hover{border-color:var(--cyan);color:var(--cyan)}.btn:active{transform:scale(.97)}
.btn-p{background:rgba(59,130,246,.15);border-color:rgba(59,130,246,.4);color:var(--blue)}.btn-p:hover{background:rgba(59,130,246,.25);border-color:var(--blue)}
.btn-g{background:rgba(34,197,94,.15);border-color:rgba(34,197,94,.4);color:var(--green)}.btn-g:hover{background:rgba(34,197,94,.25)}
.btn-r{background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.4);color:var(--red)}.btn-r:hover{background:rgba(239,68,68,.25)}
.btn-sm{font-size:10px;padding:3px 8px}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{padding:8px 12px;text-align:left;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--t3);background:rgba(0,0,0,.2);border-bottom:1px solid var(--bd);font-family:var(--mono);white-space:nowrap}
tbody tr{border-bottom:1px solid rgba(42,53,85,.5);transition:background .1s;cursor:pointer}tbody tr:hover{background:var(--bg3)}tbody tr:last-child{border-bottom:none}
td{padding:8px 12px;vertical-align:middle}
.mn{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.edge-h{color:var(--green);font-family:var(--mono);font-weight:600}.edge-m{color:var(--yellow);font-family:var(--mono);font-weight:600}.edge-l{color:var(--t3);font-family:var(--mono);font-weight:600}
.mono{font-family:var(--mono);font-size:12px;color:var(--t2)}
.nr-tag{display:inline-block;padding:1px 4px;border-radius:3px;font-size:8px;font-family:var(--mono);background:rgba(139,92,246,.15);color:var(--purple);border:1px solid rgba(139,92,246,.3);margin-left:4px;vertical-align:middle}
.conf-bar{display:flex;align-items:center;gap:6px}
.conf-track{width:50px;height:3px;background:var(--bg0);border-radius:2px;overflow:hidden}.conf-fill{height:100%;border-radius:2px}
.conf-val{font-family:var(--mono);font-size:10px;color:var(--t3)}
.pin-btn{background:none;border:1px solid var(--bd);color:var(--t3);padding:2px 6px;border-radius:3px;cursor:pointer;font-size:10px;font-family:var(--mono);transition:all .15s}
.pin-btn:hover{border-color:var(--yellow);color:var(--yellow)}.pin-btn.pinned{border-color:var(--yellow);color:var(--yellow);background:rgba(245,158,11,.1)}
.vb{padding:2px 8px;border-radius:4px;font-family:var(--mono);font-size:9px;font-weight:700;border:1px solid;cursor:pointer;background:none;transition:all .15s}
.vb-buy{border-color:rgba(34,197,94,.3);color:var(--green)}.vb-buy:hover{background:rgba(34,197,94,.15)}.vb-buy.active{background:var(--green);color:#000}
.vb-pass{border-color:rgba(239,68,68,.3);color:var(--red)}.vb-pass:hover{background:rgba(239,68,68,.15)}.vb-pass.active{background:var(--red);color:#fff}
.search-bar{display:flex;gap:8px;margin-bottom:14px;align-items:center;flex-wrap:wrap}
.search-bar input{flex:1;min-width:180px;padding:7px 12px;background:var(--bg2);border:1px solid var(--bd);border-radius:6px;color:var(--t1);font-family:var(--mono);font-size:11px;outline:none}
.search-bar input:focus{border-color:var(--cyan)}
.search-bar select{padding:7px 10px;background:var(--bg2);border:1px solid var(--bd);border-radius:6px;color:var(--t1);font-family:var(--mono);font-size:10px;outline:none;cursor:pointer}
.rc{font-family:var(--mono);font-size:10px;color:var(--t3)}
.fund-bar{display:flex;gap:14px;align-items:center;padding:8px 14px;background:var(--bg2);border:1px solid var(--bd);border-radius:6px;margin-bottom:10px;font-family:var(--mono);font-size:11px;flex-wrap:wrap}
.fb-i{display:flex;gap:4px;align-items:center}.fb-l{color:var(--t3)}.fb-v{font-weight:700}
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:500;display:flex;align-items:center;justify-content:center;animation:fi .15s}
@keyframes fi{from{opacity:0}to{opacity:1}}
.modal{background:var(--bg1);border:1px solid var(--bd);border-radius:12px;width:90%;max-width:700px;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.modal-h{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--bd)}
.modal-h h2{font-size:15px;font-weight:700}
.modal-x{background:none;border:1px solid var(--bd);color:var(--t2);width:26px;height:26px;border-radius:6px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center}
.modal-x:hover{border-color:var(--red);color:var(--red)}
.modal-b{padding:18px}
.md-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
.md-stat{padding:8px;background:rgba(0,0,0,.2);border-radius:6px}
.md-stat .ms-l{font-size:9px;color:var(--t3);font-family:var(--mono);text-transform:uppercase}.md-stat .ms-v{font-size:14px;font-weight:700;font-family:var(--mono)}
.empty{text-align:center;padding:50px 20px;color:var(--t3)}.empty p{font-size:13px;margin-bottom:4px}.empty .eh{font-size:11px;font-family:var(--mono)}
.toast-c{position:fixed;bottom:20px;right:20px;z-index:1000;display:flex;flex-direction:column;gap:6px}
.toast{padding:8px 14px;border-radius:6px;font-size:11px;font-family:var(--mono);background:var(--bg2);border:1px solid var(--bd);color:var(--t1);box-shadow:0 8px 24px rgba(0,0,0,.4);animation:si .2s;max-width:340px}
.toast.success{border-color:var(--green)}.toast.error{border-color:var(--red)}.toast.info{border-color:var(--cyan)}
@keyframes si{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
.agent-card{background:var(--bg2);border:1px solid var(--bd);border-radius:8px;padding:16px;margin-bottom:10px;transition:border-color .15s}
.agent-card:hover{border-color:var(--bd2)}
.agent-card .ac-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.agent-card .ac-name{font-weight:600;font-size:14px}.agent-card .ac-type{font-family:var(--mono);font-size:10px;color:var(--t3);background:var(--bg0);padding:2px 6px;border-radius:3px}
.status-pill{padding:2px 8px;border-radius:10px;font-size:9px;font-family:var(--mono);font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.st-running{background:rgba(16,185,129,.15);color:var(--green)}.st-paused{background:rgba(245,158,11,.15);color:var(--yellow)}.st-error{background:rgba(239,68,68,.15);color:var(--red)}.st-disabled{background:rgba(90,100,120,.15);color:var(--t3)}
.agent-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:6px;margin:8px 0}
.as-item{padding:6px 8px;background:rgba(0,0,0,.15);border-radius:4px;text-align:center}
.as-item .as-l{font-size:8px;color:var(--t3);font-family:var(--mono);text-transform:uppercase}.as-item .as-v{font-size:14px;font-weight:700;font-family:var(--mono)}
.approval-card{background:var(--bg2);border:1px solid var(--bd);border-radius:8px;padding:14px;margin-bottom:8px;border-left:3px solid var(--yellow)}
.approval-card.approved{border-left-color:var(--green);opacity:.6}.approval-card.rejected{border-left-color:var(--red);opacity:.6}
.ap-h{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px}
.ap-title{font-weight:600;font-size:13px;flex:1}.ap-edge{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--green)}
.ap-meta{font-family:var(--mono);font-size:10px;color:var(--t3);margin-bottom:6px}
.ap-rationale{font-size:12px;color:var(--t2);line-height:1.5;padding:8px;background:rgba(0,0,0,.15);border-radius:4px;margin-bottom:8px;font-family:var(--mono);font-size:11px}
.ap-actions{display:flex;gap:6px}
.commander{position:fixed;bottom:0;left:0;right:0;background:var(--bg1);border-top:1px solid var(--bd);padding:8px 24px;z-index:90;display:flex;gap:8px;align-items:center}
.commander input{flex:1;padding:8px 12px;background:var(--bg0);border:1px solid var(--bd);border-radius:6px;color:var(--t1);font-family:var(--mono);font-size:12px;outline:none}
.commander input:focus{border-color:var(--cyan)}
.commander .cmd-label{font-family:var(--mono);font-size:10px;color:var(--blue);font-weight:700;letter-spacing:1px}
.cmd-output{font-family:var(--mono);font-size:11px;color:var(--t2);max-width:600px;white-space:pre-wrap;overflow:hidden;text-overflow:ellipsis}
.headline-box{width:100%;min-height:80px;padding:10px;background:var(--bg0);border:1px solid var(--bd);border-radius:6px;color:var(--t1);font-family:var(--mono);font-size:11px;outline:none;resize:vertical}
.headline-box:focus{border-color:var(--cyan)}
.whale-input{display:flex;gap:6px;margin-bottom:12px;align-items:center}
.whale-input input{flex:1;padding:6px 10px;background:var(--bg0);border:1px solid var(--bd);border-radius:4px;color:var(--t1);font-family:var(--mono);font-size:11px;outline:none}
.whale-input input:focus{border-color:var(--cyan)}
.whale-event{display:flex;gap:10px;padding:8px;border-bottom:1px solid rgba(42,53,85,.3);font-size:11px;align-items:center}
.whale-event:last-child{border-bottom:none}
.we-alias{font-family:var(--mono);font-weight:700;color:var(--cyan);min-width:80px}
.we-side{font-family:var(--mono);font-weight:700;font-size:10px;padding:1px 6px;border-radius:3px}
.we-yes{background:rgba(34,197,94,.15);color:var(--green)}.we-no{background:rgba(239,68,68,.15);color:var(--red)}
.diag-item{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid rgba(42,53,85,.3)}
.diag-item:last-child{border-bottom:none}
.diag-name{font-size:12px}.diag-status{font-family:var(--mono);font-size:10px;padding:2px 8px;border-radius:3px;font-weight:600}
.ds-ok{background:rgba(34,197,94,.15);color:var(--green)}.ds-error{background:rgba(239,68,68,.15);color:var(--red)}.ds-missing{background:rgba(245,158,11,.15);color:var(--yellow)}.ds-configured{background:rgba(99,102,241,.15);color:var(--blue)}.ds-unknown{background:rgba(90,100,120,.15);color:var(--t3)}
.settings-section{margin-bottom:20px}
.settings-section h3{font-size:12px;font-weight:700;color:var(--cyan);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono)}
.settings-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px}
.set-item{display:flex;flex-direction:column;gap:3px;padding:10px;background:var(--bg2);border:1px solid var(--bd);border-radius:8px}
.set-item label{font-size:10px;font-family:var(--mono);color:var(--t3);text-transform:uppercase;letter-spacing:.5px}
.set-item .set-d{font-size:9px;color:var(--t3);margin-bottom:3px}
.set-item input,.set-item select{padding:6px 8px;background:var(--bg0);border:1px solid var(--bd);border-radius:4px;color:var(--t1);font-family:var(--mono);font-size:11px;outline:none}
.set-item input:focus{border-color:var(--cyan)}
.set-st{display:inline-flex;align-items:center;gap:3px;font-size:9px;font-family:var(--mono);padding:1px 5px;border-radius:3px}
.set-st.ok{background:rgba(34,197,94,.1);color:var(--green)}.set-st.no{background:rgba(239,68,68,.1);color:var(--red)}
.hub-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:900px){.hub-grid{grid-template-columns:1fr}}
.hub-card{background:var(--bg2);border:1px solid var(--bd);border-radius:10px;padding:18px}
.hub-card.fw{grid-column:1/-1}
.hub-card h3{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--blue);font-family:var(--mono);margin-bottom:10px}
.hub-card p{font-size:12px;line-height:1.6;color:var(--t2);margin-bottom:6px}
.act-feed{max-height:350px;overflow-y:auto}
.act-entry{display:flex;gap:8px;padding:6px 0;border-bottom:1px solid rgba(42,53,85,.3);font-size:11px;align-items:flex-start}
.act-entry:last-child{border-bottom:none}
.act-time{font-family:var(--mono);font-size:9px;color:var(--t3);white-space:nowrap;min-width:55px}
.act-type{font-family:var(--mono);font-size:8px;padding:1px 5px;border-radius:3px;font-weight:600;text-transform:uppercase;min-width:48px;text-align:center}
.at-system{background:rgba(99,102,241,.15);color:var(--blue)}.at-scan{background:rgba(6,182,212,.15);color:var(--cyan)}.at-config{background:rgba(245,158,11,.15);color:var(--yellow)}.at-trade{background:rgba(34,197,94,.15);color:var(--green)}.at-decision{background:rgba(139,92,246,.15);color:var(--purple)}.at-error{background:rgba(239,68,68,.15);color:var(--red)}
.act-msg{color:var(--t2);font-size:11px}
@media(max-width:768px){.topbar{padding:0 10px;flex-wrap:wrap;height:auto;padding:8px 10px;gap:6px}.tabs{padding:0 10px}.tab{padding:8px 10px;font-size:11px}.content{padding:10px}.ss{grid-template-columns:repeat(2,1fr)}.mn{max-width:180px}td,thead th{padding:6px 8px}.commander{padding:6px 10px}}
body{padding-bottom:50px}
.theme-toggle{padding:4px 10px;border-radius:4px;font-family:var(--mono);font-size:10px;cursor:pointer;border:1px solid var(--bd);background:var(--bg2);color:var(--t2);transition:all .15s}.theme-toggle:hover{border-color:var(--green);color:var(--green)}
.simple-toggle{padding:4px 10px;border-radius:4px;font-family:var(--mono);font-size:10px;cursor:pointer;border:1px solid var(--bd);background:var(--bg2);color:var(--t2);transition:all .15s}.simple-toggle:hover{border-color:var(--cyan);color:var(--cyan)}.simple-toggle.active{border-color:var(--cyan);color:var(--cyan);background:rgba(6,182,212,.1)}
.wizard-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:600;display:flex;align-items:center;justify-content:center;animation:fi .15s}
.wizard{background:var(--bg1);border:1px solid var(--bd);border-radius:16px;width:92%;max-width:600px;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.wizard-h{padding:20px 24px 0;display:flex;justify-content:space-between;align-items:flex-start}
.wizard-h h2{font-size:18px;font-weight:700;line-height:1.3}
.wizard-h .step-num{font-family:var(--mono);font-size:10px;color:var(--cyan);display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px}
.wizard-body{padding:20px 24px}
.wizard-section{margin-bottom:18px}
.wizard-section h4{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--cyan);font-family:var(--mono);margin-bottom:8px}
.wizard-section p{font-size:13px;color:var(--t2);line-height:1.7}
.wizard-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.wizard-field label{font-size:10px;font-family:var(--mono);color:var(--t3);text-transform:uppercase;letter-spacing:.5px}
.wizard-field input,.wizard-field select{padding:8px 12px;background:var(--bg0);border:1px solid var(--bd);border-radius:6px;color:var(--t1);font-family:var(--mono);font-size:12px;outline:none;transition:border .15s}
.wizard-field input:focus{border-color:var(--cyan)}
.wizard-footer{padding:16px 24px;border-top:1px solid var(--bd);display:flex;gap:8px;justify-content:flex-end;align-items:center}
.wizard-footer .test-result{flex:1;font-family:var(--mono);font-size:11px;color:var(--t3)}
.test-ok{color:var(--green)!important}.test-fail{color:var(--red)!important}
.console-wrap{display:flex;flex-direction:column;height:calc(100vh - 280px);min-height:400px}
.console-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.console-msg{padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.6;max-width:85%;white-space:pre-wrap;font-family:var(--sans)}
.console-msg.user{background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.25);align-self:flex-end;color:var(--t1)}
.console-msg.system{background:var(--bg2);border:1px solid var(--bd);align-self:flex-start;color:var(--t2);font-family:var(--mono);font-size:12px}
.console-msg.llm{background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);align-self:flex-start;color:var(--t2)}
.console-input{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--bd);background:var(--bg2);border-radius:0 0 10px 10px}
.console-input input{flex:1;padding:10px 14px;background:var(--bg0);border:1px solid var(--bd);border-radius:8px;color:var(--t1);font-size:13px;outline:none;font-family:var(--sans)}
.console-input input:focus{border-color:var(--cyan)}
.report-grid{display:grid;gap:14px}
.report-section{background:var(--bg2);border:1px solid var(--bd);border-radius:10px;padding:16px}
.report-section h4{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--blue);font-family:var(--mono);margin-bottom:10px}
.report-item{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(42,53,85,.2);font-size:12px}
.report-item:last-child{border-bottom:none}
.ri-name{color:var(--t1)}.ri-detail{color:var(--t3);font-family:var(--mono);font-size:10px;text-align:right;max-width:60%}
.onboard-hero{text-align:center;padding:40px 20px 30px;max-width:600px;margin:0 auto}
.onboard-hero h1{font-size:28px;font-weight:700;margin-bottom:8px;background:linear-gradient(135deg,var(--blue),var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.onboard-hero p{font-size:15px;color:var(--t2);line-height:1.7}
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-left"><div><div class="logo">ZVI v1</div><div class="logo-sub">Fund Operating System</div></div></div>
  <div class="topbar-right">
    <div class="secret-badges" id="secBadges"></div>
    <button class="simple-toggle" id="viewToggle" onclick="toggleView()">Simple</button>
    <button class="theme-toggle" id="themeBtn" onclick="toggleTheme()">Hexa Light</button>
    <button class="kill-btn" id="killBtn" onclick="toggleKillSwitch()">KILL SWITCH</button>
    <div class="mode-badge ${cfg.mode === 'OBSERVATION_ONLY' ? 'mode-obs' : 'mode-live'}" id="modeBadge">${cfg.mode === 'OBSERVATION_ONLY' ? 'OBSERVE' : 'LIVE'}</div>
  </div>
</div>
<div class="aq" id="aq"><div class="aq-header"><span class="aq-title">Founder Action Queue</span><span class="aq-progress" id="aqProg">Loading...</span></div><div class="aq-steps" id="aqSteps"></div></div>
<div class="tabs">
  <div class="tab active" data-tab="opps">Markets <span class="cnt" id="cOpps">--</span></div>
  <div class="tab" data-tab="agents">Agents <span class="cnt" id="cAgents">0</span></div>
  <div class="tab" data-tab="approvals">Approvals <span class="cnt" id="cApprovals">0</span></div>
  <div class="tab" data-tab="negrisk">NegRisk Arb</div>
  <div class="tab" data-tab="llm">LLM Probability</div>
  <div class="tab" data-tab="sentiment">Sentiment</div>
  <div class="tab" data-tab="whales">Whale Watch</div>
  <div class="tab" data-tab="hub">Founder Console</div>
  <div class="tab" data-tab="health">Health</div>
  <div class="tab" data-tab="settings">Settings</div>
</div>
<div class="content">
  <div class="panel active" id="panel-opps">
    <div class="fund-bar" id="fundBar" style="display:none"></div>
    <div class="ss" id="oppSum"></div>
    <div class="search-bar"><input type="text" id="mSearch" placeholder="Search markets..." oninput="filterRender()"><select id="edgeF" onchange="filterRender()"><option value="0">All Edges</option><option value="0.5">> 0.5%</option><option value="1">> 1%</option><option value="2">> 2%</option></select><select id="sortM" onchange="filterRender()"><option value="edge">Sort: Edge</option><option value="volume">Sort: Volume</option><option value="confidence">Sort: Confidence</option></select><span class="rc" id="rCount"></span></div>
    <div class="tw"><div class="th"><div class="th-title">Market Scanner</div><div class="th-actions"><span class="mono" id="rTimer" style="font-size:10px;color:var(--t3)">30s</span><button class="btn btn-p btn-sm" onclick="fetchOpps()">Refresh</button></div></div><div id="oppTable"><div class="empty"><p>Loading markets...</p></div></div></div>
  </div>
  <div class="panel" id="panel-agents">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><h3 style="font-size:15px">Strategy Agents</h3><button class="btn btn-p" onclick="showCreateAgent()">+ Create Agent</button></div>
    <div id="agentList"></div>
  </div>
  <div class="panel" id="panel-approvals">
    <h3 style="font-size:15px;margin-bottom:14px">Approval Queue</h3>
    <div id="approvalList"></div>
  </div>
  <div class="panel" id="panel-negrisk">
    <h3 style="font-size:15px;margin-bottom:14px">NegRisk Arbitrage Scanner</h3>
    <div id="negriskContent"><div class="empty"><p>Create a NegRisk Arb agent to start scanning</p><button class="btn btn-p" style="margin-top:10px" onclick="quickCreateAgent('negrisk_arb')">Create NegRisk Agent</button></div></div>
  </div>
  <div class="panel" id="panel-llm">
    <h3 style="font-size:15px;margin-bottom:14px">LLM Probability Mispricing</h3>
    <div id="llmContent"><div class="empty"><p>Create an LLM Probability agent to analyze markets</p><button class="btn btn-p" style="margin-top:10px" onclick="quickCreateAgent('llm_probability')">Create LLM Agent</button></div></div>
  </div>
  <div class="panel" id="panel-sentiment">
    <h3 style="font-size:15px;margin-bottom:14px">Sentiment / Headlines Console</h3>
    <p style="font-size:12px;color:var(--t2);margin-bottom:10px">Paste headlines below to analyze market impact. Uses xAI/Grok if key is set, otherwise falls back to Claude or keyword matching.</p>
    <textarea class="headline-box" id="headlineBox" placeholder="Paste headlines here, one per line...&#10;Example: Trump announces new tariffs on Chinese goods&#10;Fed signals rate hold through Q3 2026"></textarea>
    <div style="margin-top:8px;display:flex;gap:8px"><button class="btn btn-p" onclick="analyzeHeadlines()">Analyze Headlines</button><button class="btn" onclick="document.getElementById('headlineBox').value=''">Clear</button></div>
    <div id="sentimentResults" style="margin-top:14px"></div>
  </div>
  <div class="panel" id="panel-whales">
    <h3 style="font-size:15px;margin-bottom:14px">Whale Pocket-Watching</h3>
    <div class="whale-input"><input type="text" id="whaleAddr" placeholder="Wallet address (0x...)"><input type="text" id="whaleAlias" placeholder="Alias (optional)" style="max-width:120px"><button class="btn btn-p btn-sm" onclick="addWhale()">Add Wallet</button></div>
    <div id="whaleList" style="margin-bottom:14px"></div>
    <h4 style="font-size:12px;color:var(--t2);margin-bottom:8px">Recent Whale Events</h4>
    <div id="whaleEvents" class="tw" style="max-height:400px;overflow-y:auto"></div>
  </div>
  <div class="panel" id="panel-hub">
    <div style="display:flex;gap:8px;margin-bottom:14px"><button class="btn btn-p btn-sm" id="hubTabChat" onclick="switchHubTab('chat')" style="border-bottom:2px solid var(--cyan)">Console Chat</button><button class="btn btn-sm" id="hubTabReport" onclick="switchHubTab('report')">System Report</button><button class="btn btn-sm" id="hubTabActivity" onclick="switchHubTab('activity')">Activity</button></div>
    <div id="hubChat" class="console-wrap" style="background:var(--bg2);border:1px solid var(--bd);border-radius:10px">
      <div class="console-messages" id="consoleMessages"><div class="console-msg system">Welcome to the Founder Console. Ask me anything about your system.\\nTry: "What's missing?" or "NegRisk status" or "help"</div></div>
      <div class="console-input"><input type="text" id="consoleInput" placeholder="Ask about your system..." onkeydown="if(event.key==='Enter')sendConsoleMsg()"><button class="btn btn-p" onclick="sendConsoleMsg()">Ask</button></div>
    </div>
    <div id="hubReport" style="display:none"><div class="report-grid" id="reportGrid"></div></div>
    <div id="hubActivity" style="display:none"><div class="hub-grid" id="hubGrid"></div></div>
  </div>
  <div class="panel" id="panel-health">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><h3 style="font-size:15px">System Health & Diagnostics</h3><button class="btn btn-p btn-sm" onclick="runDiag()">Run Diagnostics</button></div>
    <div id="diagGrid"></div>
    <h4 style="font-size:12px;color:var(--t2);margin:14px 0 8px">Agent Health</h4>
    <div id="healthGrid"></div>
  </div>
  <div class="panel" id="panel-settings"><div id="settingsContent"></div></div>
</div>
<div id="marketModal"></div>
<div class="toast-c" id="toastC"></div>
<div class="commander"><span class="cmd-label">CMD</span><input type="text" id="cmdInput" placeholder="Type command... (help for list)" onkeydown="if(event.key==='Enter')runCmd()"><span class="cmd-output" id="cmdOut"></span></div>

<script>
const __S = ${EMBEDDED};
let opps = __S.opportunities || [];
let agents = __S.agents || [];
let approvals = __S.approvals || [];
let signals = [], thresholds = [], pinnedMarkets = new Set();
let refreshCountdown = 30, countdownInterval, founderDecisions = __S.blockers?.founder?.decisions || {}, tradingUnlocked = __S.blockers?.allClear || false, blockerData = __S.blockers || null, expandedStep = null, killSwitch = __S.killSwitch || false;

// Tab nav
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('panel-' + t.dataset.tab)?.classList.add('active');
  if (t.dataset.tab === 'hub') { switchHubTab('chat'); }
  if (t.dataset.tab === 'settings') renderSettings();
  if (t.dataset.tab === 'agents') fetchAgents();
  if (t.dataset.tab === 'approvals') fetchApprovals();
  if (t.dataset.tab === 'negrisk' || t.dataset.tab === 'llm') fetchStratOpps(t.dataset.tab);
  if (t.dataset.tab === 'whales') fetchWhaleData();
  if (t.dataset.tab === 'health') { runDiag(); fetchAgentHealth(); }
}));

function toast(m, type='info') { const e=document.createElement('div');e.className='toast '+type;e.textContent=m;document.getElementById('toastC').appendChild(e);setTimeout(()=>e.remove(),4000); }
function esc(s) { const d=document.createElement('div');d.textContent=s;return d.innerHTML; }
function fmt(n) { return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':n.toString(); }
function api(u,o){return fetch(u,o).then(r=>r.json());}
function post(u,b){return api(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});}

// Config + badges
async function loadCfg() {
  try { const c = await api('/api/config');
    const badges=[{k:'polymarketGamma',l:'Polymarket'},{k:'anthropicKey',l:'Anthropic'},{k:'polygonRpc',l:'Polygon'},{k:'xaiKey',l:'xAI'}];
    document.getElementById('secBadges').innerHTML = badges.map(b=>'<div class="secret-badge"><span class="dot '+(c.secrets[b.k]?'dot-g':'dot-r')+'"></span>'+b.l+'</div>').join('');
    if(c.killSwitch){killSwitch=true;document.getElementById('killBtn').classList.add('active');}
  } catch(e){}
}

// Kill switch
async function toggleKillSwitch(){
  const newState = !killSwitch;
  try { const r = await post('/api/kill-switch', {active:newState});
    if(r.ok){killSwitch=newState;document.getElementById('killBtn').classList.toggle('active',newState);toast(newState?'KILL SWITCH ON':'Kill switch off',newState?'error':'success');}
  } catch(e){toast('Failed','error');}
}

// Opportunities
async function fetchOpps() {
  try { const d = await api('/api/opportunities'); opps = d.opportunities||d; renderOpps(); refreshCountdown=30; toast('Refreshed ('+opps.length+')','success'); } catch(e){toast('Fetch failed','error');}
}
function renderOpps() {
  const we = opps.filter(o=>o.edge>0.5); document.getElementById('cOpps').textContent = we.length;
  const tv = opps.reduce((a,o)=>a+o.volume,0), ae = opps.length>0?opps.reduce((a,o)=>a+o.edge,0)/opps.length:0, me = opps.length>0?Math.max(...opps.map(o=>o.edge)):0, nr = opps.filter(o=>o.negRisk).length;
  document.getElementById('oppSum').innerHTML = [{l:'Markets',v:opps.length,c:'blue',s:opps.some(o=>!o.demo)?'live':'demo'},{l:'Arb Opps',v:we.length,c:'green',s:'>0.5% edge'},{l:'Max Edge',v:me.toFixed(2)+'%',c:'cyan'},{l:'Avg Edge',v:ae.toFixed(2)+'%',c:'yellow'},{l:'Volume 24h',v:'$'+fmt(tv),c:'purple'},{l:'NegRisk',v:nr,c:'blue'}].map(s=>'<div class="sc '+s.c+'"><div class="sc-l">'+s.l+'</div><div class="sc-v">'+s.v+'</div>'+(s.s?'<div class="sc-s">'+s.s+'</div>':'')+'</div>').join('');
  const fl = getFiltered(); document.getElementById('rCount').textContent = fl.length+' of '+opps.length;
  if(!fl.length){document.getElementById('oppTable').innerHTML='<div class="empty"><p>No matches</p></div>';return;}
  let h='<table><thead><tr><th>#</th><th>Market</th><th>Edge%</th><th>Yes/No</th><th>Vol</th><th>Liq</th><th>Conf</th><th>Action</th><th>Pin</th></tr></thead><tbody>';
  fl.forEach((o,i)=>{
    const ec=o.edge>=2?'edge-h':o.edge>=1?'edge-m':'edge-l', cc=o.confidence>=60?'var(--green)':o.confidence>=30?'var(--yellow)':'var(--t3)', ip=pinnedMarkets.has(o.id), dec=founderDecisions[o.id];
    h+='<tr onclick="showDetail('+i+')"><td class="mono">'+(i+1)+'</td><td class="mn">'+esc(o.market)+(o.negRisk?'<span class="nr-tag">NR</span>':'')+(o.demo?'<span style="font-size:8px;color:var(--yellow);margin-left:3px;font-family:var(--mono)">[demo]</span>':'')+'</td><td class="'+ec+'">'+o.edge.toFixed(2)+'%</td><td class="mono">'+o.bestBid.toFixed(2)+'/'+o.bestAsk.toFixed(2)+'</td><td class="mono">$'+fmt(o.volume)+'</td><td class="mono">$'+fmt(o.liquidity)+'</td><td><div class="conf-bar"><div class="conf-track"><div class="conf-fill" style="width:'+o.confidence+'%;background:'+cc+'"></div></div><span class="conf-val">'+o.confidence.toFixed(0)+'</span></div></td>';
    h+='<td onclick="event.stopPropagation()">';
    if(dec){h+='<span style="font-family:var(--mono);font-size:10px;font-weight:700;color:'+(dec.verdict==='BUY'?'var(--green)':'var(--t3)')+'">'+dec.verdict+'</span>';}
    else if(tradingUnlocked){h+='<button class="vb vb-buy" onclick="decide(\\''+o.id+'\\',\\'BUY\\',\\''+esc(o.market).replace(/'/g,"\\\\'")+'\\')">BUY</button> <button class="vb vb-pass" onclick="decide(\\''+o.id+'\\',\\'PASS\\',\\''+esc(o.market).replace(/'/g,"\\\\'")+'\\')">PASS</button>';}
    else{h+='<span style="opacity:.3;font-family:var(--mono);font-size:9px">locked</span>';}
    h+='</td><td onclick="event.stopPropagation()"><button class="pin-btn'+(ip?' pinned':'')+'" onclick="togglePin(\\''+o.id+'\\')">Pin</button></td></tr>';
  });
  h+='</tbody></table>';document.getElementById('oppTable').innerHTML=h;
}
function filterRender(){renderOpps();}
function getFiltered(){
  let f=[...opps];const q=(document.getElementById('mSearch')?.value||'').toLowerCase(),me=parseFloat(document.getElementById('edgeF')?.value||'0'),sb=document.getElementById('sortM')?.value||'edge';
  if(q)f=f.filter(o=>o.market.toLowerCase().includes(q));if(me>0)f=f.filter(o=>o.edge>=me);
  if(sb==='volume')f.sort((a,b)=>b.volume-a.volume);else if(sb==='confidence')f.sort((a,b)=>b.confidence-a.confidence);else f.sort((a,b)=>b.edge-a.edge);return f;
}
function togglePin(id){if(pinnedMarkets.has(id)){pinnedMarkets.delete(id);toast('Unpinned','info');}else{pinnedMarkets.add(id);toast('Pinned','success');}renderOpps();}
function showDetail(i){
  const f=getFiltered(),o=f[i];if(!o)return;const ec=o.edge>=2?'edge-h':o.edge>=1?'edge-m':'edge-l';
  document.getElementById('marketModal').innerHTML='<div class="modal-overlay" onclick="closeModal(event)"><div class="modal" onclick="event.stopPropagation()"><div class="modal-h"><h2>'+esc(o.market)+'</h2><button class="modal-x" onclick="closeModal()">X</button></div><div class="modal-b">'+(o.demo?'<div style="padding:6px 10px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:6px;margin-bottom:10px;font-size:10px;color:var(--yellow);font-family:var(--mono)">DEMO DATA</div>':'')+(o.description?'<p style="font-size:12px;color:var(--t2);line-height:1.6;padding:10px;background:rgba(0,0,0,.15);border-radius:6px;margin-bottom:10px">'+esc(o.description)+'</p>':'')+'<div class="md-grid"><div class="md-stat"><div class="ms-l">Edge</div><div class="ms-v '+ec+'">'+o.edge.toFixed(2)+'%</div></div><div class="md-stat"><div class="ms-l">Confidence</div><div class="ms-v">'+o.confidence.toFixed(0)+'%</div></div><div class="md-stat"><div class="ms-l">Yes</div><div class="ms-v">'+o.bestBid.toFixed(4)+'</div></div><div class="md-stat"><div class="ms-l">No</div><div class="ms-v">'+o.bestAsk.toFixed(4)+'</div></div><div class="md-stat"><div class="ms-l">Volume</div><div class="ms-v">$'+fmt(o.volume)+'</div></div><div class="md-stat"><div class="ms-l">Liquidity</div><div class="ms-v">$'+fmt(o.liquidity)+'</div></div></div></div></div></div>';
}
function closeModal(e){if(e&&e.target!==e.currentTarget)return;document.getElementById('marketModal').innerHTML='';}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});

// Decisions
async function decide(id,v,m){try{const d=await post('/api/founder/decide',{marketId:id,verdict:v,market:m});if(d.ok){founderDecisions[id]={verdict:v};toast(v==='BUY'?'BUY — $'+(d.position?.size||'?'):'PASS',v==='BUY'?'success':'info');fetchBlockers();}}catch(e){toast('Failed','error');}}

// Blockers
async function fetchBlockers(){try{const d=await api('/api/blockers');blockerData=d;founderDecisions=d.founder?.decisions||{};tradingUnlocked=d.allClear;renderAQ();renderFundBar();if(opps.length)renderOpps();}catch(e){}}
function renderAQ(){
  if(!blockerData)return;const{blockers:bs,currentStep:cs,allClear}=blockerData;
  document.getElementById('aqProg').textContent=allClear?'ALL CLEAR':'Step '+cs+'/'+bs.length;
  if(allClear){document.getElementById('aqSteps').innerHTML='<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.25);border-radius:8px;font-family:var(--mono);font-size:11px;color:var(--green);font-weight:600">ALL SYSTEMS GO — Ready for trading decisions</div>';return;}
  document.getElementById('aqSteps').innerHTML=bs.map((b,i)=>{
    let sc='step-locked';if(b.status==='done')sc='step-done';else if(b.status==='blocked')sc=i===cs-1?'step-blocked step-current':'step-blocked';else if(b.status==='action-needed')sc=i===cs-1?'step-current':'';else if(b.status==='ready')sc='step-current';
    let statusLine='';
    if(b.status==='done')statusLine='<div style="font-size:9px;color:var(--green);font-family:var(--mono);margin-top:4px">Verified</div>';
    else if(b.missing?.length)statusLine='<div class="aq-missing">Missing: '+b.missing.join(', ')+'</div>';
    else if(b.status==='action-needed')statusLine='<div style="font-size:9px;color:var(--yellow);font-family:var(--mono);margin-top:4px">Action needed</div>';
    const clk=b.status!=='done'&&b.status!=='locked'?' onclick="openWizard(\\''+b.id+'\\')"':'';
    return '<div class="aq-step '+sc+'"'+clk+'><div class="aq-num">'+(b.status==='done'?'>':i+1)+'</div><div class="aq-step-title">'+esc(b.title)+'</div><div class="aq-step-desc">'+esc(b.desc)+'</div>'+statusLine+'</div>';
  }).join('');
}
function toggleExp(id){openWizard(id);}
async function setCap(){const v=parseInt(document.getElementById('aqCap')?.value);if(!v||v<100){toast('Min $100','error');return;}try{const r=await post('/api/founder/set-capital',{fundSize:v});if(r.ok){blockerData=r.blockers;toast('Fund: $'+v.toLocaleString(),'success');renderAQ();renderFundBar();}}catch(e){toast('Failed','error');}}
async function approveRisks(){try{const r=await post('/api/founder/approve-risks',{});if(r.ok){blockerData=r.blockers;tradingUnlocked=r.blockers.allClear;toast('Risks approved','success');renderAQ();if(opps.length)renderOpps();}}catch(e){toast('Failed','error');}}
function renderFundBar(){const b=document.getElementById('fundBar');if(!blockerData?.founder?.capitalAllocated){b.style.display='none';return;}const f=blockerData.founder,rem=f.fundSize-f.capitalDeployed;b.style.display='flex';b.innerHTML='<div class="fb-i"><span class="fb-l">Fund:</span><span class="fb-v">$'+f.fundSize.toLocaleString()+'</span></div><div class="fb-i"><span class="fb-l">Deployed:</span><span class="fb-v" style="color:var(--yellow)">$'+f.capitalDeployed.toLocaleString()+'</span></div><div class="fb-i"><span class="fb-l">Remaining:</span><span class="fb-v" style="color:'+(rem>f.fundSize*.3?'var(--green)':'var(--red)')+'">$'+rem.toLocaleString()+'</span></div>';}

// Agents
async function fetchAgents(){try{const d=await api('/api/agents');agents=d.agents||[];renderAgents();}catch(e){}}
function renderAgents(){
  document.getElementById('cAgents').textContent=agents.length;
  if(!agents.length){document.getElementById('agentList').innerHTML='<div class="empty"><p>No agents created yet</p><p class="eh">Click "+ Create Agent" to deploy a strategy</p></div>';return;}
  document.getElementById('agentList').innerHTML=agents.map(a=>{
    const sc='st-'+(a.status||'disabled');
    return '<div class="agent-card"><div class="ac-h"><div><span class="ac-name">'+esc(a.name)+'</span> <span class="ac-type">'+a.strategyType+'</span></div><div style="display:flex;gap:6px;align-items:center"><span class="status-pill '+sc+'">'+(a.status||'?')+'</span><button class="btn btn-sm" onclick="toggleAgentStatus(\\''+a.id+'\\')">'+((a.status==='running')?'Pause':'Resume')+'</button><button class="btn btn-sm btn-r" onclick="deleteAgentUI(\\''+a.id+'\\')">Del</button></div></div><div class="agent-stats"><div class="as-item"><div class="as-l">Scanned</div><div class="as-v">'+a.stats.scanned+'</div></div><div class="as-item"><div class="as-l">Opportunities</div><div class="as-v">'+a.stats.opportunities+'</div></div><div class="as-item"><div class="as-l">Pending</div><div class="as-v">'+a.stats.approvalsPending+'</div></div><div class="as-item"><div class="as-l">Executed</div><div class="as-v">'+a.stats.executed+'</div></div><div class="as-item"><div class="as-l">Mode</div><div class="as-v" style="font-size:10px">'+a.config.mode+'</div></div><div class="as-item"><div class="as-l">Budget</div><div class="as-v">$'+a.config.budgetUSDC+'</div></div></div><div style="font-size:10px;color:var(--t3);font-family:var(--mono)">Last run: '+(a.health.lastRunAt?new Date(a.health.lastRunAt).toLocaleTimeString():'never')+' | Min edge: '+a.config.minEdgePct+'% | Refresh: '+a.config.refreshSec+'s</div></div>';
  }).join('');
}
function showCreateAgent(){
  document.getElementById('marketModal').innerHTML='<div class="modal-overlay" onclick="closeModal(event)"><div class="modal" onclick="event.stopPropagation()" style="max-width:500px"><div class="modal-h"><h2>Create Agent</h2><button class="modal-x" onclick="closeModal()">X</button></div><div class="modal-b"><div style="display:grid;gap:10px"><div class="set-item"><label>Strategy</label><select id="ca_strat"><option value="negrisk_arb">NegRisk Arbitrage</option><option value="llm_probability">LLM Probability</option><option value="sentiment">Sentiment/Headlines</option><option value="whale_watch">Whale Watch</option></select></div><div class="set-item"><label>Name</label><input id="ca_name" placeholder="My Agent"></div><div class="set-item"><label>Budget (USDC)</label><input type="number" id="ca_budget" value="1000"></div><div class="set-item"><label>Min Edge %</label><input type="number" step="0.1" id="ca_edge" value="1.0"></div><div class="set-item"><label>Refresh (sec)</label><input type="number" id="ca_refresh" value="60"></div><button class="btn btn-p" onclick="doCreateAgent()">Create & Start (OBSERVE mode)</button></div></div></div></div>';
}
async function doCreateAgent(){
  const cfg={strategyType:document.getElementById('ca_strat').value,name:document.getElementById('ca_name').value||undefined,budgetUSDC:parseInt(document.getElementById('ca_budget').value)||1000,minEdgePct:parseFloat(document.getElementById('ca_edge').value)||1.0,refreshSec:parseInt(document.getElementById('ca_refresh').value)||60};
  try{const r=await post('/api/agents',cfg);if(r.agent){toast('Agent created: '+r.agent.name,'success');closeModal();fetchAgents();}}catch(e){toast('Failed','error');}
}
async function quickCreateAgent(strat){try{const r=await post('/api/agents',{strategyType:strat});if(r.agent){toast('Created '+r.agent.name,'success');fetchAgents();}}catch(e){toast('Failed','error');}}
async function toggleAgentStatus(id){const a=agents.find(x=>x.id===id);if(!a)return;const ns=a.status==='running'?'paused':'running';try{await post('/api/agents/'+id,{status:ns});toast(ns==='running'?'Resumed':'Paused','info');fetchAgents();}catch(e){toast('Failed','error');}}
async function deleteAgentUI(id){try{await fetch('/api/agents/'+id,{method:'DELETE'});toast('Deleted','info');fetchAgents();}catch(e){toast('Failed','error');}}

// Approvals
async function fetchApprovals(){try{const d=await api('/api/approvals');approvals=d.approvals||[];renderApprovals();}catch(e){}}
function renderApprovals(){
  document.getElementById('cApprovals').textContent=approvals.filter(a=>a.status==='pending').length;
  if(!approvals.length){document.getElementById('approvalList').innerHTML='<div class="empty"><p>No approvals yet</p><p class="eh">Strategy agents will submit opportunities here for your review</p></div>';return;}
  document.getElementById('approvalList').innerHTML=approvals.map(a=>{
    const sc=a.status==='approved'?'approved':a.status==='rejected'?'rejected':'';
    return '<div class="approval-card '+sc+'"><div class="ap-h"><div class="ap-title">'+esc(a.payload?.title||a.rationale||'Unknown')+'</div><div class="ap-edge">'+(a.expectedEdge?a.expectedEdge.toFixed(2)+'%':'')+'</div></div><div class="ap-meta">Agent: '+(a.agentId?.slice(0,8)||'?')+' | Action: '+esc(a.actionType||'?')+' | '+new Date(a.ts).toLocaleTimeString()+'</div><div class="ap-rationale">'+esc(a.rationale||'')+'</div>'+(a.status==='pending'?'<div class="ap-actions"><button class="btn btn-g btn-sm" onclick="approveItem(\\''+a.id+'\\')">Approve</button><button class="btn btn-r btn-sm" onclick="rejectItem(\\''+a.id+'\\')">Reject</button><button class="btn btn-sm" onclick="showExplain(\\''+a.id+'\\')">Explain</button></div>':'<div style="font-family:var(--mono);font-size:10px;color:var(--t3)">Status: '+a.status+'</div>')+'</div>';
  }).join('');
}
async function approveItem(id){try{await post('/api/approvals/'+id+'/approve',{});toast('Approved','success');fetchApprovals();}catch(e){toast('Failed','error');}}
async function rejectItem(id){try{await post('/api/approvals/'+id+'/reject',{});toast('Rejected','info');fetchApprovals();}catch(e){toast('Failed','error');}}
function showExplain(id){
  const a=approvals.find(x=>x.id===id);if(!a||!a.payload?.explain)return;const ex=a.payload.explain;
  document.getElementById('marketModal').innerHTML='<div class="modal-overlay" onclick="closeModal(event)"><div class="modal" onclick="event.stopPropagation()"><div class="modal-h"><h2>Explain: '+esc(a.payload?.title||'')+'</h2><button class="modal-x" onclick="closeModal()">X</button></div><div class="modal-b"><h4 style="color:var(--cyan);font-family:var(--mono);font-size:11px;margin-bottom:8px">MATH</h4><pre style="background:rgba(0,0,0,.2);padding:10px;border-radius:6px;font-family:var(--mono);font-size:11px;color:var(--t2);overflow-x:auto;white-space:pre-wrap">'+esc(ex.math||'N/A')+'</pre><h4 style="color:var(--cyan);font-family:var(--mono);font-size:11px;margin:12px 0 8px">INPUTS</h4><pre style="background:rgba(0,0,0,.2);padding:10px;border-radius:6px;font-family:var(--mono);font-size:10px;color:var(--t2);overflow-x:auto;white-space:pre-wrap">'+esc(JSON.stringify(ex.inputs||{},null,2))+'</pre><h4 style="color:var(--cyan);font-family:var(--mono);font-size:11px;margin:12px 0 8px">ASSUMPTIONS</h4><ul style="padding-left:16px;font-size:11px;color:var(--t2)">'+(ex.assumptions||[]).map(a=>'<li>'+esc(a)+'</li>').join('')+'</ul><h4 style="color:var(--red);font-family:var(--mono);font-size:11px;margin:12px 0 8px">FAILURE MODES</h4><ul style="padding-left:16px;font-size:11px;color:var(--t2)">'+(ex.failureModes||[]).map(f=>'<li>'+esc(f)+'</li>').join('')+'</ul></div></div></div>';
}

// Strategy tabs
async function fetchStratOpps(tab){
  try{const d=await api('/api/strategy-opportunities?type='+(tab==='negrisk'?'negrisk_arb':'llm_probability'));
    const el=document.getElementById(tab+'Content');
    const items=d.opportunities||[];
    if(!items.length){el.innerHTML='<div class="empty"><p>No opportunities yet. Create an agent or wait for next scan.</p></div>';return;}
    el.innerHTML='<div class="tw"><table><thead><tr><th>Market</th><th>Edge%</th><th>Action</th><th>Confidence</th><th>Rationale</th></tr></thead><tbody>'+items.map(o=>'<tr><td class="mn">'+esc(o.title||'')+'</td><td class="'+(o.edgePct>=2?'edge-h':o.edgePct>=1?'edge-m':'edge-l')+'">'+(o.edgePct?.toFixed(2)||'?')+'%</td><td class="mono">'+esc(o.action||'')+'</td><td class="mono">'+(o.confidence?.toFixed(0)||'?')+'</td><td style="font-size:11px;color:var(--t2);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(o.rationaleSummary||'')+'</td></tr>').join('')+'</tbody></table></div>';
  }catch(e){}}

// Sentiment
async function analyzeHeadlines(){
  const text=document.getElementById('headlineBox').value.trim();if(!text){toast('Paste headlines first','error');return;}
  const lines=text.split('\\n').filter(l=>l.trim());
  try{const r=await post('/api/headlines',{headlines:lines});toast('Analyzing '+lines.length+' headlines...','info');
    if(r.results){document.getElementById('sentimentResults').innerHTML=r.results.map(x=>'<div style="padding:10px;background:var(--bg2);border:1px solid var(--bd);border-radius:6px;margin-bottom:6px"><div style="font-weight:600;font-size:12px;margin-bottom:4px">'+esc(x.headline||'')+'</div><div style="font-size:11px;color:var(--t2)">Direction: <span style="color:'+(x.direction==='bullish_yes'?'var(--green)':x.direction==='bearish_yes'?'var(--red)':'var(--t3)')+'">'+esc(x.direction||'?')+'</span> | Confidence: '+((x.confidence||0)*100).toFixed(0)+'%</div>'+(x.impactedMarkets?.length?'<div style="font-size:10px;color:var(--t3);margin-top:4px">Markets: '+x.impactedMarkets.map(m=>esc(m)).join(', ')+'</div>':'')+(x.rationale?'<div style="font-size:10px;color:var(--t2);margin-top:4px;font-style:italic">'+esc(x.rationale)+'</div>':'')+'</div>').join('');}
  }catch(e){toast('Failed','error');}
}

// Whales
async function fetchWhaleData(){try{const d=await api('/api/whales');renderWhales(d);}catch(e){}}
function renderWhales(d){
  const wallets=d?.wallets||[],events=d?.events||[];
  document.getElementById('whaleList').innerHTML=wallets.length?wallets.map(w=>'<div style="display:flex;gap:8px;align-items:center;padding:4px 0;font-size:11px"><span style="font-family:var(--mono);color:var(--cyan);font-weight:700">'+(w.alias||w.address.slice(0,8))+'</span><span class="mono">'+w.address.slice(0,10)+'...'+w.address.slice(-6)+'</span><button class="btn btn-sm btn-r" onclick="removeWhale(\\''+w.address+'\\')">x</button></div>').join(''):'<div style="font-size:11px;color:var(--t3);font-family:var(--mono)">No wallets tracked</div>';
  document.getElementById('whaleEvents').innerHTML=events.length?events.slice(0,50).map(e=>'<div class="whale-event"><span class="we-alias">'+esc(e.alias||e.wallet?.slice(0,8)||'?')+'</span><span class="we-side '+(e.side==='YES'?'we-yes':'we-no')+'">'+esc(e.side||'?')+'</span><span style="flex:1;font-size:11px;color:var(--t2)">'+esc(e.market||'')+'</span><span class="mono" style="font-size:9px">'+new Date(e.timestamp).toLocaleTimeString()+'</span>'+(e.source==='stub'?'<span style="font-size:8px;color:var(--yellow);font-family:var(--mono)">[stub]</span>':'')+'</div>').join(''):'<div class="empty" style="padding:20px"><p>No events yet</p></div>';
}
async function addWhale(){const addr=document.getElementById('whaleAddr').value.trim(),alias=document.getElementById('whaleAlias').value.trim();if(!addr){toast('Enter address','error');return;}try{await post('/api/whales',{address:addr,alias:alias||addr.slice(0,8)});toast('Wallet added','success');document.getElementById('whaleAddr').value='';document.getElementById('whaleAlias').value='';fetchWhaleData();}catch(e){toast('Failed','error');}}
async function removeWhale(addr){try{await post('/api/whales/remove',{address:addr});toast('Removed','info');fetchWhaleData();}catch(e){toast('Failed','error');}}

// Health + Diagnostics
async function runDiag(){try{const d=await api('/api/diagnostics');renderDiag(d.results||{});}catch(e){}}
function renderDiag(r){
  const testBtns={polymarketApi:'testPolymarket',polygonRpc:'testPolygon',clobAuth:'testClob',anthropic:'testLLMAnthropic',openai:'testLLMOpenAI',xai:'testLLMXAI'};
  document.getElementById('diagGrid').innerHTML='<div class="tw" style="margin-bottom:10px">'+Object.entries(r).map(([k,v])=>{
    const tb=testBtns[k];
    return '<div class="diag-item"><span class="diag-name">'+esc(k)+'</span><div style="display:flex;align-items:center;gap:8px"><span class="diag-status ds-'+(v.status||'unknown')+'">'+esc(v.status||'?')+'</span><span style="font-size:10px;color:var(--t3)">'+esc(v.message||'')+'</span>'+(tb?'<button class="btn btn-sm" onclick="diagTest(\\''+k+'\\',\\''+tb+'\\',this)">Test</button>':'')+'</div></div>';
  }).join('')+'</div>';
}
async function diagTest(key,fn,btn){
  btn.textContent='Testing...';btn.disabled=true;
  try{
    let r;
    if(fn==='testPolymarket')r=await post('/api/test/polymarket',{});
    else if(fn==='testPolygon')r=await post('/api/test/polygon',{});
    else if(fn==='testClob')r=await post('/api/test/clob',{});
    else if(fn==='testLLMAnthropic')r=await post('/api/test/llm',{provider:'anthropic'});
    else if(fn==='testLLMOpenAI')r=await post('/api/test/llm',{provider:'openai'});
    else if(fn==='testLLMXAI')r=await post('/api/test/llm',{provider:'xai'});
    btn.textContent=r.ok?'OK ('+r.latency+'ms)':'FAIL';
    btn.style.color=r.ok?'var(--green)':'var(--red)';
    toast(r.ok?key+': '+r.message:key+': '+r.message,r.ok?'success':'error');
  }catch(e){btn.textContent='Error';btn.style.color='var(--red)';toast('Test failed: '+e.message,'error');}
  btn.disabled=false;
}
async function fetchAgentHealth(){try{const d=await api('/api/health');const ag=d.agents||{};document.getElementById('healthGrid').innerHTML=Object.entries(ag).map(([n,i])=>{const ago=Math.round((Date.now()-i.lastSeen)/1000);return '<div class="agent-card" style="margin-bottom:8px"><div class="ac-h"><span class="ac-name">'+esc(n)+'</span><span class="status-pill st-'+(i.status||'idle')+'">'+(i.status||'?')+'</span></div><div style="font-size:11px;color:var(--t3);font-family:var(--mono)">Last seen: '+ago+'s ago | Interval: '+(i.interval/1000)+'s</div></div>';}).join('');}catch(e){}}

// Hub
async function fetchSysStatus(){try{const d=await api('/api/system-status');renderHub(d);}catch(e){}}
async function fetchActLog(){try{const d=await api('/api/activity-log');renderActFeed(d.log||[]);}catch(e){}}
function renderHub(h){
  let html='<div class="hub-card"><h3>System Overview</h3><p>ZVI v1 Fund OS. Scans prediction markets, runs strategy agents, surfaces opportunities with explainability.</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px">'+[['Uptime',h.uptimeFormatted],['Mode',h.mode],['Data',h.dataSource],['Markets',h.marketsInCache],['Agents',h.agentsCount],['Approvals',h.pendingApprovals],['Scans',h.totalScans],['Kill Switch',h.killSwitch?'ON':'OFF']].map(([l,v])=>'<div style="padding:6px 8px;background:rgba(0,0,0,.2);border-radius:4px"><div style="font-size:8px;color:var(--t3);font-family:var(--mono);text-transform:uppercase">'+l+'</div><div style="font-size:14px;font-weight:700;font-family:var(--mono)">'+v+'</div></div>').join('')+'</div></div>';
  html+='<div class="hub-card"><h3>Founder Status</h3><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">'+[['Fund','$'+(h.founder?.fundSize||0).toLocaleString()],['Deployed','$'+(h.founder?.capitalDeployed||0).toLocaleString()],['Decisions',h.founder?.totalDecisions||0],['BUY/PASS',(h.founder?.buys||0)+'/'+(h.founder?.passes||0)]].map(([l,v])=>'<div style="padding:6px 8px;background:rgba(0,0,0,.2);border-radius:4px"><div style="font-size:8px;color:var(--t3);font-family:var(--mono);text-transform:uppercase">'+l+'</div><div style="font-size:14px;font-weight:700;font-family:var(--mono)">'+v+'</div></div>').join('')+'</div></div>';
  html+='<div class="hub-card fw"><h3>Activity Log</h3><div class="act-feed" id="actFeed"><div style="color:var(--t3);font-size:11px;font-family:var(--mono)">Loading...</div></div></div>';
  document.getElementById('hubGrid').innerHTML=html;fetchActLog();
}
function renderActFeed(log){const el=document.getElementById('actFeed');if(!el)return;if(!log.length){el.innerHTML='<div style="color:var(--t3);font-family:var(--mono);font-size:11px">No activity</div>';return;}el.innerHTML=log.slice(0,80).map(e=>'<div class="act-entry"><span class="act-time">'+new Date(e.timestamp).toLocaleTimeString()+'</span><span class="act-type at-'+e.type+'">'+esc(e.type)+'</span><span class="act-msg">'+esc(e.message)+'</span></div>').join('');}

// Settings
function renderSettings(){
  api('/api/config').then(c=>{
    let h='<div class="settings-section"><h3>API Connections</h3><div class="settings-grid">'+
      sI('POLYMARKET_API_KEY','Polymarket API Key',c.secrets.polymarketClob,'password')+sI('POLYMARKET_API_SECRET','Polymarket Secret',c.secrets.polymarketClob,'password')+sI('POLYMARKET_API_PASSPHRASE','Polymarket Passphrase',c.secrets.polymarketClob,'password')+sI('POLYMARKET_PRIVATE_KEY','Wallet Private Key',c.secrets.polymarketPrivateKey,'password')+sI('ANTHROPIC_API_KEY','Anthropic Key',c.secrets.anthropicKey,'password')+sI('OPENAI_API_KEY','OpenAI Key',c.secrets.openaiKey,'password')+sI('XAI_API_KEY','xAI/Grok Key',c.secrets.xaiKey,'password')+sI('POLYGON_RPC_URL','Polygon RPC URL',c.secrets.polygonRpc,'text')+
      '</div><div style="margin-top:10px"><button class="btn btn-p" onclick="saveKeys()">Save API Keys</button></div></div>';
    h+='<div class="settings-section"><h3>Risk Limits</h3><div class="settings-grid">'+sN('MAX_EXPOSURE_PER_MARKET','Max Per Market ($)',c.riskLimits.maxExposurePerMarket)+sN('DAILY_MAX_EXPOSURE','Daily Max ($)',c.riskLimits.dailyMaxExposure)+sN('MIN_EDGE_THRESHOLD','Min Edge',c.riskLimits.minEdgeThreshold)+sN('MIN_DEPTH_USDC','Min Depth ($)',c.riskLimits.minDepthUsdc)+'</div><div style="margin-top:10px"><button class="btn btn-p" onclick="saveRiskLimits()">Save Limits</button></div></div>';
    h+='<div class="settings-section"><h3>Trading Mode</h3><div class="settings-grid"><div class="set-item"><label>Mode</label><select id="set_mode"><option value="true" '+(c.mode==='OBSERVATION_ONLY'?'selected':'')+'>Observation Only</option><option value="false" '+(c.mode!=='OBSERVATION_ONLY'?'selected':'')+'>Live Trading</option></select></div></div><div style="margin-top:10px"><button class="btn btn-p" onclick="saveMode()">Save Mode</button></div></div>';
    document.getElementById('settingsContent').innerHTML=h;
  }).catch(()=>{document.getElementById('settingsContent').innerHTML='<div class="empty"><p>Failed to load</p></div>';});
}
function sI(k,l,ok,t){return '<div class="set-item"><label>'+l+' <span class="set-st '+(ok?'ok':'no')+'">'+(ok?'OK':'MISSING')+'</span></label><input type="'+t+'" id="set_'+k+'" placeholder="'+l+'..."></div>';}
function sN(k,l,v){return '<div class="set-item"><label>'+l+'</label><input type="number" id="set_'+k+'" value="'+v+'" step="any"></div>';}
async function saveKeys(){const ks=['POLYMARKET_API_KEY','POLYMARKET_API_SECRET','POLYMARKET_API_PASSPHRASE','POLYMARKET_PRIVATE_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','XAI_API_KEY','POLYGON_RPC_URL'];const u={};ks.forEach(k=>{const el=document.getElementById('set_'+k);if(el?.value.trim())u[k]=el.value.trim();});if(!Object.keys(u).length){toast('Nothing to save','info');return;}try{const r=await post('/api/founder/update-env',u);if(r.ok){toast('Saved '+r.updated.length+' keys','success');ks.forEach(k=>{const el=document.getElementById('set_'+k);if(el)el.value='';});renderSettings();fetchBlockers();}}catch(e){toast('Failed','error');}}
async function saveRiskLimits(){const u={};['MAX_EXPOSURE_PER_MARKET','DAILY_MAX_EXPOSURE','MIN_EDGE_THRESHOLD','MIN_DEPTH_USDC'].forEach(k=>{const el=document.getElementById('set_'+k);if(el)u[k]=el.value;});try{const r=await post('/api/founder/update-env',u);if(r.ok)toast('Saved','success');}catch(e){toast('Failed','error');}}
async function saveMode(){const el=document.getElementById('set_mode');if(el)try{await post('/api/founder/update-env',{OBSERVATION_ONLY:el.value});toast('Mode saved. Restart for full effect.','success');loadCfg();}catch(e){toast('Failed','error');}}

// Commander
async function runCmd(){const inp=document.getElementById('cmdInput'),txt=inp.value.trim();if(!txt)return;inp.value='';document.getElementById('cmdOut').textContent='Running...';try{const r=await post('/api/command',{text:txt});document.getElementById('cmdOut').textContent=r.message||r.error||'Done';if(r.type==='created'||r.type==='kill')fetchAgents();}catch(e){document.getElementById('cmdOut').textContent='Error';}}

// Theme toggle
let currentTheme = localStorage.getItem('zvi-theme') || 'dark';
let simpleView = localStorage.getItem('zvi-view') === 'simple';
function toggleTheme(){
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.body.classList.toggle('hexa-light', currentTheme === 'light');
  document.getElementById('themeBtn').textContent = currentTheme === 'light' ? 'Terminal Dark' : 'Hexa Light';
  localStorage.setItem('zvi-theme', currentTheme);
}
function toggleView(){
  simpleView = !simpleView;
  document.getElementById('viewToggle').textContent = simpleView ? 'Advanced' : 'Simple';
  document.getElementById('viewToggle').classList.toggle('active', simpleView);
  localStorage.setItem('zvi-view', simpleView ? 'simple' : 'advanced');
  renderOpps();
}
function applyTheme(){
  if(currentTheme==='light')document.body.classList.add('hexa-light');
  document.getElementById('themeBtn').textContent=currentTheme==='light'?'Terminal Dark':'Hexa Light';
  if(simpleView){document.getElementById('viewToggle').textContent='Advanced';document.getElementById('viewToggle').classList.add('active');}
}

// Wizard modals for Action Queue
function openWizard(stepId){
  const wizards={
    'api-keys':{
      num:'Step 1 of 5',title:'Connect API Keys',
      what:'Configure your Polymarket CLOB API credentials so ZVI can read markets and submit orders.',
      why:'Without CLOB API keys, ZVI can only read public market data via Gamma. To view your positions and execute trades, you need authenticated CLOB access.',
      steps:['Go to <a href="https://polymarket.com" target="_blank" style="color:var(--cyan)">polymarket.com</a> and log in','Navigate to Settings > API Keys','Generate a new API key pair','Copy the Key, Secret, and Passphrase below'],
      fields:[{id:'wiz_api_key',label:'API Key',type:'password',placeholder:'Your Polymarket API Key',env:'POLYMARKET_API_KEY'},{id:'wiz_api_secret',label:'API Secret',type:'password',placeholder:'Your Polymarket API Secret',env:'POLYMARKET_API_SECRET'},{id:'wiz_api_pass',label:'Passphrase',type:'password',placeholder:'Your Polymarket Passphrase',env:'POLYMARKET_API_PASSPHRASE'}],
      testBtn:'Test Polymarket',testFn:'testPolymarket',
      defaults:'The public Gamma API (gamma-api.polymarket.com) works without keys for market data. CLOB keys are only required for authenticated actions.',
    },
    'wallet':{
      num:'Step 2 of 5',title:'Connect Wallet',
      what:'Add your Polygon wallet private key for signing transactions on-chain.',
      why:'Live trading on Polymarket requires signing transactions with a wallet key. In OBSERVE mode, this is optional but enables balance checking.',
      steps:['Export your private key from MetaMask or your wallet provider','This should be the wallet funded with USDC on Polygon','Ensure the wallet has some MATIC for gas fees','Paste the key below (stored in .env.local, never logged)'],
      fields:[{id:'wiz_wallet',label:'Private Key',type:'password',placeholder:'0x... (64 hex chars)',env:'POLYMARKET_PRIVATE_KEY'}],
      testBtn:null,
      defaults:'Key is validated as a 64-character hex string. Stored in .env.local on disk. Never printed in logs or UI (redacted to first/last 4 chars).',
    },
    'capital':{
      num:'Step 3 of 5',title:'Fund Capital Allocation',
      what:'Set how much USDC you want ZVI to manage. This is a bookkeeping limit, not a transfer.',
      why:'Position sizing uses Kelly Criterion relative to your fund size. Setting this correctly prevents over-allocation and enables proper risk management.',
      steps:['Enter the total USDC amount you want to allocate','This should match your actual wallet USDC balance','Start small (recommended: $1,000-$5,000 for initial testing)','You can adjust this anytime in Settings'],
      fields:[{id:'wiz_capital',label:'Fund Size (USDC)',type:'number',placeholder:'6000',env:'_capital'}],
      testBtn:null,
      defaults:'Default fund size: $6,000. Max per-market exposure: $500. Daily max: $2,000. All configurable in Settings > Risk Limits.',
    },
    'risks':{
      num:'Step 4 of 5',title:'Approve Risk Limits',
      what:'Review and approve the position sizing limits that constrain all trading activity.',
      why:'Risk limits are the safety guardrails. No trade can exceed these limits even if an agent requests it. Combined with OBSERVE mode and Kill Switch, this creates a multi-layer safety system.',
      steps:['Review the current risk limits below','Adjust if needed in Settings > Risk Limits','Click "Approve Limits" to unlock the approvals workflow','You can always re-review limits later'],
      fields:[],
      testBtn:null,
      defaults:'Conservative defaults: $500/market, $2,000/day, 2% min edge, $100 min liquidity. OBSERVE mode is ON by default — no trades execute without your explicit switch to LIVE.',
    },
    'trade':{
      num:'Step 5 of 5',title:'Approvals & Decisions',
      what:'Once the above steps are complete, strategy agents will surface opportunities for your review.',
      why:'ZVI never auto-executes in this phase. Every potential trade flows through the Approval Queue where you can approve, reject, or pass. You are the final decision-maker.',
      steps:['Agents scan markets and find opportunities','Qualifying opportunities appear in the Approval Queue tab','You review each with full explainability (math, assumptions, risks)','Approve to simulate/execute, or Reject/Pass to skip'],
      fields:[],
      testBtn:null,
      defaults:'In OBSERVE mode: approved trades are simulated only. Switch to LIVE mode + enable agent allowLive to execute real orders. Kill Switch halts everything instantly.',
    },
  };
  const w=wizards[stepId];if(!w)return;
  const fieldsHtml=w.fields.map(f=>'<div class="wizard-field"><label>'+f.label+'</label><input type="'+f.type+'" id="'+f.id+'" placeholder="'+f.placeholder+'"></div>').join('');
  const stepsHtml=w.steps.map((s,i)=>'<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px"><span style="font-family:var(--mono);font-size:11px;color:var(--cyan);min-width:18px">'+(i+1)+'.</span><span style="font-size:12px;color:var(--t2)">'+s+'</span></div>').join('');
  let riskHtml='';
  if(stepId==='risks'&&blockerData){
    const rl=blockerData.blockers?.find(b=>b.id==='risks');
    if(rl?.limits)riskHtml='<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0">'+Object.entries(rl.limits).map(([k,v])=>'<div style="padding:6px 8px;background:rgba(0,0,0,.15);border-radius:4px"><div style="font-size:8px;color:var(--t3);font-family:var(--mono);text-transform:uppercase">'+k.replace(/([A-Z])/g,' $1').trim()+'</div><div style="font-size:14px;font-weight:700;font-family:var(--mono)">'+v+'</div></div>').join('')+'</div>';
  }
  document.getElementById('marketModal').innerHTML='<div class="wizard-overlay" onclick="closeModal(event)"><div class="wizard" onclick="event.stopPropagation()"><div class="wizard-h"><div><span class="step-num">'+w.num+'</span><h2>'+w.title+'</h2></div><button class="modal-x" onclick="closeModal()">X</button></div><div class="wizard-body"><div class="wizard-section"><h4>What is this?</h4><p>'+w.what+'</p></div><div class="wizard-section"><h4>Why is it needed?</h4><p>'+w.why+'</p></div><div class="wizard-section"><h4>Steps</h4>'+stepsHtml+'</div>'+(fieldsHtml?'<div class="wizard-section"><h4>Configure</h4>'+fieldsHtml+'</div>':'')+riskHtml+'<div class="wizard-section"><h4>Defaults & Safety</h4><p style="font-size:11px;color:var(--t3);font-family:var(--mono)">'+w.defaults+'</p></div></div><div class="wizard-footer"><span class="test-result" id="wizTestResult"></span>'+(w.testBtn?'<button class="btn btn-sm" onclick="wizTest(\\''+w.testFn+'\\')">'+w.testBtn+'</button>':'')+(stepId==='risks'?'<button class="btn btn-g" onclick="wizApproveRisks()">Approve Limits</button>':'')+(stepId==='capital'?'<button class="btn btn-g" onclick="wizSetCapital()">Confirm Fund Size</button>':'')+(w.fields.length>0&&stepId!=='capital'?'<button class="btn btn-p" onclick="wizSaveFields(\\''+stepId+'\\')">Save</button>':'')+'</div></div></div>';
}

async function wizTest(fn){
  const el=document.getElementById('wizTestResult');el.textContent='Testing...';el.className='test-result';
  try{
    let r;
    if(fn==='testPolymarket')r=await post('/api/test/polymarket',{});
    else if(fn==='testLLM')r=await post('/api/test/llm',{});
    else if(fn==='testPolygon')r=await post('/api/test/polygon',{});
    else if(fn==='testClob')r=await post('/api/test/clob',{});
    el.textContent=r.ok?r.message:('FAIL: '+r.message);
    el.className='test-result '+(r.ok?'test-ok':'test-fail');
  }catch(e){el.textContent='Error: '+e.message;el.className='test-result test-fail';}
}

async function wizSaveFields(stepId){
  const u={};
  if(stepId==='api-keys'){
    ['wiz_api_key:POLYMARKET_API_KEY','wiz_api_secret:POLYMARKET_API_SECRET','wiz_api_pass:POLYMARKET_API_PASSPHRASE'].forEach(pair=>{
      const[id,env]=pair.split(':');const el=document.getElementById(id);if(el?.value.trim())u[env]=el.value.trim();
    });
  }else if(stepId==='wallet'){
    const el=document.getElementById('wiz_wallet');if(el?.value.trim())u.POLYMARKET_PRIVATE_KEY=el.value.trim();
  }
  if(!Object.keys(u).length){toast('Enter values first','error');return;}
  try{const r=await post('/api/founder/update-env',u);if(r.ok){toast('Saved '+r.updated.length+' key(s)','success');closeModal();fetchBlockers();}}catch(e){toast('Failed: '+e.message,'error');}
}

async function wizSetCapital(){
  const v=parseInt(document.getElementById('wiz_capital')?.value);
  if(!v||v<100){toast('Minimum $100','error');return;}
  try{const r=await post('/api/founder/set-capital',{fundSize:v});if(r.ok){blockerData=r.blockers;toast('Fund size: $'+v.toLocaleString(),'success');closeModal();renderAQ();renderFundBar();}}catch(e){toast('Failed','error');}
}

async function wizApproveRisks(){
  try{const r=await post('/api/founder/approve-risks',{});if(r.ok){blockerData=r.blockers;tradingUnlocked=r.blockers.allClear;toast('Risk limits approved','success');closeModal();renderAQ();if(opps.length)renderOpps();}}catch(e){toast('Failed','error');}
}

// Founder Console
function switchHubTab(tab){
  document.getElementById('hubChat').style.display=tab==='chat'?'flex':'none';
  document.getElementById('hubReport').style.display=tab==='report'?'block':'none';
  document.getElementById('hubActivity').style.display=tab==='activity'?'block':'none';
  ['hubTabChat','hubTabReport','hubTabActivity'].forEach(id=>{const el=document.getElementById(id);if(el){el.className='btn btn-sm';el.style.borderBottom='';}});
  const active=document.getElementById('hubTab'+tab.charAt(0).toUpperCase()+tab.slice(1));
  if(active){active.className='btn btn-p btn-sm';active.style.borderBottom='2px solid var(--cyan)';}
  if(tab==='report')fetchSystemReport();
  if(tab==='activity'){fetchSysStatus();fetchActLog();}
}

async function sendConsoleMsg(){
  const inp=document.getElementById('consoleInput');const q=inp.value.trim();if(!q)return;inp.value='';
  const msgs=document.getElementById('consoleMessages');
  msgs.innerHTML+='<div class="console-msg user">'+esc(q)+'</div>';
  msgs.innerHTML+='<div class="console-msg system" id="consoleLoading" style="opacity:.5">Thinking...</div>';
  msgs.scrollTop=msgs.scrollHeight;
  try{
    const r=await post('/api/console',{question:q});
    const loading=document.getElementById('consoleLoading');if(loading)loading.remove();
    msgs.innerHTML+='<div class="console-msg '+(r.source||'system')+'">'+esc(r.answer||'No response')+'</div>';
    msgs.scrollTop=msgs.scrollHeight;
  }catch(e){
    const loading=document.getElementById('consoleLoading');if(loading)loading.remove();
    msgs.innerHTML+='<div class="console-msg system test-fail">Error: '+esc(e.message)+'</div>';
  }
}

async function fetchSystemReport(){
  try{
    const r=await api('/api/system-report');
    const grid=document.getElementById('reportGrid');
    if(!r.sections){grid.innerHTML='<div class="empty"><p>Failed to load report</p></div>';return;}
    grid.innerHTML='<div style="font-size:10px;color:var(--t3);font-family:var(--mono);margin-bottom:8px">Generated: '+new Date(r.generated).toLocaleString()+'</div>'+
      r.sections.map(s=>'<div class="report-section"><h4>'+esc(s.title)+'</h4>'+
        s.items.map(i=>'<div class="report-item"><div class="ri-name"><span class="diag-status ds-'+(i.status||'unknown')+'" style="margin-right:6px">'+esc(i.status||'?')+'</span>'+esc(i.name)+'</div><div class="ri-detail">'+esc(i.detail)+'</div></div>').join('')+
      '</div>').join('');
  }catch(e){document.getElementById('reportGrid').innerHTML='<div class="empty"><p>Failed: '+esc(e.message)+'</p></div>';}
}

// Countdown
function startCountdown(){if(countdownInterval)clearInterval(countdownInterval);refreshCountdown=30;countdownInterval=setInterval(()=>{refreshCountdown--;const el=document.getElementById('rTimer');if(el)el.textContent=refreshCountdown+'s';if(refreshCountdown<=0){refreshCountdown=30;fetchOpps();}},1000);}

// Init
window.onerror=function(msg,src,line,col,err){document.getElementById('oppTable').innerHTML='<div class="empty" style="color:var(--red)"><p>JS Error: '+msg+'</p><p style="font-size:10px">'+src+':'+line+':'+col+'</p></div>';};
function init(){
  try{
    applyTheme();loadCfg();renderAQ();renderFundBar();renderOpps();
    fetchBlockers().catch(()=>{});fetchOpps().catch(()=>{});startCountdown();
    setInterval(fetchBlockers,30000);setInterval(()=>{agents.length&&fetchAgents();},30000);
    setTimeout(()=>api('/api/diagnostics').catch(()=>{}),2000);
  }catch(e){
    console.error('[init]',e);
    document.getElementById('oppTable').innerHTML='<div class="empty" style="color:var(--red)"><p>Init error: '+e.message+'</p></div>';
  }
}
init();
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
  const method = req.method;
  const pathname = url.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  try {
    // Health
    if (pathname === '/api/health' && method === 'GET') return jsonResp(res, { status: 'ok', uptime: process.uptime(), agents: store.agentHeartbeats });

    // Opportunities
    if (pathname === '/api/opportunities' && method === 'GET') {
      const opps = await fetchMarkets();
      return jsonResp(res, { opportunities: opps, count: opps.length });
    }

    // Agents CRUD
    if (pathname === '/api/agents' && method === 'GET') return jsonResp(res, { agents: store.agents });
    if (pathname === '/api/agents' && method === 'POST') {
      const body = await readBody(req);
      const agent = createAgent(body);
      // Run immediately
      setTimeout(() => runAgent(agent.id).catch(() => {}), 100);
      return jsonResp(res, { ok: true, agent });
    }
    if (pathname.startsWith('/api/agents/') && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await readBody(req);
      const agent = updateAgent(id, body);
      return agent ? jsonResp(res, { ok: true, agent }) : jsonResp(res, { error: 'Not found' }, 404);
    }
    if (pathname.startsWith('/api/agents/') && method === 'DELETE') {
      const id = pathname.split('/')[3];
      return jsonResp(res, { ok: deleteAgent(id) });
    }

    // Approvals
    if (pathname === '/api/approvals' && method === 'GET') return jsonResp(res, { approvals: store.approvalsQueue });
    if (pathname.match(/^\/api\/approvals\/[^/]+\/approve$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const item = store.approvalsQueue.find(a => a.id === id);
      if (!item) return jsonResp(res, { error: 'Not found' }, 404);
      item.status = 'approved';
      audit('info', 'approval_approved', { id, rationale: item.rationale });
      logActivity('decision', 'Approved: ' + (item.payload?.title || item.rationale || ''));
      // If in simulate mode, simulate; otherwise execute if live
      const agent = store.agents.find(a => a.id === item.agentId);
      if (agent && item.payload) {
        const { canTrade } = canExecuteTrades();
        if (canTrade && agent.config.mode === 'LIVE' && agent.config.allowLive) {
          // Would execute real trade here
          agent.stats.executed++;
        } else {
          // Simulate
          audit('info', 'trade_simulated_on_approve', item.payload);
        }
      }
      markDirty();
      return jsonResp(res, { ok: true });
    }
    if (pathname.match(/^\/api\/approvals\/[^/]+\/reject$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const item = store.approvalsQueue.find(a => a.id === id);
      if (!item) return jsonResp(res, { error: 'Not found' }, 404);
      item.status = 'rejected';
      audit('info', 'approval_rejected', { id });
      logActivity('decision', 'Rejected: ' + (item.payload?.title || ''));
      markDirty();
      return jsonResp(res, { ok: true });
    }

    // Strategy opportunities
    if (pathname === '/api/strategy-opportunities' && method === 'GET') {
      const type = url.searchParams.get('type');
      const opps = type ? store.strategyOpportunities.filter(o => o.strategyType === type) : store.strategyOpportunities;
      return jsonResp(res, { opportunities: opps });
    }

    // Kill switch
    if (pathname === '/api/kill-switch' && method === 'POST') {
      const body = await readBody(req);
      store.killSwitch = !!body.active;
      if (store.killSwitch) { store.agents.forEach(a => { a.status = 'paused'; }); }
      audit(store.killSwitch ? 'warn' : 'info', store.killSwitch ? 'kill_switch_on' : 'kill_switch_off', {});
      logActivity('system', store.killSwitch ? 'KILL SWITCH ACTIVATED' : 'Kill switch off');
      markDirty();
      return jsonResp(res, { ok: true, killSwitch: store.killSwitch });
    }

    // Headlines
    if (pathname === '/api/headlines' && method === 'POST') {
      const body = await readBody(req);
      const lines = body.headlines || [];
      store.headlines = lines.map(t => ({ text: t, source: 'manual', ts: new Date().toISOString() }));
      // Trigger sentiment agent if exists
      const sentAgent = store.agents.find(a => a.strategyType === 'sentiment' && a.status === 'running');
      let results = [];
      if (sentAgent) {
        const opps = await runAgent(sentAgent.id);
        results = store.sentimentResults;
      } else {
        // Auto-create and run
        const agent = createAgent({ strategyType: 'sentiment', name: 'sentiment-auto' });
        await runAgent(agent.id);
        results = store.sentimentResults;
      }
      return jsonResp(res, { ok: true, results, count: results.length });
    }

    // Whales
    if (pathname === '/api/whales' && method === 'GET') {
      return jsonResp(res, { wallets: store.whaleWallets, events: store.whaleEvents.slice(0, 50) });
    }
    if (pathname === '/api/whales' && method === 'POST') {
      const body = await readBody(req);
      if (!body.address) return jsonResp(res, { error: 'Address required' }, 400);
      if (!store.whaleWallets.find(w => w.address === body.address)) {
        store.whaleWallets.push({ address: body.address, alias: body.alias || body.address.slice(0, 8), addedAt: new Date().toISOString() });
        markDirty();
      }
      return jsonResp(res, { ok: true, wallets: store.whaleWallets });
    }
    if (pathname === '/api/whales/remove' && method === 'POST') {
      const body = await readBody(req);
      store.whaleWallets = store.whaleWallets.filter(w => w.address !== body.address);
      markDirty();
      return jsonResp(res, { ok: true, wallets: store.whaleWallets });
    }

    // Diagnostics
    if (pathname === '/api/diagnostics' && method === 'GET') {
      const results = await runDiagnostics();
      return jsonResp(res, { results, lastRun: store.diagnostics.lastRun });
    }

    // Test endpoints
    if (pathname === '/api/test/polymarket' && method === 'POST') {
      const result = await testPolymarketAuth();
      return jsonResp(res, result);
    }
    if (pathname === '/api/test/llm' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const result = await testLLMApi(body.provider);
      return jsonResp(res, result);
    }
    if (pathname === '/api/test/polygon' && method === 'POST') {
      const result = await testPolygonRpc();
      return jsonResp(res, result);
    }
    if (pathname === '/api/test/clob' && method === 'POST') {
      const result = await testClobAuth();
      return jsonResp(res, result);
    }

    // Founder Console
    if (pathname === '/api/console' && method === 'POST') {
      const body = await readBody(req);
      const result = await founderConsoleChat(body.question || '');
      return jsonResp(res, result);
    }
    if (pathname === '/api/system-report' && method === 'GET') {
      return jsonResp(res, generateSystemReport());
    }

    // Commander
    if (pathname === '/api/command' && method === 'POST') {
      const body = await readBody(req);
      const result = await parseCommand(body.text || '');
      return jsonResp(res, result);
    }

    // Signals
    if (pathname === '/api/signals' && method === 'GET') return jsonResp(res, { signals: store.signals, thresholds: store.thresholds });
    if (pathname === '/api/signals/thresholds' && method === 'POST') {
      const body = await readBody(req);
      store.thresholds.push({ id: crypto.randomUUID(), symbol: body.symbol, thresholdPrice: body.thresholdPrice, direction: body.direction, createdAt: new Date().toISOString() });
      return jsonResp(res, { ok: true, thresholds: store.thresholds });
    }
    if (pathname === '/api/price-update' && method === 'POST') {
      const body = await readBody(req);
      const triggered = checkThresholds(body.symbol, body.price);
      return jsonResp(res, { ok: true, triggered });
    }

    // Config
    if (pathname === '/api/config' && method === 'GET') return jsonResp(res, getConfig());
    if (pathname === '/api/system-status' && method === 'GET') return jsonResp(res, getSystemStatus());
    if (pathname === '/api/activity-log' && method === 'GET') return jsonResp(res, { log: activityLog.slice(0, 100), total: activityLog.length });
    if (pathname === '/api/settings' && method === 'GET') return jsonResp(res, store.settings);
    if (pathname === '/api/settings' && method === 'POST') {
      const body = await readBody(req);
      if (body.marketLimit !== undefined) store.settings.marketLimit = Math.max(10, Math.min(5000, parseInt(body.marketLimit) || 200));
      if (body.refreshInterval !== undefined) store.settings.refreshInterval = Math.max(10, Math.min(300, parseInt(body.refreshInterval) || 30));
      if (body.scanMode !== undefined) store.settings.scanMode = body.scanMode;
      return jsonResp(res, { ok: true, settings: store.settings });
    }
    if (pathname === '/api/founder/update-env' && method === 'POST') {
      const body = await readBody(req);
      return jsonResp(res, updateEnvFile(body));
    }
    if (pathname === '/api/blockers' && method === 'GET') return jsonResp(res, getBlockers());
    if (pathname === '/api/founder/set-capital' && method === 'POST') {
      const body = await readBody(req);
      const size = parseInt(body.fundSize);
      if (!size || size < 100) return jsonResp(res, { error: 'Min $100' }, 400);
      store.founder.fundSize = size;
      store.founder.capitalAllocated = true;
      logActivity('config', 'Fund capital: $' + size.toLocaleString());
      markDirty();
      return jsonResp(res, { ok: true, blockers: getBlockers() });
    }
    if (pathname === '/api/founder/approve-risks' && method === 'POST') {
      store.founder.risksApproved = true;
      logActivity('config', 'Risk limits approved');
      markDirty();
      return jsonResp(res, { ok: true, blockers: getBlockers() });
    }
    if (pathname === '/api/founder/decide' && method === 'POST') {
      const body = await readBody(req);
      const { marketId, verdict, market } = body;
      if (!marketId || !['BUY', 'PASS'].includes(verdict)) return jsonResp(res, { error: 'Invalid' }, 400);
      store.founder.decisions[marketId] = { verdict, market: market || '', timestamp: new Date().toISOString() };
      logActivity('decision', verdict + ': ' + (market || marketId));
      let position = null;
      if (verdict === 'BUY') {
        const opp = store.marketCache.data.find(o => o.id === marketId);
        if (opp) { position = recommendPosition(opp); store.founder.capitalDeployed += position.size; }
      }
      markDirty();
      return jsonResp(res, { ok: true, position, decisions: store.founder.decisions, capitalDeployed: store.founder.capitalDeployed });
    }

    // Audit log
    if (pathname === '/api/audit-log' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit')) || 100;
      return jsonResp(res, { log: store.auditLog.slice(-limit).reverse() });
    }

    // Trade execution
    if (pathname === '/api/trade/order' && method === 'POST') {
      const body = await readBody(req);
      const result = await createClobOrder(body);
      return jsonResp(res, result);
    }
    if (pathname === '/api/trade/cancel' && method === 'POST') {
      const body = await readBody(req);
      const result = await cancelClobOrder(body.orderId);
      return jsonResp(res, result);
    }
    if (pathname === '/api/trade/orders' && method === 'GET') {
      const orders = await fetchOpenOrders();
      return jsonResp(res, { orders });
    }

    // Dashboard
    if (pathname === '/' || pathname === '/index.html') {
      const html = dashboardHTML();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    jsonResp(res, { error: 'Not found', path: pathname }, 404);
  } catch (err) {
    console.error('[server] Error:', err);
    jsonResp(res, { error: 'Internal error', message: err.message }, 500);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT) || 3000;
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  logActivity('system', 'Server started on port ' + PORT);
  startAgentScheduler();
  // Auto-run diagnostics
  setTimeout(() => runDiagnostics().catch(() => {}), 3000);
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║   ZVI v1 — Fund Operating System                           ║');
  console.log('  ╠══════════════════════════════════════════════════════════════╣');
  console.log(`  ║   http://localhost:${PORT}                                    ║`);
  console.log('  ║   Mode: ' + (process.env.OBSERVATION_ONLY === 'true' ? 'OBSERVATION ONLY' : 'LIVE') + '                                         ║');
  console.log('  ║   Strategies: NegRisk Arb | LLM Prob | Sentiment | Whales  ║');
  console.log('  ║   Agents: ' + store.agents.length + ' loaded | Kill Switch: ' + (store.killSwitch ? 'ON' : 'OFF') + '                       ║');
  console.log('  ╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Keys: Polygon=' + (process.env.POLYGON_RPC_URL ? 'YES' : 'NO') + ' Anthropic=' + (process.env.ANTHROPIC_API_KEY ? 'YES' : 'NO') + ' Polymarket=' + (process.env.POLYMARKET_API_KEY ? 'YES' : 'NO') + ' xAI=' + (process.env.XAI_API_KEY ? 'YES' : 'NO'));
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') { console.error(`[fatal] Port ${PORT} in use`); process.exit(1); }
  console.error('[fatal]', err); process.exit(1);
});

process.on('SIGINT', () => { console.log('\n[shutdown] Saving state...'); saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 3000); });
process.on('SIGTERM', () => { console.log('\n[shutdown] Saving state...'); saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 3000); });
