// Backfill shadow_bankroll.json from existing crypto15m_shadow.jsonl
// Usage: node scripts/backfill_bankroll.mjs
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SHADOW_PATH = join(process.cwd(), 'crypto15m_shadow.jsonl');
const BANKROLL_PATH = join(process.cwd(), 'shadow_bankroll.json');
const BANKROLL_START = 100;
const STAKE_FRACTION = 0.05;
const MAX_STAKE_USDC = 10;

const lines = readFileSync(SHADOW_PATH, 'utf-8').trim().split('\n').filter(Boolean);
const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Build separate maps for pending and resolved entries
const pendingById = new Map();
const resolvedById = new Map();
for (const e of entries) {
  if (!e.id) continue;
  if (e.status === 'pending') pendingById.set(e.id, e);
  if (e.status === 'resolved') resolvedById.set(e.id, e);
}

// Filter to resolved with real outcomes (not UNRESOLVED / FETCH_ERROR)
const resolved = Array.from(resolvedById.values())
  .filter(e => e.outcome !== 'UNRESOLVED' && e.outcome !== 'FETCH_ERROR')
  .sort((a, b) => new Date(a.resolvedAt || a.ts).getTime() - new Date(b.resolvedAt || b.ts).getTime());

console.log(`Found ${resolved.length} resolved trades to backfill`);

// For buyPrice reconstruction: merge pending entry data into resolved
// The pending entry was created at proposal time and may have buyPrice
// The resolved entry overwrites but may lack it
function getBuyPrice(res) {
  // 1. Check resolved entry
  if (res.buyPrice != null) return res.buyPrice;
  // 2. Check pending entry (written at proposal time, may have buyPrice)
  const pend = pendingById.get(res.id);
  if (pend && pend.buyPrice != null) return pend.buyPrice;
  // 3. Approximate: if side=UP, buyPrice ~ upMid ask ≈ upMid + small spread
  //    if side=DN, buyPrice ~ dnMid ask ≈ dnMid + small spread
  //    Use mid as approximation (spread is typically small)
  if (res.side === 'UP' && res.upMid != null) return res.upMid;
  if (res.side === 'DN' && res.dnMid != null) return res.dnMid;
  return null;
}

const state = {
  bankroll: BANKROLL_START,
  totalTrades: 0,
  wins: 0,
  losses: 0,
  peakBankroll: BANKROLL_START,
  maxDrawdown: 0,
  equity: [],
};

let skipped = 0;
let fromPending = 0;
let fromApprox = 0;

for (const p of resolved) {
  const won = p.won === true;
  const buyPrice = getBuyPrice(p);

  if (buyPrice == null || buyPrice <= 0) {
    skipped++;
    continue;
  }

  // Track source
  if (p.buyPrice != null) { /* from resolved directly */ }
  else if (pendingById.get(p.id)?.buyPrice != null) fromPending++;
  else fromApprox++;

  const fees = p.fees ?? 0;
  const slippage = p.slippage ?? 0;
  const buffer = p.buffer ?? 0.005;
  const costs = fees + slippage + buffer;

  // Compute stake from bankroll at time of entry
  const stakeUsdc = Math.min(state.bankroll * STAKE_FRACTION, MAX_STAKE_USDC);
  const shares = stakeUsdc / buyPrice;

  // PnL: win pays $1/share, lose pays $0/share
  const perSharePnl = (won ? 1 - buyPrice : -buyPrice) - costs;
  const tradePnl = parseFloat((shares * perSharePnl).toFixed(6));

  state.bankroll += tradePnl;
  state.totalTrades++;
  if (won) state.wins++;
  else state.losses++;
  if (state.bankroll > state.peakBankroll) state.peakBankroll = state.bankroll;
  const dd = state.peakBankroll - state.bankroll;
  if (dd > state.maxDrawdown) state.maxDrawdown = dd;

  state.equity.push({
    ts: p.resolvedAt || p.ts,
    bankroll: parseFloat(state.bankroll.toFixed(4)),
    tradeId: p.id,
    pnl: tradePnl,
  });
}

state.bankroll = parseFloat(state.bankroll.toFixed(4));
state.peakBankroll = parseFloat(state.peakBankroll.toFixed(4));
state.maxDrawdown = parseFloat(state.maxDrawdown.toFixed(4));

writeFileSync(BANKROLL_PATH, JSON.stringify(state, null, 2));
console.log(`Backfilled ${state.totalTrades} trades (skipped ${skipped} with no buyPrice)`);
console.log(`buyPrice sources: ${fromPending} from pending, ${fromApprox} from mid approximation`);
console.log(`Bankroll: $${state.bankroll.toFixed(2)} (started $${BANKROLL_START})`);
console.log(`W/L: ${state.wins}/${state.losses} (${state.totalTrades > 0 ? (state.wins / state.totalTrades * 100).toFixed(1) : 0}%)`);
console.log(`Peak: $${state.peakBankroll.toFixed(2)} | Max DD: $${state.maxDrawdown.toFixed(2)}`);
console.log(`Saved to ${BANKROLL_PATH}`);
