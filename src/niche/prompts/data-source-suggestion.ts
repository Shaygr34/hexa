// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Data Source Suggestion Prompt
// Setup: suggest data sources for a topic.
// ═══════════════════════════════════════════════════════════════

export function buildDataSourceSuggestionPrompt(
  topic: string,
  existingSources: string[],
): string {
  const existing = existingSources.length > 0
    ? `\nALREADY CONFIGURED SOURCES:\n${existingSources.map(s => `- ${s}`).join('\n')}`
    : '';

  return `You are a data source specialist for prediction market trading. Suggest real, working data sources for the given topic.

TOPIC: "${topic}"
${existing}

For each source, provide the exact API configuration needed. Sources must be:
- Publicly accessible (no auth required, or commonly available free API keys)
- Reliably available (>99% uptime)
- Providing data relevant to the topic's prediction markets

Source types:
1. "api" — REST API endpoint (provide exact URL, method, response path)
2. "polymarket" — Polymarket orderbook data (provide market slug or token ID)
3. "llm" — AI model query (provide system prompt and query template)

Respond in this exact JSON format:
{
  "sources": [
    {
      "name": "Source display name",
      "type": "api|polymarket|llm",
      "description": "What signal this provides",
      "config": {
        // For api: { "url": "...", "method": "GET", "headers": {}, "responsePath": "data.price", "valueType": "number", "directionLogic": { "bullishWhen": "> 0" } }
        // For polymarket: { "marketSlug": "...", "metric": "price|spread|depth|imbalance" }
        // For llm: { "provider": "anthropic", "prompt": "...", "queryTemplate": "...", "responseFormat": "direction|probability|sentiment_score|json" }
      },
      "pollIntervalMs": 10000,
      "priority": 1
    }
  ],
  "reasoning": "Why these sources complement each other"
}`;
}

export function parseDataSourceSuggestion(response: string): any | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}
