// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Strategy Controller
// The main loop per strategy. Generalizes crypto15m-controller.
// poll sources → aggregate → decide → execute → log
// ═══════════════════════════════════════════════════════════════

import { getStrategy, transitionStatus, updateStrategy } from './strategy-manager';
import { getSourcesForStrategy, getAllSourceStates } from './data-source-registry';
import { pollAllSources } from './data-poller';
import { aggregate, getActiveEvents, clearBuffers } from './aggregated-event-bus';
import { updateMarketStates, getMarketStates, autoDiscoverMarkets } from './market-scanner';
import { generateSignals } from './decision-engine';
import { executeSignal, resolvePendingTrades, updatePerformanceStats, getPerformance } from './trade-executor';
import { shouldAutoStop } from './risk-manager';
import { appendLog, pruneOldRawEvents, pruneExpiredCompoundEvents } from './db-niche';
import type { NicheStrategy } from './types';

// Active controller loops (in-memory)
const activeControllers = new Map<string, { timer: NodeJS.Timeout; cycleCount: number; running: boolean }>();

export function isControllerRunning(strategyId: string): boolean {
  return activeControllers.has(strategyId);
}

export function getControllerStats(strategyId: string): { cycleCount: number; running: boolean } | null {
  return activeControllers.get(strategyId) || null;
}

/**
 * Start the controller loop for a strategy.
 */
export async function startController(strategyId: string): Promise<void> {
  if (activeControllers.has(strategyId)) {
    throw new Error(`Controller already running for strategy ${strategyId}`);
  }

  const strategy = getStrategy(strategyId);
  if (!strategy) throw new Error(`Strategy ${strategyId} not found`);
  if (strategy.status !== 'active') {
    throw new Error(`Strategy must be active to start controller (current: ${strategy.status})`);
  }

  const state = { cycleCount: 0, running: true, timer: null as any };
  activeControllers.set(strategyId, state as any);

  appendLog(strategyId, 'info', 'controller', `Controller started | interval: ${strategy.decisionIntervalMs}ms | mode: ${strategy.executionMode}`, {});

  // Run first cycle immediately
  await runCycle(strategyId);

  // Set up recurring interval
  state.timer = setInterval(async () => {
    if (!state.running) return;
    try {
      await runCycle(strategyId);
    } catch (err: any) {
      appendLog(strategyId, 'error', 'controller', `Cycle error: ${err.message}`, { error: err.message });
    }
  }, strategy.decisionIntervalMs);

  (activeControllers.get(strategyId) as any).timer = state.timer;
}

/**
 * Stop the controller loop.
 */
export function stopController(strategyId: string, reason?: string): void {
  const state = activeControllers.get(strategyId);
  if (!state) return;

  state.running = false;
  clearInterval(state.timer);
  activeControllers.delete(strategyId);
  clearBuffers(strategyId);

  appendLog(strategyId, 'info', 'controller', `Controller stopped${reason ? `: ${reason}` : ''}`, { reason, totalCycles: state.cycleCount });
}

/**
 * Single cycle of the strategy controller.
 */
