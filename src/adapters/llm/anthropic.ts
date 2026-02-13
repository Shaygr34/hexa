// ═══════════════════════════════════════════════════════════════
// ZVI v1 — Anthropic LLM Adapter
// ═══════════════════════════════════════════════════════════════

import type { LLMAdapter } from './base';

export class AnthropicAdapter implements LLMAdapter {
  name = 'anthropic';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async complete(prompt: string): Promise<string> {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: this.apiKey });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    return textBlock ? (textBlock as any).text : '';
  }
}
