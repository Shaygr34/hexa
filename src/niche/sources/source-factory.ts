// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Source Factory
// Creates the right poller function from a DataSourceConfig.
// ═══════════════════════════════════════════════════════════════

import type { DataSourceConfig, RawDataEvent, ApiSourceConfig, PolymarketSourceConfig, LLMSourceConfig } from '../types';
import { pollApiSource } from './api-source';
import { pollPolymarketSource } from './polymarket-source';
import { pollLLMSource } from './llm-source';

export type PollFunction = (sourceId: string, strategyId: string, templateVars?: Record<string, string>) => Promise<RawDataEvent>;

export function createPoller(config: DataSourceConfig): PollFunction {
  switch (config.type) {
    case 'api':
      return (sourceId, strategyId) =>
        pollApiSource(sourceId, strategyId, config.config as ApiSourceConfig);

    case 'polymarket':
      return (sourceId, strategyId) =>
        pollPolymarketSource(sourceId, strategyId, config.config as PolymarketSourceConfig);

    case 'llm':
      return (sourceId, strategyId, templateVars) =>
        pollLLMSource(sourceId, strategyId, config.config as LLMSourceConfig, templateVars);

    default:
      throw new Error(`Unknown source type: ${config.type}`);
  }
}
