// ═══════════════════════════════════════════════════════════════
// ZVI v1 — MODULE 2: LLM Probability Engine (V2 Skeleton)
// Watches pinned markets, produces calibrated probability
// estimates and "mispricing gap" vs market.
// LLM = synthesis + reasoning ONLY. No math.
// ═══════════════════════════════════════════════════════════════

import { getDb, initDb } from '@/lib/db';
import { getLLMAdapter } from '@/adapters/llm/factory';
import { logAudit } from '@/audit/logger';
import type { PinnedMarket } from '@/lib/types';

const AGENT_ID = 'llm-probability';
const ANALYSIS_INTERVAL_MS = 300_000; // 5 minutes

interface LLMProbabilityOutput {
  probability: number;
  confidenceLow: number;
  confidenceHigh: number;
  reasoning: string[];
  sources: string[];
  suggestedAction: 'BUY_YES' | 'BUY_NO' | 'HOLD';
}

const PROBABILITY_PROMPT = `You are a calibrated probability estimator for prediction markets.

Given a prediction market question, provide:
1. Your estimated probability (0-1) that the event resolves YES
2. A confidence interval (low, high)
3. 3-5 bullet points of reasoning with specific citations/sources
4. A list of source URLs for each claim
5. A suggested action: BUY_YES (if your probability > market price), BUY_NO (if your probability < market price), or HOLD

You MUST respond with valid JSON in this exact format:
{
  "probability": 0.65,
  "confidenceLow": 0.55,
  "confidenceHigh": 0.75,
  "reasoning": [
    "Point 1 with specific data [source: URL]",
    "Point 2 with specific data [source: URL]"
  ],
  "sources": [
    "https://example.com/source1",
    "https://example.com/source2"
  ],
  "suggestedAction": "BUY_YES"
}

Be calibrated. If uncertain, widen your confidence interval. Never claim certainty.
Your probability estimate should be independent of the current market price.
`;

/**
 * Analyze a pinned market using LLM.
 */
async function analyzeMarket(market: PinnedMarket): Promise<LLMProbabilityOutput | null> {
  const llm = getLLMAdapter();
  if (!llm) {
    console.warn('[LLM] No LLM adapter configured. Skipping analysis.');
    return null;
  }

  const prompt = `${PROBABILITY_PROMPT}

Market question: "${market.marketName}"
Current market price (implied probability): ${market.marketPrice}

Analyze this market and provide your probability estimate.`;

  try {
    const response = await llm.complete(prompt);

    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[LLM] Failed to parse JSON from response');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as LLMProbabilityOutput;

    // Validate ranges
    if (parsed.probability < 0 || parsed.probability > 1) return null;
    if (parsed.confidenceLow < 0 || parsed.confidenceHigh > 1) return null;

    return parsed;
  } catch (e: any) {
    console.warn(`[LLM] Analysis error: ${e.message}`);
    return null;
  }
}

/**
 * Get all pinned markets.
 */
function getPinnedMarkets(): PinnedMarket[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM pinned_markets').all() as any[];
  return rows.map(r => ({
    id: r.id,
    marketId: r.market_id,
    marketName: r.market_name,
    marketSlug: r.market_slug,
    marketPrice: r.market_price,
    zviProbability: r.zvi_probability,
    confidenceLow: r.confidence_low,
    confidenceHigh: r.confidence_high,
    mispricingGap: r.mispricing_gap,
    reasoning: r.reasoning_json ? JSON.parse(r.reasoning_json) : [],
    sources: r.sources_json ? JSON.parse(r.sources_json) : [],
    suggestedAction: r.suggested_action,
    lastAnalyzedAt: r.last_analyzed_at,
    pinnedAt: r.pinned_at,
    pinnedBy: r.pinned_by,
  }));
}

/**
 * Update a pinned market with LLM analysis results.
 */
function updatePinnedMarket(marketId: string, analysis: LLMProbabilityOutput, marketPrice: number): void {
  const db = getDb();
  const mispricingGap = analysis.probability - marketPrice;

  db.prepare(`
    UPDATE pinned_markets SET
      zvi_probability = ?,
      confidence_low = ?,
      confidence_high = ?,
      mispricing_gap = ?,
      reasoning_json = ?,
      sources_json = ?,
      suggested_action = ?,
      last_analyzed_at = ?
    WHERE market_id = ?
  `).run(
    analysis.probability,
    analysis.confidenceLow,
    analysis.confidenceHigh,
    mispricingGap,
    JSON.stringify(analysis.reasoning),
    JSON.stringify(analysis.sources),
    analysis.suggestedAction,
    new Date().toISOString(),
    marketId,
  );
}

/**
 * Run one analysis cycle.
 */
export async function analyzeOnce(): Promise<void> {
  const markets = getPinnedMarkets();
  console.log(`[LLM] Analyzing ${markets.length} pinned markets...`);

  for (const market of markets) {
    try {
      const analysis = await analyzeMarket(market);
      if (analysis) {
        updatePinnedMarket(market.marketId, analysis, market.marketPrice);
        console.log(`[LLM] ${market.marketName}: P=${analysis.probability.toFixed(2)} (market=${market.marketPrice.toFixed(2)}) → ${analysis.suggestedAction}`);

        logAudit({
          module: 'llm_engine',
          action: 'market_analyzed',
          inputs: { marketId: market.marketId, marketPrice: market.marketPrice },
          computedMetrics: {
            zviProbability: analysis.probability,
            mispricingGap: analysis.probability - market.marketPrice,
            suggestedAction: analysis.suggestedAction,
          },
          llmNarrative: analysis.reasoning.join(' | '),
        });
      }
    } catch (e: any) {
      console.warn(`[LLM] Error analyzing ${market.marketName}: ${e.message}`);
    }
  }
}

/**
 * Run the agent in continuous mode.
 */
export async function runAgent(): Promise<void> {
  console.log('[LLM] Probability Engine starting...');
  initDb();

  const db = getDb();

  while (true) {
    try {
      db.prepare(`
        INSERT OR REPLACE INTO agent_health (agent_id, agent_name, status, last_heartbeat, last_error, cycle_count)
        VALUES (?, ?, 'running', ?, NULL, COALESCE((SELECT cycle_count FROM agent_health WHERE agent_id = ?), 0) + 1)
      `).run(AGENT_ID, 'LLM Probability Engine', new Date().toISOString(), AGENT_ID);

      await analyzeOnce();
    } catch (e: any) {
      console.error(`[LLM] Cycle error: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, ANALYSIS_INTERVAL_MS));
  }
}

if (require.main === module || process.argv[1]?.includes('llm-probability')) {
  runAgent().catch(e => {
    console.error('[LLM] Fatal:', e);
    process.exit(1);
  });
}
