// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Core Types
// All TypeScript interfaces for the generalized strategy system.
// ═══════════════════════════════════════════════════════════════

// ── Strategy ──

export type StrategyStatus = 'draft' | 'validating' | 'active' | 'paused' | 'stopped' | 'error';
export type ExecutionMode = 'observe' | 'paper' | 'live';
export type SignalAction = 'BUY_YES' | 'BUY_NO' | 'HOLD';
export type TradeStatus = 'pending' | 'filled' | 'cancelled' | 'failed';
export type DataSourceType = 'api' | 'polymarket' | 'llm';
export type SourceHealth = 'healthy' | 'degraded' | 'down';

export type CompoundEventType =
  | 'temporal_coincidence'
  | 'cross_source_confirmation'
  | 'divergence'
  | 'momentum_shift'
  | 'anomaly'
  | 'single_source';

export type EventDirection = 'bullish' | 'bearish' | 'neutral';

export interface RiskConfig {
  maxPositionUsdc: number;
  maxExposureUsdc: number;
  maxDrawdownPct: number;
  stopLossPct: number;
  maxOpenPositions: number;
  cooldownMs: number;
  killSwitch: boolean;
}

export interface StrategyMeta {
  horizon: string;          // e.g. "15m", "1h", "1d"
  patternType: string;      // e.g. "momentum", "mean_reversion", "event_driven"
  dataType: string;         // e.g. "price", "sentiment", "on_chain"
  eventFrequency: string;   // e.g. "high", "medium", "low"
  marketType: string;       // e.g. "crypto_short_term", "politics", "sports"
}

export interface SessionConfig {
  maxDurationMs: number;         // max time the strategy runs before auto-stop
  maxTotalTrades: number;        // hard cap on total trades placed
  budgetUsdc: number;            // total USDC budget for the session
  dailyLossLimitUsdc: number;    // stop if daily losses exceed this
  dailyLossLimitPct: number;     // stop if daily loss % exceeds this
  maxConsecutiveLosses: number;  // stop after N consecutive losses
  trailingStopPct: number;       // stop if PnL drops this % from peak
  minBankrollUsdc: number;       // stop if bankroll drops below this
  warmupCycles: number;          // observe-only cycles before trading
  autoStopOnError: boolean;      // stop strategy on repeated errors
}

export interface NicheStrategy {
  id: string;
  name: string;
  topic: string;
  description: string;
  status: StrategyStatus;
  executionMode: ExecutionMode;
  dataSources: DataSourceConfig[];
  targetMarkets: TargetMarket[];
  decisionIntervalMs: number;
  edgeThresholdPct: number;
  confidenceMinimum: number;
  riskConfig: RiskConfig;
  sessionConfig: SessionConfig;
  meta: StrategyMeta;
  analysisReport: string | null;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
}

export interface TargetMarket {
  conditionId: string;
  slug: string;
  question: string;
  tokenIds: { yes: string; no: string };
  active: boolean;
}

// ── Data Sources ──

export interface ApiSourceConfig {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  responsePath: string;       // JSONPath-like (e.g. "data.price" or "results[0].value")
  valueType: 'number' | 'string' | 'boolean';
  directionLogic?: {
    field?: string;
    bullishWhen: string;      // e.g. "> 0", "== true", "contains 'bullish'"
  };
}

export interface PolymarketSourceConfig {
  marketSlug?: string;
  conditionId?: string;
  tokenId?: string;
  metric: 'price' | 'spread' | 'depth' | 'volume' | 'imbalance';
}

export interface LLMSourceConfig {
  provider: 'anthropic' | 'openai' | 'xai';  // which LLM to query
  model?: string;                              // override model (e.g. 'claude-sonnet-4-5-20250929')
  prompt: string;                              // system prompt describing what to analyze
  queryTemplate: string;                       // per-poll prompt (can include {{topic}}, {{markets}})
  responseFormat: 'direction' | 'probability' | 'sentiment_score' | 'json';
  temperature?: number;
  maxTokens?: number;
}

