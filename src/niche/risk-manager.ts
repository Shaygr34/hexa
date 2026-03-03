// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Risk Manager
// Pure functions. No side effects. Every gate is testable.
// ═══════════════════════════════════════════════════════════════

import type { RiskConfig, SessionConfig, StrategyPerformance, RiskGateResult, Signal, Trade } from './types';

// ── Individual Risk Gates ──

export function gateMaxPosition(size: number, config: RiskConfig): RiskGateResult {
  return {
    gate: 'max_position',
    passed: size <= config.maxPositionUsdc,
    value: size,
    threshold: config.maxPositionUsdc,
    reason: size <= config.maxPositionUsdc
      ? `Position $${size.toFixed(2)} within $${config.maxPositionUsdc} limit`
      : `Position $${size.toFixed(2)} exceeds $${config.maxPositionUsdc} max`,
  };
}

export function gateMaxExposure(currentExposure: number, newSize: number, config: RiskConfig): RiskGateResult {
  const total = currentExposure + newSize;
  return {
    gate: 'max_exposure',
    passed: total <= config.maxExposureUsdc,
    value: total,
    threshold: config.maxExposureUsdc,
    reason: total <= config.maxExposureUsdc
      ? `Total exposure $${total.toFixed(2)} within $${config.maxExposureUsdc} limit`
      : `Total exposure $${total.toFixed(2)} exceeds $${config.maxExposureUsdc} max`,
  };
}

export function gateMaxOpenPositions(openCount: number, config: RiskConfig): RiskGateResult {
  return {
    gate: 'max_open_positions',
    passed: openCount < config.maxOpenPositions,
    value: openCount,
    threshold: config.maxOpenPositions,
    reason: openCount < config.maxOpenPositions
      ? `${openCount} open positions, max ${config.maxOpenPositions}`
      : `${openCount} open positions reached max ${config.maxOpenPositions}`,
  };
}

export function gateDrawdown(perf: StrategyPerformance, config: RiskConfig): RiskGateResult {
  const drawdownPct = perf.peakBankroll > 0
    ? ((perf.peakBankroll - perf.bankroll) / perf.peakBankroll) * 100
    : 0;
  return {
    gate: 'max_drawdown',
    passed: drawdownPct < config.maxDrawdownPct,
    value: drawdownPct,
    threshold: config.maxDrawdownPct,
    reason: drawdownPct < config.maxDrawdownPct
      ? `Drawdown ${drawdownPct.toFixed(1)}% within ${config.maxDrawdownPct}% limit`
      : `Drawdown ${drawdownPct.toFixed(1)}% exceeds ${config.maxDrawdownPct}% max`,
  };
}

export function gateCooldown(lastTradeAt: string | null, config: RiskConfig): RiskGateResult {
  if (!lastTradeAt) {
    return { gate: 'cooldown', passed: true, value: 'none', threshold: config.cooldownMs, reason: 'No previous trade' };
  }
  const elapsed = Date.now() - new Date(lastTradeAt).getTime();
  return {
    gate: 'cooldown',
    passed: elapsed >= config.cooldownMs,
    value: elapsed,
    threshold: config.cooldownMs,
    reason: elapsed >= config.cooldownMs
      ? `${(elapsed / 1000).toFixed(0)}s since last trade (min ${config.cooldownMs / 1000}s)`
      : `Only ${(elapsed / 1000).toFixed(0)}s since last trade (need ${config.cooldownMs / 1000}s)`,
  };
}

export function gateKillSwitch(config: RiskConfig): RiskGateResult {
  return {
    gate: 'kill_switch',
    passed: !config.killSwitch,
    value: config.killSwitch ? 'ON' : 'OFF',
    threshold: 'OFF',
    reason: config.killSwitch ? 'Kill switch is ON — all trading halted' : 'Kill switch OFF',
  };
}

export function gateEdgeThreshold(edge: number, threshold: number): RiskGateResult {
  return {
    gate: 'edge_threshold',
    passed: edge >= threshold,
    value: edge,
    threshold,
    reason: edge >= threshold
      ? `Edge ${(edge * 100).toFixed(1)}% meets ${(threshold * 100).toFixed(1)}% threshold`
      : `Edge ${(edge * 100).toFixed(1)}% below ${(threshold * 100).toFixed(1)}% threshold`,
  };
}

