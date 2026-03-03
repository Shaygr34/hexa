// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Crypto 15m Preset
// One-click preset replicating the crypto15m-controller behavior.
// ═══════════════════════════════════════════════════════════════

import type { StrategyPreset } from '../types';

export const crypto15mPreset: StrategyPreset = {
  id: 'crypto-15m',
  name: 'Crypto 15-Minute Markets',
  description: 'Trade BTC/ETH/SOL/XRP 15-minute up/down prediction markets using exchange price feeds and orderbook microstructure. Mirrors the proven crypto15m shadow trading system.',
  topic: 'Cryptocurrency short-term price movements',
  icon: '₿',
  dataSources: [
    {
      name: 'Binance BTC Spot',
      type: 'api',
      config: {
        url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
        method: 'GET' as const,
        headers: {},
        responsePath: 'price',
        valueType: 'number' as const,
        directionLogic: { bullishWhen: '> 0' },
      },
      pollIntervalMs: 5000,
      enabled: true,
      priority: 3,
    },
    {
      name: 'Binance ETH Spot',
      type: 'api',
      config: {
        url: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT',
        method: 'GET' as const,
        headers: {},
        responsePath: 'price',
        valueType: 'number' as const,
        directionLogic: { bullishWhen: '> 0' },
      },
      pollIntervalMs: 5000,
      enabled: true,
      priority: 2,
    },
    {
      name: 'Binance SOL Spot',
      type: 'api',
      config: {
        url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
        method: 'GET' as const,
        headers: {},
        responsePath: 'price',
        valueType: 'number' as const,
        directionLogic: { bullishWhen: '> 0' },
      },
      pollIntervalMs: 5000,
      enabled: true,
      priority: 1,
    },
    {
      name: 'AI Crypto Analyst',
      type: 'llm',
      config: {
        provider: 'anthropic' as const,
        prompt: 'You are a crypto market microstructure analyst. Analyze the latest price action and orderbook signals to determine short-term (15-minute) directional bias.',
        queryTemplate: 'Given the topic "{{topic}}" and markets "{{markets}}", what is the likely 15-minute direction for crypto prices? Consider recent momentum, exchange flows, and market microstructure. Respond with: direction (bullish/bearish/neutral), confidence (0-1), and brief reasoning.',
        responseFormat: 'direction' as const,
        temperature: 0.2,
        maxTokens: 512,
      },
      pollIntervalMs: 30000,
      enabled: true,
      priority: 2,
    },
  ],
  marketDiscovery: {
    slugPatterns: ['*bitcoin*15*min*', '*btc*15*min*', '*ethereum*15*min*', '*eth*15*min*', '*solana*15*min*', '*sol*15*min*', '*xrp*15*min*', '*crypto*15*min*'],
    searchQueries: ['bitcoin 15 minute', 'ethereum 15 minute', 'crypto 15min', 'btc price up down'],
  },
  defaults: {
    decisionIntervalMs: 15000,
    edgeThresholdPct: 0.03,
    confidenceMinimum: 0.55,
    riskConfig: {
      maxPositionUsdc: 10,
      maxExposureUsdc: 50,
      maxDrawdownPct: 25,
      stopLossPct: 15,
      maxOpenPositions: 4,
      cooldownMs: 15000,
      killSwitch: false,
    },
    sessionConfig: {
      maxDurationMs: 3600000,        // 1 hour
      maxTotalTrades: 50,
      budgetUsdc: 100,
      dailyLossLimitUsdc: 20,
      dailyLossLimitPct: 20,
      maxConsecutiveLosses: 5,
      trailingStopPct: 15,
      minBankrollUsdc: 20,
      warmupCycles: 3,
      autoStopOnError: true,
    },
    meta: {
      horizon: '15m',
      patternType: 'momentum',
      dataType: 'price',
      eventFrequency: 'high',
      marketType: 'crypto_short_term',
    },
  },
};
