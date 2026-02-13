// ═══════════════════════════════════════════════════════════════
// ZVI v1 — LLM Adapter Factory
// Priority: Anthropic > OpenAI > xAI (OpenAI-compatible)
// ═══════════════════════════════════════════════════════════════

import type { LLMAdapter } from './base';
import { AnthropicAdapter } from './anthropic';
import { OpenAIAdapter } from './openai';

export function getLLMAdapter(): LLMAdapter | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return new AnthropicAdapter(anthropicKey);
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return new OpenAIAdapter(openaiKey);
  }

  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey) {
    return new OpenAIAdapter(xaiKey, 'https://api.x.ai/v1');
  }

  return null;
}
