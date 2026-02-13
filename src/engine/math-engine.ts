// ═══════════════════════════════════════════════════════════════
// ZVI v1 — Deterministic Math / Truth Engine
// THIS IS THE SOURCE OF TRUTH. No LLM touches these numbers.
// Every computation is pure: inputs → deterministic output.
// ═══════════════════════════════════════════════════════════════

import type {
  OutcomeLeg,
  NegRiskOpportunity,
  OpportunityType,
  OpportunityStatus,
  ConfidenceScore,
} from '@/lib/types';
import { v4 as uuid } from 'uuid';

// ── Constants ──
const DEFAULT_GAS_COST_USDC = 0.15;       // Polygon gas for convert tx
const SLIPPAGE_BUFFER_PER_LEG = 0.002;     // 0.2% per leg baseline
const STALE_THRESHOLD_MS = 60_000;         // 60s = stale orderbook
const MIN_EDGE_FOR_GO = 0.02;              // 2% net edge minimum
const MIN_EDGE_FOR_CONDITIONAL = 0.005;    // 0.5% for CONDITIONAL

// ── Core computations ──

/**
 * Compute Σ(prices) across all outcome legs.
 * For 1A: sum of YES ask prices.
 * For 1B: sum of NO ask prices (= sum of 1 - YES bid prices).
 */
export function computeSumPrices(legs: OutcomeLeg[]): number {
  return legs.reduce((sum, leg) => sum + leg.price, 0);
}

/**
 * Gross edge before any costs.
 * 1A (buy-all-YES): pays Σ(YES) to collect 1.00 on resolution → edge = 1 - Σ
 * 1B (buy-all-NO + convert): pays Σ(NO) then converts to 1.00 → edge = Σ(NO) - 1
 *   Note: for 1B, legs contain NO prices, so Σ(NO) > 1 means edge exists.
 *   Actually in 1B, sumPrices = Σ(YES) > 1.00, so buying NO = buying (1-YES each),
 *   Σ(NO) = N - Σ(YES), convert yields (N-1) per $1 of NO...
 *
 *   Correction: In NegRisk framework with N outcomes:
 *   1A: Σ(YES_i) < 1 → buy all YES for Σ, get 1.00 on resolution. Edge = 1 - Σ.
 *   1B: Σ(YES_i) > 1 → buy all NO (each NO_i costs 1 - YES_i),
 *       total cost of NO basket = N - Σ(YES_i),
 *       convert N NO tokens → extract (N-1) USDC.
 *       Edge = (N-1) - (N - Σ(YES_i)) = Σ(YES_i) - 1.
 */
export function computeGrossEdge(type: OpportunityType, sumPrices: number, _outcomeCount: number): number {
  if (type === '1A_BUY_ALL_YES') {
    return Math.max(0, 1 - sumPrices);
  } else {
    // 1B: edge = Σ(YES) - 1
    return Math.max(0, sumPrices - 1);
  }
}

/**
 * Estimate fees.
 * - Polymarket trading fee: ~2% on each leg (taker)
 * - NegRisk convert fee: feeRate from on-chain adapter
 */
export function computeFees(
  type: OpportunityType,
  grossEdge: number,
  feeRate: number | null,
  outcomeCount: number,
): number {
  // Trading fees: Polymarket charges ~2% on taker orders
  // For a basket of N legs, fee applies to each leg
  const tradingFeeRate = 0.02;
  const tradingFees = tradingFeeRate; // Applied as % of notional per leg, but on average it's ~2% of total

  // For 1B, add convert fee
  if (type === '1B_BUY_ALL_NO_CONVERT') {
    const convertFee = feeRate ?? 0.02; // Default assume 2% if unknown
    return tradingFees + convertFee;
  }

  return tradingFees;
}

/**
 * Estimate slippage based on orderbook depth.
 * More legs + less depth = more slippage.
 */
export function computeSlippage(legs: OutcomeLeg[], notional: number): number {
  if (legs.length === 0) return 0;

  let totalSlippage = 0;
  const perLegNotional = notional / legs.length;

  for (const leg of legs) {
    if (leg.depthUsdc <= 0) {
      totalSlippage += SLIPPAGE_BUFFER_PER_LEG * 3; // No depth = high slippage
    } else if (perLegNotional > leg.depthUsdc) {
      // Would need to walk the book
      const overflowRatio = perLegNotional / leg.depthUsdc;
      totalSlippage += SLIPPAGE_BUFFER_PER_LEG * Math.min(overflowRatio, 5);
    } else {
      totalSlippage += SLIPPAGE_BUFFER_PER_LEG;
    }
  }

  return totalSlippage / legs.length; // Average slippage rate
}

/**
 * Gas cost estimate for convert transaction (1B only).
 */
export function computeGasCost(type: OpportunityType): number {
  return type === '1B_BUY_ALL_NO_CONVERT' ? DEFAULT_GAS_COST_USDC : 0;
}

/**
 * Net edge = gross edge - fees - slippage - gas.
 */
export function computeNetEdge(
  grossEdge: number,
  fees: number,
  slippage: number,
  gasCost: number,
  notional: number,
): number {
  const gasPct = notional > 0 ? gasCost / notional : 0;
  return grossEdge - fees - slippage - gasPct;
}

/**
 * Minimum depth across all legs (bottleneck).
 */