async function runCycle(strategyId: string): Promise<void> {
  const state = activeControllers.get(strategyId);
  if (!state || !state.running) return;

  const strategy = getStrategy(strategyId);
  if (!strategy || strategy.status !== 'active') {
    stopController(strategyId, 'Strategy no longer active');
    return;
  }

  state.cycleCount++;
  const cycleStart = Date.now();

  try {
    // 1. Check auto-stop conditions
    const perf = getPerformance(strategyId);
    const autoStop = shouldAutoStop(perf, strategy.activatedAt, strategy.riskConfig, strategy.sessionConfig);
    if (autoStop.stop) {
      appendLog(strategyId, 'warn', 'controller', `Auto-stop triggered: ${autoStop.reason}`, { reason: autoStop.reason });
      stopController(strategyId, autoStop.reason!);
      transitionStatus(strategyId, 'stopped', autoStop.reason!);
      return;
    }

    // 2. Poll all data sources
    const sources = getSourcesForStrategy(strategyId);
    const templateVars = { topic: strategy.topic, markets: strategy.targetMarkets.map(m => m.slug).join(', ') };
    const rawEvents = await pollAllSources(sources, templateVars);

    // 3. Aggregate into compound events
    const compoundEvents = aggregate(strategyId, rawEvents);

    // 4. Update market states
    const marketStates = await updateMarketStates(strategyId, strategy.targetMarkets);

    // 5. Get all active (non-expired) compound events for decision making
    const activeEvents = getActiveEvents(strategyId);

    // 6. Warmup check: skip trading during warmup phase
    if (state.cycleCount <= (strategy.sessionConfig.warmupCycles || 0)) {
      appendLog(strategyId, 'info', 'controller',
        `Warmup cycle ${state.cycleCount}/${strategy.sessionConfig.warmupCycles} — observing only`,
        { cycle: state.cycleCount, rawEvents: rawEvents.length, compoundEvents: compoundEvents.length });
      return;
    }

    // 7. Generate signals (AI decision)
    const openTrades = getOpenTradeCount(strategyId);
    const lastTradeAt = getLastTradeTime(strategyId);
    const signals = await generateSignals(strategy, activeEvents, marketStates, perf, openTrades, lastTradeAt);

    // 8. Execute actionable signals
    for (const signal of signals) {
      if (signal.action !== 'HOLD') {
        await executeSignal(signal, strategy, perf);
      }
    }

    // 9. Resolve pending paper trades
    if (strategy.executionMode === 'paper') {
      await resolvePendingTrades(strategyId);
    }

    // 10. Update performance stats
    updatePerformanceStats(strategyId);

    // 11. Periodic cleanup
    if (state.cycleCount % 50 === 0) {
      pruneOldRawEvents(strategyId, 1000);
      pruneExpiredCompoundEvents();
    }

    // 12. Periodic market re-discovery (every 20 cycles)
    if (state.cycleCount % 20 === 0) {
      try {
        const freshStrategy = getStrategy(strategyId);
        if (freshStrategy) {
          const existingSlugs = new Set(freshStrategy.targetMarkets.map(m => m.conditionId));
          const discovered = await autoDiscoverMarkets(freshStrategy.topic, freshStrategy.meta);
          const newMarkets = discovered.filter(m => !existingSlugs.has(m.conditionId));
          if (newMarkets.length > 0) {
            // Strategy is active — directly update target_markets_json bypassing the active check
            const db = getDb();
            const allMarkets = [...freshStrategy.targetMarkets, ...newMarkets];
            db.prepare('UPDATE niche_strategies SET target_markets_json = ?, updated_at = ? WHERE id = ?')
              .run(JSON.stringify(allMarkets), new Date().toISOString(), strategyId);
            appendLog(strategyId, 'info', 'controller',
              `Re-discovery found ${newMarkets.length} new market(s): ${newMarkets.map(m => m.slug).join(', ')}`,
              { newMarkets: newMarkets.map(m => m.slug) });
          }
          // Also prune inactive/closed markets
          const activeMarkets = freshStrategy.targetMarkets.filter(m => m.active);
          const closedCount = freshStrategy.targetMarkets.length - activeMarkets.length;
          if (closedCount > 0) {
            const db = getDb();
            db.prepare('UPDATE niche_strategies SET target_markets_json = ?, updated_at = ? WHERE id = ?')
              .run(JSON.stringify(activeMarkets), new Date().toISOString(), strategyId);
            appendLog(strategyId, 'info', 'controller',
              `Pruned ${closedCount} closed/inactive market(s)`, {});
          }
        }
      } catch (err: any) {
        appendLog(strategyId, 'warn', 'controller', `Market re-discovery failed: ${err.message}`, {});
      }
    }

    const elapsed = Date.now() - cycleStart;
    appendLog(strategyId, 'info', 'controller',
      `Cycle ${state.cycleCount} complete in ${elapsed}ms | raw: ${rawEvents.length} | compound: ${compoundEvents.length} | signals: ${signals.length} | active events: ${activeEvents.length}`,
      { cycle: state.cycleCount, elapsed, rawEvents: rawEvents.length, compoundEvents: compoundEvents.length, signals: signals.length });

  } catch (err: any) {
    appendLog(strategyId, 'error', 'controller', `Cycle ${state.cycleCount} failed: ${err.message}`, { error: err.message });

    // Auto-stop on repeated errors if configured
    if (strategy.sessionConfig.autoStopOnError) {
      const recentErrors = getRecentErrorCount(strategyId);
      if (recentErrors >= 5) {
        stopController(strategyId, 'Too many consecutive errors');
        transitionStatus(strategyId, 'error', 'Too many consecutive errors');
      }
    }
  }
}

// ── Helpers ──

import { getDb } from '@/lib/db';

function getOpenTradeCount(strategyId: string): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as count FROM niche_trades WHERE strategy_id = ? AND resolution = 'pending'`).get(strategyId) as any;
  return row?.count || 0;
}

function getLastTradeTime(strategyId: string): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT created_at FROM niche_trades WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1`).get(strategyId) as any;
  return row?.created_at || null;
}

function getRecentErrorCount(strategyId: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM niche_logs
    WHERE strategy_id = ? AND level = 'error' AND timestamp > datetime('now', '-5 minutes')
  `).get(strategyId) as any;
  return row?.count || 0;
}
