// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Generic API Data Source
// HTTP GET/POST → JSON → extract via configurable path → RawDataEvent
// ═══════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import type { ApiSourceConfig, RawDataEvent, EventDirection } from '../types';

function extractPath(obj: any, path: string): any {
  const parts = path.split(/[.\[\]]/).filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function inferDirection(value: any, config: ApiSourceConfig): EventDirection {
  if (!config.directionLogic) return 'neutral';
  const testVal = config.directionLogic.field ? extractPath(value, config.directionLogic.field) : value;
  const rule = config.directionLogic.bullishWhen;
  const num = Number(testVal);

  // Numeric comparisons: symmetric — positive = bullish, negative = bearish
  if (rule.startsWith('>')) {
    const threshold = parseFloat(rule.slice(1).trim());
    if (num > threshold) return 'bullish';
    if (num < -threshold) return 'bearish';
    return 'neutral';
  }
  if (rule.startsWith('<')) {
    const threshold = parseFloat(rule.slice(1).trim());
    if (num < threshold) return 'bullish';   // matches bullishWhen rule
    if (num > Math.abs(threshold)) return 'bearish'; // symmetric opposite
    return 'neutral';
  }
  // Boolean: true = bullish, false = bearish
  if (rule.includes('true')) return testVal === true || testVal === 'true' ? 'bullish' : 'bearish';
  // String matching: check for both bullish/bearish keywords
  if (rule.includes('contains')) {
    const keyword = rule.match(/contains\s+'(.+)'/)?.[1] || '';
    const text = String(testVal).toLowerCase();
    if (text.includes(keyword.toLowerCase())) return 'bullish';
    // Check for opposite sentiment keywords
    const bearishKeywords = ['bearish', 'down', 'sell', 'decline', 'drop', 'fall', 'negative', 'decrease'];
    if (bearishKeywords.some(k => text.includes(k))) return 'bearish';
    return 'neutral';
  }
  return 'neutral';
}

export async function pollApiSource(
  sourceId: string,
  strategyId: string,
  config: ApiSourceConfig,
): Promise<RawDataEvent> {
  const fetchOpts: RequestInit = {
    method: config.method,
    headers: { 'Accept': 'application/json', ...config.headers },
  };
  if (config.method === 'POST' && config.body) {
    (fetchOpts.headers as Record<string, string>)['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(config.body);
  }

  const resp = await fetch(config.url, fetchOpts);
  if (!resp.ok) throw new Error(`API source ${sourceId}: ${resp.status} ${resp.statusText}`);

  const payload = await resp.json();
  const extracted = config.responsePath ? extractPath(payload, config.responsePath) : payload;
  const numericValue = typeof extracted === 'number' ? extracted : parseFloat(String(extracted));
  const direction = inferDirection(extracted, config);

  return {
    id: uuid(),
    sourceId,
    strategyId,
    timestamp: new Date().toISOString(),
    value: extracted,
    numericValue: isNaN(numericValue) ? null : numericValue,
    direction,
    rawPayload: payload,
    metadata: { url: config.url, path: config.responsePath },
  };
}