export interface DataSourceConfig {
  id: string;
  strategyId: string;
  name: string;
  type: DataSourceType;
  config: ApiSourceConfig | PolymarketSourceConfig | LLMSourceConfig;
  pollIntervalMs: number;
  enabled: boolean;
  priority: number;       // higher = more weight in aggregation
}

export interface DataSourceState {
  sourceId: string;
  health: SourceHealth;
  lastPollAt: string | null;
  lastValue: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalPolls: number;
  totalFailures: number;
}

// ── Raw Events ──

export interface RawDataEvent {
  id: string;
  sourceId: string;
  strategyId: string;
  timestamp: string;
  value: number | string | boolean;
  numericValue: number | null;    // normalized numeric representation
  direction: EventDirection;
  rawPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

// ── Aggregated Events (core IP) ──

export interface AggregatedEvent {
  id: string;
  strategyId: string;
  timestamp: string;
  type: CompoundEventType;
  title: string;
  constituentEventIds: string[];
  sourceIds: string[];
  direction: EventDirection;
  strength: number;             // 0-1
  details: Record<string, unknown>;
  ttlMs: number;
  expiresAt: string;
}

// ── Market State ──

export interface MarketState {
  conditionId: string;
  strategyId: string;
  slug: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  spread: number;
  yesDepthUsdc: number;
  noDepthUsdc: number;
  volume24h: number | null;
  lastUpdatedAt: string;
  priceHistory: { t: string; p: number }[];  // ring buffer
}

// ── Signals ──

export interface Signal {
  id: string;
  strategyId: string;
  marketId: string;
  marketSlug: string;
  action: SignalAction;
  estimatedProbability: number;
  marketPrice: number;
  edge: number;
  confidence: number;
  reasoning: string[];
  activeEvents: string[];       // AggregatedEvent IDs
  riskGates: RiskGateResult[];
  outcome: 'pending' | 'win' | 'loss' | 'expired' | 'skipped';
  createdAt: string;
  resolvedAt: string | null;
}

export interface RiskGateResult {
  gate: string;
  passed: boolean;
  value: number | string;
  threshold: number | string;
  reason: string;
}

// ── Trades ──

export interface Trade {
  id: string;
  strategyId: string;
  signalId: string;
  marketId: string;
  marketSlug: string;
  side: 'YES' | 'NO';
  price: number;
  size: number;
  shares: number;
  fees: number;
  slippage: number;
  status: TradeStatus;
  demo: boolean;                // true = paper trade
  orderId: string | null;       // CLOB order ID for live trades
  resolution: 'pending' | 'won' | 'lost' | null;
  realizedPnl: number | null;
  provenance: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
}

// ── Performance ──

export interface StrategyPerformance {
  strategyId: string;
  bankroll: number;
  initialBankroll: number;
  totalTrades: number;
  wins: number;
  losses: number;
  pending: number;
  winRate: number;
  totalPnl: number;
  totalPnlPct: number;
  peakBankroll: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeEstimate: number | null;
  currentStreak: number;        // positive = win streak, negative = loss streak
  longestWinStreak: number;
  longestLossStreak: number;
  avgWinSize: number;
  avgLossSize: number;
  profitFactor: number | null;  // total wins / total losses
  equityCurve: { t: string; v: number }[];
  lastUpdated: string;
}

// ── Strategy Log Entry ──

export interface StrategyLogEntry {
  id: string;
  strategyId: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'decision' | 'trade';
  module: string;
  message: string;
  data: Record<string, unknown>;
}

// ── Preset ──

export interface StrategyPreset {
  id: string;
  name: string;
  description: string;
  topic: string;
  icon: string;
  dataSources: Omit<DataSourceConfig, 'id' | 'strategyId'>[];
  marketDiscovery: {
    slugPatterns: string[];
    searchQueries: string[];
  };
  defaults: {
    decisionIntervalMs: number;
    edgeThresholdPct: number;
    confidenceMinimum: number;
    riskConfig: RiskConfig;
    sessionConfig: SessionConfig;
    meta: StrategyMeta;
  };
}
