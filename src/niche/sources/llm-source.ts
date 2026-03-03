// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — LLM Data Source
// Uses Claude, OpenAI, or xAI as a real-time intelligence source.
// Queries the model for analysis/sentiment/probability on each poll.
// ═══════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import type { LLMSourceConfig, RawDataEvent, EventDirection } from '../types';

async function callLLM(config: LLMSourceConfig, query: string): Promise<string> {
  const { provider, model, temperature = 0.3, maxTokens = 1024 } = config;

  if (provider === 'anthropic') {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: model || 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      system: config.prompt,
      messages: [{ role: 'user', content: query }],
    });
    const textBlock = resp.content.find((b: any) => b.type === 'text');
    return textBlock ? (textBlock as any).text : '';
  }

  if (provider === 'openai' || provider === 'xai') {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({
      apiKey: provider === 'xai' ? process.env.XAI_API_KEY : process.env.OPENAI_API_KEY,
      baseURL: provider === 'xai' ? 'https://api.x.ai/v1' : undefined,
    });
    const resp = await client.chat.completions.create({
      model: model || (provider === 'xai' ? 'grok-3' : 'gpt-4o'),
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: config.prompt },
        { role: 'user', content: query },
      ],
    });
    return resp.choices[0]?.message?.content || '';
  }

  throw new Error(`Unknown LLM provider: ${provider}`);
}

function parseDirection(text: string): { direction: EventDirection; numericValue: number | null } {
  const lower = text.toLowerCase();

  // Try to extract a numeric probability/score
  const probMatch = lower.match(/(?:probability|confidence|score|estimate)[:\s]*([0-9.]+)/);
  const pctMatch = lower.match(/([0-9.]+)\s*%/);
  let numericValue: number | null = null;
  if (probMatch) numericValue = parseFloat(probMatch[1]);
  else if (pctMatch) numericValue = parseFloat(pctMatch[1]) / 100;

  // Count directional keyword matches (balanced — check BOTH sides)
  const bullishKeywords = ['bullish', 'buy_yes', 'upward', 'rally', 'surge', 'increase'];
  const bearishKeywords = ['bearish', 'buy_no', 'downward', 'decline', 'drop', 'decrease', 'fall', 'unlikely'];
  const bullishHits = bullishKeywords.filter(k => lower.includes(k)).length;
  const bearishHits = bearishKeywords.filter(k => lower.includes(k)).length;

  // Use keyword balance to determine direction (avoids single-keyword bias)
  if (bullishHits > bearishHits && bullishHits > 0) {
    return { direction: 'bullish', numericValue };
  }
  if (bearishHits > bullishHits && bearishHits > 0) {
    return { direction: 'bearish', numericValue };
  }

  // Direction from numeric value — wider neutral zone to avoid false positives
  if (numericValue !== null) {
    if (numericValue > 0.60) return { direction: 'bullish', numericValue };
    if (numericValue < 0.40) return { direction: 'bearish', numericValue };
  }

  return { direction: 'neutral', numericValue };
}

function parseJSON(text: string): Record<string, any> | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch { return null; }
}

export async function pollLLMSource(
  sourceId: string,
  strategyId: string,
  config: LLMSourceConfig,
  templateVars: Record<string, string> = {},
): Promise<RawDataEvent> {
  // Interpolate template variables into query
  let query = config.queryTemplate;
  for (const [key, val] of Object.entries(templateVars)) {
    query = query.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
  }

  const response = await callLLM(config, query);
  let direction: EventDirection = 'neutral';
  let numericValue: number | null = null;
  let parsedPayload: Record<string, unknown> = {};

  switch (config.responseFormat) {
    case 'direction': {
      const parsed = parseDirection(response);
      direction = parsed.direction;
      numericValue = parsed.numericValue;
      break;
    }
    case 'probability': {
      const parsed = parseDirection(response);
      direction = parsed.direction;
      numericValue = parsed.numericValue;
      break;
    }
    case 'sentiment_score': {
      const match = response.match(/-?[0-9.]+/);
      numericValue = match ? parseFloat(match[0]) : null;
      if (numericValue !== null) {
        direction = numericValue > 0.2 ? 'bullish' : numericValue < -0.2 ? 'bearish' : 'neutral';
      }
      break;
    }
    case 'json': {
      const json = parseJSON(response);
      if (json) {
        parsedPayload = json;
        direction = json.direction || 'neutral';
        numericValue = typeof json.value === 'number' ? json.value : null;
      }
      break;
    }
  }

  return {
    id: uuid(),
    sourceId,
    strategyId,
    timestamp: new Date().toISOString(),
    value: response.slice(0, 500), // truncate for storage
    numericValue,
    direction,
    rawPayload: { response: response.slice(0, 2000), ...parsedPayload },
    metadata: { provider: config.provider, model: config.model, format: config.responseFormat },
  };
}
