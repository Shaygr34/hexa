// ═══════════════════════════════════════════════════════════════
// ZVI v1 — OpenAI LLM Adapter
// ═══════════════════════════════════════════════════════════════

import type { LLMAdapter } from './base';

export class OpenAIAdapter implements LLMAdapter {
  name = 'openai';
  private apiKey: string;
  private baseUrl?: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async complete(prompt: string): Promise<string> {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
    });

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.choices[0]?.message?.content || '';
  }
}
