// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Probability Estimation Prompt
// Runtime: estimate probability from compound events + market state.
// Uses claude-sonnet for speed + cost.
// ═══════════════════════════════════════════════════════════════

import type { AggregatedEvent, MarketState, StrategyMeta } from '../types';

export function buildProbabilityEstimationPrompt(input: {
  topic: string;
  marketQuestion: string;
  currentYesPrice: number;
  meta: StrategyMeta;
  activeEvents: AggregatedEvent[];
  marketState: MarketState;
}): string {
  const eventSummary = input.activeEvents.map(e =>
    `- [${e.type}] ${e.title} | direction: ${e.direction} | strength: ${(e.strength * 100).toFixed(0)}% | ${e.sourceIds.length} source(s)`
  ).join('\n');

  const priceHistory = input.marketState.priceHistory.slice(-10).map(p =>
    `  ${p.t.slice(11, 19)}: ${(p.p * 100).toFixed(1)}%`
  ).join('\n');

  const yesPrice = (input.currentYesPrice * 100).toFixed(1);
  const noPrice = ((1 - input.currentYesPrice) * 100).toFixed(1);

  return `You are a BALANCED probability estimation engine for prediction markets. You must evaluate BOTH sides (YES and NO) with equal rigor. You have NO inherent bias toward either outcome.

TOPIC: ${input.topic}
MARKET QUESTION: "${input.marketQuestion}"

CURRENT MARKET PRICES:
- YES price (implied YES probability): ${yesPrice}%
- NO price (implied NO probability): ${noPrice}%
STRATEGY HORIZON: ${input.meta.horizon}
PATTERN TYPE: ${input.meta.patternType}

ACTIVE COMPOUND EVENTS (from our data sources):
${eventSummary || '(none — no events, strongly prefer HOLD)'}

RECENT PRICE HISTORY:
${priceHistory || '(none)'}

MARKET MICROSTRUCTURE:
- Spread: ${(input.marketState.spread * 100).toFixed(1)}%
- YES depth: $${input.marketState.yesDepthUsdc.toFixed(0)}
- NO depth: $${input.marketState.noDepthUsdc.toFixed(0)}

INSTRUCTIONS:
1. Evaluate evidence FOR the event happening (YES case)
2. Evaluate evidence AGAINST the event happening (NO case)
3. Weigh bearish/negative signals with the SAME weight as bullish/positive signals
4. Estimate the TRUE probability of YES occurring (0 to 1)
5. Compare your estimate to BOTH prices:
   - If your probability > YES price by a meaningful edge → BUY_YES
   - If your probability < YES price by a meaningful edge (meaning NO is underpriced) → BUY_NO
   - If no clear edge on either side → HOLD
6. HOLD is the CORRECT default. Only recommend BUY when evidence strongly supports it.

CRITICAL BALANCE RULES:
- BUY_NO is equally valid as BUY_YES. If evidence is bearish, recommend BUY_NO.
- A single bullish event is NOT enough to deviate from the market price.
- Neutral or mixed events → HOLD.
- The market price already reflects consensus. You need STRONG evidence to disagree.
- If events are conflicting or weak, always HOLD.

Respond in this exact JSON format:
{
  "estimatedProbability": 0.XX,
  "confidence": 0.XX,
  "action": "BUY_YES" | "BUY_NO" | "HOLD",
  "reasoning": ["reason 1", "reason 2", "reason 3"],
  "yesCase": "brief argument for YES",
  "noCase": "brief argument for NO"
}

REMEMBER: HOLD is the safest and most frequent correct answer. Only recommend BUY_YES or BUY_NO when compound events provide strong, multi-source directional evidence.`;
}

export function parseProbabilityResponse(response: string): {
  estimatedProbability: number;
  confidence: number;
  action: 'BUY_YES' | 'BUY_NO' | 'HOLD';
  reasoning: string[];
} | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      estimatedProbability: Math.max(0.01, Math.min(0.99, Number(parsed.estimatedProbability) || 0.5)),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      action: ['BUY_YES', 'BUY_NO', 'HOLD'].includes(parsed.action) ? parsed.action : 'HOLD',
      reasoning: Array.isArray(parsed.reasoning) ? parsed.reasoning.map(String) : [],
    };
  } catch {
    return null;
  }
}
