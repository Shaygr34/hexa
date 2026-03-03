// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Strategy Analysis Prompt
// Setup: analyze topic → strategy configuration.
// Uses opus-quality model for thorough analysis.
// ═══════════════════════════════════════════════════════════════

export function buildStrategyAnalysisPrompt(topic: string, userContext?: string): string {
  return `You are a quantitative trading strategy architect. Given a topic, design a data-driven trading strategy for Polymarket prediction markets.

TOPIC: "${topic}"
${userContext ? `USER CONTEXT: ${userContext}` : ''}

Analyze this topic and produce a complete strategy configuration. Consider:
1. What data sources would provide signal for this topic?
2. What Polymarket markets relate to this topic?
3. What's the appropriate time horizon?
4. What pattern types would emerge (momentum, mean reversion, event-driven)?
5. What risk parameters make sense?

Respond in this exact JSON format:
{
  "name": "Short strategy name",
  "description": "2-3 sentence description of the strategy logic",
  "analysisReport": "Detailed 3-5 paragraph analysis of the opportunity, data availability, edge sources, and risks",
  "suggestedSources": [
    {
      "name": "Source name",
      "type": "api|polymarket|llm",
      "description": "What this source provides",
      "config": {},
      "pollIntervalMs": 10000,
      "priority": 1
    }
  ],
  "marketDiscovery": {
    "searchQueries": ["query1", "query2"],
    "slugPatterns": ["*pattern*"]
  },
  "meta": {
    "horizon": "15m|1h|4h|1d|1w",
    "patternType": "momentum|mean_reversion|event_driven|statistical",
    "dataType": "price|sentiment|on_chain|news|mixed",
    "eventFrequency": "high|medium|low",
    "marketType": "crypto_short_term|politics|sports|economics|tech|custom"
  },
  "suggestedConfig": {
    "decisionIntervalMs": 15000,
    "edgeThresholdPct": 0.03,
    "confidenceMinimum": 0.6
  },
  "suggestedRisk": {
    "maxPositionUsdc": 10,
    "maxExposureUsdc": 50,
    "maxDrawdownPct": 20,
    "stopLossPct": 10,
    "maxOpenPositions": 5
  },
  "suggestedSession": {
    "maxDurationMs": 3600000,
    "budgetUsdc": 100,
    "maxTotalTrades": 100,
    "dailyLossLimitUsdc": 20,
    "maxConsecutiveLosses": 5
  },
  "warnings": ["Any risks or limitations to note"]
}

For API sources, provide real, publicly accessible API endpoints. For LLM sources, include the prompt template. For Polymarket sources, specify the metric to track.`;
}

export function parseStrategyAnalysis(response: string): any | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}
