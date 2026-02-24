// ═══════════════════════════════════════════════════════════════
// ZVI v1 — Core Types
// Deterministic types. No LLM interpretation in this file.
// ═══════════════════════════════════════════════════════════════

// ── NegRisk Opportunity ──

export type OpportunityType = '1A_BUY_ALL_YES' | '1B_BUY_ALL_NO_CONVERT';
export type OpportunityStatus = 'GO' | 'CONDITIONAL' | 'KILL';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'simulated' | 'executed';

export interface OutcomeLeg {
  tokenId: string;
  outcome: string;
  price: number;          // best ask for YES (1A) or best ask for NO (1B)
  depthUsdc: number;      // available depth at best price
  spread: number;         // bid-ask spread
  stale: boolean;         // orderbook last updated > 60s ago
}

export interface NegRiskOpportunity {
  id: string;
  marketId: string;
  conditionId: string;
  marketName: string;
  marketSlug: string;
  type: OpportunityType;
  outcomes: OutcomeLeg[];
  outcomeCount: number;

  // Deterministic computations (Math Engine output)
  sumPrices: number;             // Σ(YES prices) for 1A, Σ(NO prices) for 1B
  grossEdge: number;             // 1 - sumPrices (1A) or sumPrices - 1 (1B)
  feeRate: number | null;        // on-chain NegRiskAdapter feeRate (null = unknown)
  estimatedFees: number;         // feeRate * notional
  estimatedSlippage: number;     // based on depth analysis
  estimatedGasCost: number;      // for 1B convert tx
  netEdge: number;               // grossEdge - fees - slippage - gas
  minDepthUsdc: number;          // minimum depth across all legs
  maxNotional: number;           // max capital deployable given depth
  capitalLockDays: number | null; // estimated for 1A (null if unknown)
  convertActive: boolean;        // for 1B: is convert available

  // Confidence scoring
  confidence: ConfidenceScore;
  status: OpportunityStatus;

  // Timestamps
  discoveredAt: string;
  updatedAt: string;

  // Approval
  approvalStatus: ApprovalStatus;
  approvedBy: string | null;
  approvedAt: string | null;

  // Optional LLM narrative (interpretation only)
  narrative?: string;
}

export interface ConfidenceScore {
  overall: number;          // 0-1
  depthComplete: boolean;   // all legs have depth > threshold
  allLegsLive: boolean;     // no stale orderbooks
  feeRateKnown: boolean;    // on-chain feeRate successfully fetched
  legCount: number;         // more legs = more fill risk
  factors: string[];        // human-readable factor descriptions
}

// ── Pinned Market (LLM Probability Engine) ──

export interface PinnedMarket {
  id: string;
  marketId: string;
  marketName: string;
  marketSlug: string;
  marketPrice: number;           // current market implied probability
  zviProbability: number | null; // LLM-derived probability
  confidenceLow: number | null;  // confidence band low
  confidenceHigh: number | null; // confidence band high
  mispricingGap: number | null;  // zviProbability - marketPrice
  reasoning: string[];           // bullet points with citations
  sources: string[];             // URLs backing each claim
  suggestedAction: 'BUY_YES' | 'BUY_NO' | 'HOLD' | null;
  lastAnalyzedAt: string | null;
  pinnedAt: string;
  pinnedBy: string;
}

// ── Signal / RP Optical-style Alert ──

export interface PriceThreshold {
  id: string;
  symbol: string;           // e.g. "RPOL"
  exchange: string;         // e.g. "TASE"
  currency: string;         // e.g. "ILS"
  thresholdPrice: number;   // trigger at this price
  direction: 'below' | 'above' | 'cross';
  active: boolean;
  createdAt: string;
}

export interface SignalAlert {
  id: string;
  thresholdId: string;
  symbol: string;
  triggeredPrice: number;
  thresholdPrice: number;
  direction: string;
  report: OpticalReport;
  triggeredAt: string;
  acknowledged: boolean;
}

export interface OpticalReport {
  executiveSummary: string;
  whatMakesThisSpecial: string[];
  multiTimeframeActions: TimeframeAction[];
  riskRules: RiskRule[];
  assumptions: string[];
  verdictChangers: string[];
}

export interface TimeframeAction {
  timeframe: string;       // "1h", "24h", "7d" or "1m", "3m", "12m"
  action: string;          // "BUY", "HOLD", "SELL", "ACCUMULATE"
  probability: number;     // confidence in this action
  rationale: string;
}

export interface RiskRule {
  type: 'stop_loss' | 'invalidation' | 'max_loss' | 'time_stop';
  description: string;
  trigger: string;
  action: string;
}

// ── Control / Config ──

export interface RiskLimits {
  maxExposurePerMarket: number;
  dailyMaxExposure: number;
  minEdgeThreshold: number;
  minDepthUsdc: number;
}

export interface SystemConfig {
  observationOnly: boolean;
  manualApprovalRequired: boolean;
  autoExec: boolean;
  killSwitch: boolean;
  riskLimits: RiskLimits;
}

export interface AgentHealth {
  agentId: string;
  agentName: string;
  status: 'running' | 'stopped' | 'error';
  lastHeartbeat: string | null;
  lastError: string | null;
  cycleCount: number;
}

// ── Audit ──

export interface AuditRecord {
  id: string;
  timestamp: string;
  module: 'negrisk' | 'llm_engine' | 'signal_watcher' | 'execution';
  action: string;
  inputs: Record<string, unknown>;
  computedMetrics: Record<string, unknown>;
  llmNarrative: string | null;
  founderAction: string | null;
  result: string | null;
}

// ── Polymarket API Types ──

export interface GammaMarket {
  id: string;
  condition_id?: string;
  conditionId?: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  // API returns camelCase
  negRisk?: boolean;
  negRiskMarketID?: string;
  negRiskRequestID?: string;
  // Legacy snake_case aliases
  neg_risk?: boolean;
  neg_risk_market_id?: string;
  neg_risk_request_id?: string;
  outcomes: string[] | string;  // API returns JSON string
  outcomePrices?: string[] | string;
  clobTokenIds?: string;  // JSON string of token IDs
  tokens?: GammaToken[];
  rewards?: { min_size: number; max_spread: number; rates: any[] };
  groupItemTitle?: string;
}

export interface GammaToken {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

export interface CLOBOrderbook {
  market: string;
  asset_id: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: string;
  hash: string;
}

export interface OrderbookLevel {
  price: string;
  size: string;
}
