// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Trade Executor
// 3 modes: observe (log only), paper (shadow bankroll), live (CLOB).
// Paper mode mirrors crypto15m-controller.mjs shadow bankroll pattern.
// ═══════════════════════════════════════════════════════════════

import { getDb } from '@/lib/db';
import { v4 as uuid } from 'uuid';
import { placeOrder } from '@/adapters/polymarket/clob-api';
import { fetchMarketById } from '@/adapters/polymarket/gamma-api';
import { computePositionSize, takerFee } from './risk-manager';
import { appendLog } from './db-niche';
import type { Signal, Trade, StrategyPerformance, NicheStrategy, ExecutionMode } from './types';

/**
 * Execute a signal based on the strategy's execution mode.
 */
export async function executeSignal(
  signal: Signal,
  strategy: NicheStrategy,
  performance: StrategyPerformance,
): Promise<Trade | null> {
  if (signal.action === 'HOLD') return null;

  const mode = strategy.executionMode;

  switch (mode) {
    case 'observe':
      return executeObserve(signal, strategy);
    case 'paper':
      return executePaper(signal, strategy, performance);
    case 'live':
      return executeLive(signal, strategy, performance);
    default:
      return null;
  }
}

function executeObserve(signal: Signal, strategy: NicheStrategy): Trade | null {
  appendLog(strategy.id, 'trade', 'trade-executor',
    `[OBSERVE] Would ${signal.action} on ${signal.marketSlug} | edge: ${(signal.edge * 100).toFixed(1)}%`,
    { signalId: signal.id, action: signal.action, edge: signal.edge });
  return null; // No trade in observe mode
}

function executePaper(signal: Signal, strategy: NicheStrategy, perf: StrategyPerformance): Trade {
  const side = signal.action === 'BUY_YES' ? 'YES' : 'NO';
  const price = signal.action === 'BUY_YES' ? signal.marketPrice : (1 - signal.marketPrice);
  const fee = takerFee(price);

  const { size, shares } = computePositionSize(
    perf.bankroll, 0.05, strategy.riskConfig.maxPositionUsdc, price,
  );

  const feeAmount = size * fee;
  const slippage = size * 0.002; // 0.2% simulated slippage

  const trade: Trade = {
    id: uuid(),
    strategyId: strategy.id,
    signalId: signal.id,
    marketId: signal.marketId,
    marketSlug: signal.marketSlug,
    side,
    price,
    size,
    shares,
    fees: Math.round(feeAmount * 10000) / 10000,
    slippage: Math.round(slippage * 10000) / 10000,
    status: 'filled',
    demo: true,
    orderId: null,
    resolution: 'pending',
    realizedPnl: null,
    provenance: {
      estimatedProbability: signal.estimatedProbability,
      edge: signal.edge,
      confidence: signal.confidence,
      reasoning: signal.reasoning,
      bankrollAtEntry: perf.bankroll,
    },
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };

  // Persist trade
  const db = getDb();
  db.prepare(`
    INSERT INTO niche_trades (id, strategy_id, signal_id, market_id, market_slug, side, price, size, shares, fees, slippage, status, demo, order_id, resolution, realized_pnl, provenance_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trade.id, trade.strategyId, trade.signalId, trade.marketId, trade.marketSlug,
    trade.side, trade.price, trade.size, trade.shares, trade.fees, trade.slippage,
    trade.status, 1, null, 'pending', null, JSON.stringify(trade.provenance), trade.createdAt,
  );

  // Update bankroll: deduct cost + fees
  const totalCost = size + feeAmount + slippage;
  updateBankroll(strategy.id, -totalCost);

  appendLog(strategy.id, 'trade', 'trade-executor',
    `[PAPER] ${side} ${shares.toFixed(2)} shares @ ${(price * 100).toFixed(1)}c | cost: $${totalCost.toFixed(2)} | bankroll: $${(perf.bankroll - totalCost).toFixed(2)}`,
    { tradeId: trade.id, side, price, size, shares, fees: feeAmount, slippage });

  return trade;
}

async function executeLive(signal: Signal, strategy: NicheStrategy, perf: StrategyPerformance): Promise<Trade | null> {
  const apiKey = process.env.POLYMARKET_API_KEY;
  const apiSecret = process.env.POLYMARKET_API_SECRET;
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE;

  if (!apiKey || !apiSecret || !apiPassphrase) {
    appendLog(strategy.id, 'error', 'trade-executor', 'Live mode requires POLYMARKET_API_* credentials', {});
    return null;
  }

  const side = signal.action === 'BUY_YES' ? 'YES' : 'NO';
  const price = signal.action === 'BUY_YES' ? signal.marketPrice : (1 - signal.marketPrice);

  const { size, shares } = computePositionSize(
    perf.bankroll, 0.05, strategy.riskConfig.maxPositionUsdc, price,
  );

  // Find the right token ID
  const market = strategy.targetMarkets.find(m => m.conditionId === signal.marketId);
  if (!market) {
    appendLog(strategy.id, 'error', 'trade-executor', `Market ${signal.marketId} not found in targets`, {});
    return null;
  }

  const tokenId = side === 'YES' ? market.tokenIds.yes : market.tokenIds.no;

  try {
    const result = await placeOrder(
      { tokenId, side: 'BUY', price, size: shares, type: 'FOK' },
      { apiKey, apiSecret, apiPassphrase },
    );

    const trade: Trade = {
      id: uuid(),
      strategyId: strategy.id,
      signalId: signal.id,
      marketId: signal.marketId,
      marketSlug: signal.marketSlug,
      side,
      price,
      size,
      shares,
      fees: size * takerFee(price),
      slippage: 0,
      status: 'filled',
      demo: false,
      orderId: result.orderId,
      resolution: 'pending',
      realizedPnl: null,
      provenance: { estimatedProbability: signal.estimatedProbability, edge: signal.edge },
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };

    const db = getDb();
    db.prepare(`
      INSERT INTO niche_trades (id, strategy_id, signal_id, market_id, market_slug, side, price, size, shares, fees, slippage, status, demo, order_id, resolution, realized_pnl, provenance_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.id, trade.strategyId, trade.signalId, trade.marketId, trade.marketSlug,
      trade.side, trade.price, trade.size, trade.shares, trade.fees, trade.slippage,
      trade.status, 0, result.orderId, 'pending', null, JSON.stringify(trade.provenance), trade.createdAt,
    );

    appendLog(strategy.id, 'trade', 'trade-executor',
      `[LIVE] ${side} ${shares.toFixed(2)} shares @ ${(price * 100).toFixed(1)}c | orderId: ${result.orderId}`,
      { tradeId: trade.id, orderId: result.orderId });

    return trade;
  } catch (err: any) {
    appendLog(strategy.id, 'error', 'trade-executor', `Live order failed: ${err.message}`, { error: err.message });
    return null;
  }
}