export function computeMinDepth(legs: OutcomeLeg[]): number {
  if (legs.length === 0) return 0;
  return Math.min(...legs.map(l => l.depthUsdc));
}

/**
 * Maximum capital deployable given depth constraints.
 */
export function computeMaxNotional(legs: OutcomeLeg[]): number {
  // Limited by the thinnest leg
  return computeMinDepth(legs);
}

/**
 * Estimate capital lock duration for 1A (resolution arb).
 * Returns null if we can't estimate.
 */
export function estimateCapitalLockDays(_marketSlug: string): number | null {
  // In v1, we don't have end-date data readily. Return null.
  // Future: parse market end date from metadata.
  return null;
}

/**
 * Confidence score based on data quality.
 */
export function computeConfidence(
  legs: OutcomeLeg[],
  feeRate: number | null,
  minDepthThreshold: number,
): ConfidenceScore {
  const depthComplete = legs.every(l => l.depthUsdc >= minDepthThreshold);
  const allLegsLive = legs.every(l => !l.stale);
  const feeRateKnown = feeRate !== null;
  const legCount = legs.length;

  const factors: string[] = [];
  let score = 1.0;

  if (!depthComplete) {
    score -= 0.25;
    factors.push(`Some legs have depth < $${minDepthThreshold}`);
  }
  if (!allLegsLive) {
    score -= 0.2;
    factors.push('Stale orderbook data on some legs');
  }
  if (!feeRateKnown) {
    score -= 0.3;
    factors.push('On-chain feeRate unknown — using 2% estimate');
  }
  if (legCount > 10) {
    score -= 0.15;
    factors.push(`High leg count (${legCount}) increases fill risk`);
  } else if (legCount > 5) {
    score -= 0.05;
    factors.push(`Moderate leg count (${legCount})`);
  }

  if (factors.length === 0) {
    factors.push('All data quality checks passed');
  }

  return {
    overall: Math.max(0, Math.min(1, score)),
    depthComplete,
    allLegsLive,
    feeRateKnown,
    legCount,
    factors,
  };
}

/**
 * Determine opportunity status: GO / CONDITIONAL / KILL
 */
export function computeStatus(
  netEdge: number,
  confidence: ConfidenceScore,
  convertActive: boolean,
  type: OpportunityType,
): OpportunityStatus {
  // Kill if 1B and convert is not active
  if (type === '1B_BUY_ALL_NO_CONVERT' && !convertActive) return 'KILL';

  // Kill if negative edge
  if (netEdge <= 0) return 'KILL';

  // GO if strong edge + high confidence
  if (netEdge >= MIN_EDGE_FOR_GO && confidence.overall >= 0.6) return 'GO';

  // CONDITIONAL if marginal edge or lower confidence
  if (netEdge >= MIN_EDGE_FOR_CONDITIONAL) return 'CONDITIONAL';

  return 'KILL';
}

// ── Main pipeline: assemble a full opportunity ──

export interface MathEngineInput {
  marketId: string;
  conditionId: string;
  marketName: string;
  marketSlug: string;
  type: OpportunityType;
  legs: OutcomeLeg[];
  feeRate: number | null;
  convertActive: boolean;
  minDepthThreshold: number;
}

/**
 * PURE FUNCTION: takes raw market data → produces fully computed opportunity.
 * No side effects. No LLM. No network calls.
 */
export function computeOpportunity(input: MathEngineInput): NegRiskOpportunity {
  const {
    marketId, conditionId, marketName, marketSlug,
    type, legs, feeRate, convertActive, minDepthThreshold,
  } = input;

  const sumPrices = computeSumPrices(legs);
  const grossEdge = computeGrossEdge(type, sumPrices, legs.length);
  const estimatedFees = computeFees(type, grossEdge, feeRate, legs.length);
  const minDepth = computeMinDepth(legs);
  const maxNotional = computeMaxNotional(legs);
  const estimatedSlippage = computeSlippage(legs, maxNotional);
  const estimatedGasCost = computeGasCost(type);
  const netEdge = computeNetEdge(grossEdge, estimatedFees, estimatedSlippage, estimatedGasCost, maxNotional);
  const confidence = computeConfidence(legs, feeRate, minDepthThreshold);
  const status = computeStatus(netEdge, confidence, convertActive, type);
  const capitalLockDays = type === '1A_BUY_ALL_YES' ? estimateCapitalLockDays(marketSlug) : null;

  const now = new Date().toISOString();

  return {
    id: uuid(),
    marketId,
    conditionId,
    marketName,
    marketSlug,
    type,
    outcomes: legs,
    outcomeCount: legs.length,
    sumPrices: round(sumPrices, 6),
    grossEdge: round(grossEdge, 6),
    feeRate,
    estimatedFees: round(estimatedFees, 6),
    estimatedSlippage: round(estimatedSlippage, 6),
    estimatedGasCost: round(estimatedGasCost, 4),
    netEdge: round(netEdge, 6),
    minDepthUsdc: round(minDepth, 2),
    maxNotional: round(maxNotional, 2),
    capitalLockDays,
    convertActive,
    confidence,
    status,
    discoveredAt: now,
    updatedAt: now,
    approvalStatus: 'pending',
    approvedBy: null,
    approvedAt: null,
  };
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