export function gateConfidence(confidence: number, minimum: number): RiskGateResult {
  return {
    gate: 'confidence_minimum',
    passed: confidence >= minimum,
    value: confidence,
    threshold: minimum,
    reason: confidence >= minimum
      ? `Confidence ${(confidence * 100).toFixed(0)}% meets ${(minimum * 100).toFixed(0)}% minimum`
      : `Confidence ${(confidence * 100).toFixed(0)}% below ${(minimum * 100).toFixed(0)}% minimum`,
  };
}

// ── Session Boundary Gates ──

export function gateSessionDuration(activatedAt: string | null, sessionConfig: SessionConfig): RiskGateResult {
  if (!activatedAt) return { gate: 'session_duration', passed: true, value: 0, threshold: sessionConfig.maxDurationMs, reason: 'Not yet activated' };
  const elapsed = Date.now() - new Date(activatedAt).getTime();
  return {
    gate: 'session_duration',
    passed: elapsed < sessionConfig.maxDurationMs,
    value: elapsed,
    threshold: sessionConfig.maxDurationMs,
    reason: elapsed < sessionConfig.maxDurationMs
      ? `${(elapsed / 60000).toFixed(0)}min elapsed of ${(sessionConfig.maxDurationMs / 60000).toFixed(0)}min max`
      : `Session time limit reached: ${(elapsed / 60000).toFixed(0)}min >= ${(sessionConfig.maxDurationMs / 60000).toFixed(0)}min`,
  };
}

export function gateMaxTotalTrades(totalTrades: number, sessionConfig: SessionConfig): RiskGateResult {
  return {
    gate: 'max_total_trades',
    passed: totalTrades < sessionConfig.maxTotalTrades,
    value: totalTrades,
    threshold: sessionConfig.maxTotalTrades,
    reason: totalTrades < sessionConfig.maxTotalTrades
      ? `${totalTrades} trades of ${sessionConfig.maxTotalTrades} max`
      : `Trade limit reached: ${totalTrades} >= ${sessionConfig.maxTotalTrades}`,
  };
}

export function gateDailyLoss(dailyPnl: number, sessionConfig: SessionConfig): RiskGateResult {
  const loss = Math.abs(Math.min(0, dailyPnl));
  return {
    gate: 'daily_loss_limit',
    passed: loss < sessionConfig.dailyLossLimitUsdc,
    value: loss,
    threshold: sessionConfig.dailyLossLimitUsdc,
    reason: loss < sessionConfig.dailyLossLimitUsdc
      ? `Daily loss $${loss.toFixed(2)} within $${sessionConfig.dailyLossLimitUsdc} limit`
      : `Daily loss $${loss.toFixed(2)} exceeds $${sessionConfig.dailyLossLimitUsdc} limit`,
  };
}

export function gateConsecutiveLosses(streak: number, sessionConfig: SessionConfig): RiskGateResult {
  const losses = Math.abs(Math.min(0, streak));
  return {
    gate: 'consecutive_losses',
    passed: losses < sessionConfig.maxConsecutiveLosses,
    value: losses,
    threshold: sessionConfig.maxConsecutiveLosses,
    reason: losses < sessionConfig.maxConsecutiveLosses
      ? `${losses} consecutive losses, max ${sessionConfig.maxConsecutiveLosses}`
      : `${losses} consecutive losses reached max ${sessionConfig.maxConsecutiveLosses}`,
  };
}

export function gateMinBankroll(bankroll: number, sessionConfig: SessionConfig): RiskGateResult {
  return {
    gate: 'min_bankroll',
    passed: bankroll >= sessionConfig.minBankrollUsdc,
    value: bankroll,
    threshold: sessionConfig.minBankrollUsdc,
    reason: bankroll >= sessionConfig.minBankrollUsdc
      ? `Bankroll $${bankroll.toFixed(2)} above $${sessionConfig.minBankrollUsdc} minimum`
      : `Bankroll $${bankroll.toFixed(2)} below $${sessionConfig.minBankrollUsdc} minimum`,
  };
}