/**
 * Resolve pending paper trades by checking if market has resolved.
 */
export async function resolvePendingTrades(strategyId: string): Promise<void> {
  const db = getDb();
  const pending = db.prepare(`
    SELECT * FROM niche_trades WHERE strategy_id = ? AND resolution = 'pending' AND demo = 1
  `).all(strategyId) as any[];

  for (const trade of pending) {
    try {
      const market = await fetchMarketById(trade.market_id);
      if (!market) continue;

      const tokens = market.tokens || [];
      const relevantToken = tokens.find(t =>
        (trade.side === 'YES' && t.outcome === 'Yes') ||
        (trade.side === 'NO' && t.outcome === 'No')
      );

      if (!relevantToken || !relevantToken.winner) continue;
      if (relevantToken.winner === undefined) continue;

      const won = relevantToken.winner === true;
      const payout = won ? trade.shares * 1.0 : 0;
      const pnl = payout - trade.size - trade.fees - trade.slippage;
      const resolution = won ? 'won' : 'lost';
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE niche_trades SET resolution = ?, realized_pnl = ?, resolved_at = ? WHERE id = ?
      `).run(resolution, pnl, now, trade.id);

      // Update bankroll
      updateBankroll(strategyId, payout); // return payout to bankroll

      appendLog(strategyId, 'trade', 'trade-executor',
        `[RESOLVED] ${trade.market_slug} ${trade.side}: ${resolution} | PnL: $${pnl.toFixed(2)}`,
        { tradeId: trade.id, resolution, pnl });

    } catch (err: any) {
      // Market not resolved yet — that's fine
    }
  }
}

// ── Performance Updates ──

function updateBankroll(strategyId: string, delta: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE niche_performance
    SET bankroll = bankroll + ?,
        peak_bankroll = MAX(peak_bankroll, bankroll + ?),
        max_drawdown = MAX(max_drawdown, peak_bankroll - (bankroll + ?)),
        last_updated = ?
    WHERE strategy_id = ?
  `).run(delta, delta, delta, new Date().toISOString(), strategyId);
}

export function updatePerformanceStats(strategyId: string): StrategyPerformance {
  const db = getDb();

  const trades = db.prepare(`
    SELECT * FROM niche_trades WHERE strategy_id = ? ORDER BY created_at ASC
  `).all(strategyId) as any[];

  const resolved = trades.filter(t => t.resolution === 'won' || t.resolution === 'lost');
  const wins = resolved.filter(t => t.resolution === 'won');
  const losses = resolved.filter(t => t.resolution === 'lost');
  const pendingCount = trades.filter(t => t.resolution === 'pending').length;

  const totalPnl = resolved.reduce((sum, t) => sum + (t.realized_pnl || 0), 0);
  const winRate = resolved.length > 0 ? wins.length / resolved.length : 0;

  const perf = db.prepare('SELECT * FROM niche_performance WHERE strategy_id = ?').get(strategyId) as any;
  const bankroll = perf?.bankroll || 100;
  const initialBankroll = perf?.initial_bankroll || 100;
  const totalPnlPct = initialBankroll > 0 ? (totalPnl / initialBankroll) * 100 : 0;
  const peakBankroll = perf?.peak_bankroll || bankroll;
  const maxDrawdown = perf?.max_drawdown || 0;
  const maxDrawdownPct = peakBankroll > 0 ? (maxDrawdown / peakBankroll) * 100 : 0;

  // Streak calculation
  let currentStreak = 0;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const r = resolved[i].resolution;
    if (i === resolved.length - 1) {
      currentStreak = r === 'won' ? 1 : -1;
    } else if (r === 'won' && currentStreak > 0) {
      currentStreak++;
    } else if (r === 'lost' && currentStreak < 0) {
      currentStreak--;
    } else {
      break;
    }
  }

  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.realized_pnl || 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + (t.realized_pnl || 0), 0) / losses.length) : 0;
  const totalWinAmount = wins.reduce((s, t) => s + Math.max(0, t.realized_pnl || 0), 0);
  const totalLossAmount = Math.abs(losses.reduce((s, t) => s + Math.min(0, t.realized_pnl || 0), 0));
  const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : null;

  // Build equity curve
  let equity = initialBankroll;
  const equityCurve = [{ t: perf?.last_updated || new Date().toISOString(), v: initialBankroll }];
  for (const t of resolved) {
    equity += t.realized_pnl || 0;
    equityCurve.push({ t: t.resolved_at || t.created_at, v: equity });
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE niche_performance SET
      total_trades = ?, wins = ?, losses = ?, pending = ?,
      win_rate = ?, total_pnl = ?, total_pnl_pct = ?,
      max_drawdown_pct = ?, sharpe_estimate = NULL,
      current_streak = ?, avg_win_size = ?, avg_loss_size = ?,
      profit_factor = ?, equity_curve_json = ?, last_updated = ?
    WHERE strategy_id = ?
  `).run(
    trades.length, wins.length, losses.length, pendingCount,
    winRate, totalPnl, totalPnlPct, maxDrawdownPct,
    currentStreak, avgWin, avgLoss, profitFactor,
    JSON.stringify(equityCurve.slice(-200)), now, strategyId,
  );

  return {
    strategyId,
    bankroll,
    initialBankroll,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    pending: pendingCount,
    winRate,
    totalPnl,
    totalPnlPct,
    peakBankroll,
    maxDrawdown,
    maxDrawdownPct,
    sharpeEstimate: null,
    currentStreak,
    longestWinStreak: 0, // TODO: compute from resolved history
    longestLossStreak: 0,
    avgWinSize: avgWin,
    avgLossSize: avgLoss,
    profitFactor,
    equityCurve,
    lastUpdated: now,
  };
}

export function getPerformance(strategyId: string): StrategyPerformance {
  const db = getDb();
  const row = db.prepare('SELECT * FROM niche_performance WHERE strategy_id = ?').get(strategyId) as any;
  if (!row) {
    return {
      strategyId, bankroll: 100, initialBankroll: 100, totalTrades: 0, wins: 0, losses: 0, pending: 0,
      winRate: 0, totalPnl: 0, totalPnlPct: 0, peakBankroll: 100, maxDrawdown: 0, maxDrawdownPct: 0,
      sharpeEstimate: null, currentStreak: 0, longestWinStreak: 0, longestLossStreak: 0,
      avgWinSize: 0, avgLossSize: 0, profitFactor: null, equityCurve: [], lastUpdated: new Date().toISOString(),
    };
  }
  return {
    strategyId: row.strategy_id,
    bankroll: row.bankroll,
    initialBankroll: row.initial_bankroll,
    totalTrades: row.total_trades,
    wins: row.wins,
    losses: row.losses,
    pending: row.pending,
    winRate: row.win_rate,
    totalPnl: row.total_pnl,
    totalPnlPct: row.total_pnl_pct,
    peakBankroll: row.peak_bankroll,
    maxDrawdown: row.max_drawdown,
    maxDrawdownPct: row.max_drawdown_pct,
    sharpeEstimate: row.sharpe_estimate,
    currentStreak: row.current_streak,
    longestWinStreak: row.longest_win_streak,
    longestLossStreak: row.longest_loss_streak,
    avgWinSize: row.avg_win_size,
    avgLossSize: row.avg_loss_size,
    profitFactor: row.profit_factor,
    equityCurve: JSON.parse(row.equity_curve_json || '[]'),
    lastUpdated: row.last_updated,
  };
}
