import { NextResponse } from 'next/server';
import { getLLMAdapter } from '@/adapters/llm/factory';
import { discoverMarkets } from '@/niche/market-scanner';
import { buildMarketDiscoveryPrompt, parseMarketDiscoveryResponse } from '@/niche/prompts/market-discovery';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { topic, queries, slugPatterns } = await req.json();

    if (!topic && !queries) {
      return NextResponse.json({ error: 'topic or queries required' }, { status: 400 });
    }

    let searchQueries = queries || [];
    let patterns = slugPatterns || [];

    // If only topic provided, use AI to discover search terms
    if (topic && searchQueries.length === 0) {
      const llm = getLLMAdapter();
      if (llm) {
        const prompt = buildMarketDiscoveryPrompt(topic, []);
        const response = await llm.complete(prompt);
        const parsed = parseMarketDiscoveryResponse(response);
        if (parsed) {
          searchQueries = parsed.searchQueries;
          patterns = parsed.slugPatterns;
        }
      }
      // Fallback: use topic as search query
      if (searchQueries.length === 0) {
        searchQueries = [topic];
      }
    }

    // Don't use slug patterns as a restrictive filter — use them as additional search queries
    // This prevents over-filtering when the LLM generates patterns that don't exactly match
    const allQueries = [...searchQueries];
    for (const p of patterns) {
      // Convert slug patterns like "*bitcoin*price*" to search keywords "bitcoin price"
      const keyword = p.replace(/\*/g, ' ').replace(/-/g, ' ').trim();
      if (keyword.length > 2) allQueries.push(keyword);
    }

    const markets = await discoverMarkets([...new Set(allQueries)]);

    return NextResponse.json({
      markets,
      searchQueries: allQueries,
      slugPatterns: patterns,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
