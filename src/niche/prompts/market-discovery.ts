// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Market Discovery Prompt
// Setup: find relevant Polymarket markets for a topic.
// ═══════════════════════════════════════════════════════════════

export function buildMarketDiscoveryPrompt(topic: string, existingMarkets: string[]): string {
  const existingList = existingMarkets.length > 0
    ? `\nALREADY KNOWN MARKETS:\n${existingMarkets.map(m => `- ${m}`).join('\n')}`
    : '';

  return `You are a Polymarket market discovery assistant. Given a topic, suggest search queries and slug patterns to find relevant prediction markets.

TOPIC: "${topic}"
${existingList}

Polymarket markets have slugs like: "will-bitcoin-reach-100k-by-end-of-2025", "ethereum-price-above-4000-march-2025"
For crypto 15-minute markets: "bitcoin-15-minute-up-or-down", "ethereum-15min-price"

Respond in this exact JSON format:
{
  "searchQueries": ["query1", "query2", "query3"],
  "slugPatterns": ["*pattern1*", "*pattern2*"],
  "reasoning": "brief explanation of market selection strategy"
}

Be specific to the topic. Include both broad and narrow search terms.`;
}

export function parseMarketDiscoveryResponse(response: string): {
  searchQueries: string[];
  slugPatterns: string[];
  reasoning: string;
} | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      searchQueries: Array.isArray(parsed.searchQueries) ? parsed.searchQueries : [],
      slugPatterns: Array.isArray(parsed.slugPatterns) ? parsed.slugPatterns : [],
      reasoning: parsed.reasoning || '',
    };
  } catch {
    return null;
  }
}
