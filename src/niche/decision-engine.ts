// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Decision Engine
// Reads active compound events + market state → calls Claude →
// parses probability estimate → computes edge → risk gates → Signal.
// ═══════════════════════════════════════════════════════════════

import { getDb } from '@/lib/db';
import { v4 as uuid } from 'uuid';
import { getLLMAdapter } from '@/adapters/llm/factory';
import { buildProbabilityEstimationPrompt, parseProbabilityResponse } from './prompts/probability-estimation';
import { runAllGates, computePositionSize, takerFee } from './risk-manager';
import { appendLog } from './db-niche';
import type {
  NicheStrategy, AggregatedEvent, MarketState,
  Signal, StrategyPerformance, RiskGateResult,
} from './types';

/**
 * Generate signals for all target markets given active compound events.
 */
export async function generateSignals(
  strategy: NicheStrategy,
  activeEvents: AggregatedEvent[],
  marketStates: MarketState[],
  performance: StrategyPerformance,
  openPositions: number,
  lastTradeAt: string | null,
): Promise<Signal[]> {
  const llm = getLLMAdapter();
  if (!llm) {
    appendLog(strategy.id, 'warn', 'decision-engine', 'No LLM adapter available — skipping signal generation', {});
    return [];
  }

  const signals: Signal[] = [];

  for (const market of marketStates) {
    try {
      // Build prompt with active events
      const prompt = buildProbabilityEstimationPrompt({
        topic: strategy.topic,
        marketQuestion: market.question,
        currentYesPrice: market.yesPrice,
        meta: strategy.meta,
        activeEvents,
        marketState: market,
      });

      // Call LLM
      const response = await llm.complete(prompt);
      const parsed = parseProbabilityResponse(response);

      if (!parsed) {
        appendLog(strategy.id, 'warn', 'decision-engine',
          `Failed to parse LLM response for ${market.slug}`, { response: response.slice(0, 500) });
        continue;
      }

      // Compute edge
      const edge = parsed.action === 'BUY_YES'
        ? parsed.estimatedProbability - market.yesPrice
        : parsed.action === 'BUY_NO'
          ? (1 - parsed.estimatedProbability) - market.noPrice
          : 0;

      // Fee-adjusted edge
      const price = parsed.action === 'BUY_YES' ? market.yesPrice : market.noPrice;
      const fee = takerFee(price);
      const netEdge = edge - fee;

      // Position sizing
      const { size } = computePositionSize(
        performance.bankroll,
        0.05,
        strategy.riskConfig.maxPositionUsdc,
        price,
      );

      // Run risk gates
      const gateResult = runAllGates({
        tradeSize: size,
        currentExposure: performance.totalTrades > 0 ? performance.bankroll - performance.initialBankroll : 0,
        openPositions,
        lastTradeAt,
        edge: netEdge,
        confidence: parsed.confidence,
        edgeThreshold: strategy.edgeThresholdPct,
        confidenceMinimum: strategy.confidenceMinimum,
        riskConfig: strategy.riskConfig,
        sessionConfig: strategy.sessionConfig,
        performance,
      });

      // Determine final action (gates can override to HOLD)
      const finalAction = gateResult.passed ? parsed.action : 'HOLD';
      const outcome = finalAction === 'HOLD' ? 'skipped' : 'pending';

      const signal: Signal = {
        id: uuid(),
        strategyId: strategy.id,
        marketId: market.conditionId,
        marketSlug: market.slug,
        action: finalAction,
        estimatedProbability: parsed.estimatedProbability,
        marketPrice: market.yesPrice,
        edge: netEdge,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
        activeEvents: activeEvents.map(e => e.id),
        riskGates: gateResult.gates,
        outcome,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };

      // Persist signal
      const db = getDb();
      db.prepare(`
        INSERT INTO niche_signals (id, strategy_id, market_id, market_slug, action, estimated_probability, market_price, edge, confidence, reasoning_json, active_events_json, risk_gates_json, outcome, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        signal.id, signal.strategyId, signal.marketId, signal.marketSlug,
        signal.action, signal.estimatedProbability, signal.marketPrice,
        signal.edge, signal.confidence,
        JSON.stringify(signal.reasoning), JSON.stringify(signal.activeEvents),
        JSON.stringify(signal.riskGates), signal.outcome, signal.createdAt,
      );

      signals.push(signal);

      appendLog(strategy.id, 'decision', 'decision-engine',
        `Signal: ${signal.action} on ${market.slug} | edge: ${(netEdge * 100).toFixed(1)}% | conf: ${(parsed.confidence * 100).toFixed(0)}%${gateResult.blockers.length > 0 ? ` | BLOCKED: ${gateResult.blockers.join(', ')}` : ''}`,
        { signalId: signal.id, action: signal.action, edge: netEdge, confidence: parsed.confidence, blockers: gateResult.blockers });

    } catch (err: any) {
      appendLog(strategy.id, 'error', 'decision-engine',
        `Signal generation failed for ${market.slug}: ${err.message}`,
        { market: market.slug, error: err.message });
    }
  }

  return signals;
}