export function gateTrailingStop(perf: StrategyPerformance, sessionConfig: SessionConfig): RiskGateResult {
  if (perf.peakBankroll <= perf.initialBankroll) {
    return { gate: 'trailing_stop', passed: true, value: 0, threshold: sessionConfig.trailingStopPct, reason: 'No peak above initial — trailing stop not active' };
  }
  const dropPct = ((perf.peakBankroll - perf.bankroll) / perf.peakBankroll) * 100;
  return {
    gate: 'trailing_stop',
    passed: dropPct < sessionConfig.trailingStopPct,
    value: dropPct,
    threshold: sessionConfig.trailingStopPct,
    reason: dropPct < sessionConfig.trailingStopPct
      ? `${dropPct.toFixed(1)}% from peak, trailing stop at ${sessionConfig.trailingStopPct}%`
      : `Trailing stop triggered: ${dropPct.toFixed(1)}% drop from peak exceeds ${sessionConfig.trailingStopPct}%`,
  };
}

// ── Aggregate Gate Check ──

export interface GateCheckInput {
  tradeSize: number;
  currentExposure: number;
  openPositions: number;
  lastTradeAt: string | null;
  edge: number;
  confidence: number;
  edgeThreshold: number;
  confidenceMinimum: number;
  riskConfig: RiskConfig;
  sessionConfig: SessionConfig;
  performance: StrategyPerformance;
}

export function runAllGates(input: GateCheckInput): { passed: boolean; gates: RiskGateResult[]; blockers: string[] } {
  const gates: RiskGateResult[] = [
    gateKillSwitch(input.riskConfig),
    gateEdgeThreshold(input.edge, input.edgeThreshold),
    gateConfidence(input.confidence, input.confidenceMinimum),
    gateMaxPosition(input.tradeSize, input.riskConfig),
    gateMaxExposure(input.currentExposure, input.tradeSize, input.riskConfig),
    gateMaxOpenPositions(input.openPositions, input.riskConfig),
    gateDrawdown(input.performance, input.riskConfig),
    gateCooldown(input.lastTradeAt, input.riskConfig),
    gateSessionDuration(input.performance.lastUpdated, input.sessionConfig),
    gateMaxTotalTrades(input.performance.totalTrades, input.sessionConfig),
    gateDailyLoss(input.performance.totalPnl, input.sessionConfig),
    gateConsecutiveLosses(input.performance.currentStreak, input.sessionConfig),
    gateMinBankroll(input.performance.bankroll, input.sessionConfig),
    gateTrailingStop(input.performance, input.sessionConfig),
  ];

  const blockers = gates.filter(g => !g.passed).map(g => g.gate);
  return { passed: blockers.length === 0, gates, blockers };
}

// ── Position Sizing (fixed-fraction, mirrors crypto15m) ──

export function computePositionSize(
  bankroll: number,
  stakeFraction: number = 0.05,
  maxStake: number = 10,
  price: number = 0.5,
): { size: number; shares: number } {
  const rawStake = bankroll * stakeFraction;
  const size = Math.min(rawStake, maxStake);
  const shares = size / price;
  return { size: Math.round(size * 100) / 100, shares: Math.round(shares * 100) / 100 };
}

// ── Fee calculation (mirrors crypto15m takerFee curve) ──

export function takerFee(p: number, feeRate: number = 0.25, exponent: number = 2): number {
  return feeRate * Math.pow(p * (1 - p), exponent);
}

// ── Should auto-stop? ──

export function shouldAutoStop(
  perf: StrategyPerformance,
  activatedAt: string | null,
  riskConfig: RiskConfig,
  sessionConfig: SessionConfig,
): { stop: boolean; reason: string | null } {
  const checks = [
    gateSessionDuration(activatedAt, sessionConfig),
    gateMaxTotalTrades(perf.totalTrades, sessionConfig),
    gateDailyLoss(perf.totalPnl, sessionConfig),
    gateConsecutiveLosses(perf.currentStreak, sessionConfig),
    gateMinBankroll(perf.bankroll, sessionConfig),
    gateTrailingStop(perf, sessionConfig),
    gateDrawdown(perf, riskConfig),
    gateKillSwitch(riskConfig),
  ];

  const failed = checks.find(c => !c.passed);
  return failed
    ? { stop: true, reason: failed.reason }
    : { stop: false, reason: null };
}
