// ═══════════════════════════════════════════════════════════════
// ZVI v1 — Configuration loader
// ═══════════════════════════════════════════════════════════════

import { SystemConfig, RiskLimits } from './types';

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env: ${key}`);
  return val;
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  return raw ? Number(raw) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === 'true' || raw === '1';
}

export const config = {
  // Polymarket
  polymarket: {
    gammaUrl: env('POLYMARKET_GAMMA_URL', 'https://gamma-api.polymarket.com'),
    clobUrl: env('POLYMARKET_CLOB_URL', 'https://clob.polymarket.com'),
    chainId: envNum('POLYMARKET_CHAIN_ID', 137),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
    apiKey: process.env.POLYMARKET_API_KEY || '',
    apiSecret: process.env.POLYMARKET_API_SECRET || '',
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE || '',
  },

  // On-chain
  polygon: {
    rpcUrl: env('POLYGON_RPC_URL', 'https://polygon-rpc.com'),
    negRiskAdapterAddress: env('NEGRISK_ADAPTER_ADDRESS', '0xC5d563A36AE78145C45a50134d48A1215220f80a'),
    negRiskExchangeAddress: env('NEGRISK_EXCHANGE_ADDRESS', '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'),
  },

  // LLM
  llm: {
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    openaiKey: process.env.OPENAI_API_KEY || '',
    xaiKey: process.env.XAI_API_KEY || '',
  },

  // Alerts
  alerts: {
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || '',
    },
    email: {
      host: process.env.SMTP_HOST || '',
      port: envNum('SMTP_PORT', 587),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.ALERT_EMAIL_FROM || '',
      to: process.env.ALERT_EMAIL_TO || '',
    },
    webhookUrl: process.env.WEBHOOK_URL || '',
  },

  // Database
  databasePath: env('DATABASE_PATH', './data/zvi.db'),

  // System config
  system: (): SystemConfig => ({
    observationOnly: envBool('OBSERVATION_ONLY', true),
    manualApprovalRequired: envBool('MANUAL_APPROVAL_REQUIRED', true),
    autoExec: envBool('AUTO_EXEC', false),
    killSwitch: envBool('KILL_SWITCH', false),
    riskLimits: {
      maxExposurePerMarket: envNum('MAX_EXPOSURE_PER_MARKET', 500),
      dailyMaxExposure: envNum('DAILY_MAX_EXPOSURE', 2000),
      minEdgeThreshold: envNum('MIN_EDGE_THRESHOLD', 0.02),
      minDepthUsdc: envNum('MIN_DEPTH_USDC', 100),
    },
  }),
};
