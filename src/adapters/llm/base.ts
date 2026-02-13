// ═══════════════════════════════════════════════════════════════
// ZVI v1 — LLM Adapter Base Interface
// LLMs are for INTERPRETATION ONLY. Never for math.
// ═══════════════════════════════════════════════════════════════

export interface LLMAdapter {
  name: string;
  complete(prompt: string): Promise<string>;
}
