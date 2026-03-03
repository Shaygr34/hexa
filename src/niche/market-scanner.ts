// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Market Scanner
// Gamma API search + orderbook polling, price history ring buffer.
// ═══════════════════════════════════════════════════════════════

import { getDb } from '@/lib/db';
import { searchMarkets, fetchMarketById } from '@/adapters/polymarket/gamma-api';
import { fetchOrderbook, bestAsk, bestBid, spread, depthAtPrice } from '@/adapters/polymarket/clob-api';
import { getLLMAdapter } from '@/adapters/llm/factory';
import { buildMarketDiscoveryPrompt, parseMarketDiscoveryResponse } from './prompts/market-discovery';
import { initNicheDb } from './db-niche';
import type { MarketState, TargetMarket, StrategyMeta } from './types';

const PRICE_HISTORY_CAP = 100;

/**
 * Discover markets matching search queries or slug patterns.
 */
export async function discoverMarkets(
  queries: string[],
  slugPatterns: string[] = [],
  limit: number = 20,
): Promise<TargetMarket[]> {
  const seen = new Set<string>();
  const results: TargetMarket[] = [];

  for (const query of queries) {
    if (results.length >= limit) break;
    try {
      const markets = await searchMarkets(query, limit);
      for (const m of markets) {
        if (results.length >= limit) break;
        const conditionId = m.condition_id || m.conditionId || (m as any).id;
        if (!conditionId || seen.has(conditionId)) continue;
        seen.add(conditionId);

        // Check slug patterns (if specified, only include matching)
        if (slugPatterns.length > 0) {
          const matchesPattern = slugPatterns.some(pattern => {
            const regex = new RegExp(pattern.replace(/\*/g, '.*'), 'i');
            return regex.test(m.slug || '');
          });
          if (!matchesPattern) continue;
        }

        // Extract token IDs — try multiple formats from the API response
        let yesTokenId: string | undefined;
        let noTokenId: string | undefined;

        // Format 1: tokens array with outcome field
        const tokens = m.tokens || [];
        const yesToken = tokens.find((t: any) => t.outcome === 'Yes');
        const noToken = tokens.find((t: any) => t.outcome === 'No');
        yesTokenId = yesToken?.token_id;
        noTokenId = noToken?.token_id;

        // Format 2: clobTokenIds as JSON string (common from events endpoint)
        if (!yesTokenId && (m as any).clobTokenIds) {
          try {
            let raw = (m as any).clobTokenIds;
            if (typeof raw === 'string') raw = JSON.parse(raw);
            if (Array.isArray(raw) && raw.length >= 1) {
              yesTokenId = String(raw[0]);
              noTokenId = raw[1] ? String(raw[1]) : '';
            }
          } catch {}
        }

        // Skip markets without token IDs — can't trade them
        if (!yesTokenId) continue;

        // Determine active status (API returns booleans or strings depending on endpoint)
        const mActive = String((m as any).active).toLowerCase();
        const mClosed = String((m as any).closed).toLowerCase();
        const isActive = mActive === 'true' && mClosed !== 'true';

        if (!isActive) continue;

        results.push({
          conditionId,
          slug: m.slug || '',
          question: m.question || (m as any).groupItemTitle || '',
          tokenIds: { yes: yesTokenId, no: noTokenId || '' },
          active: true,
        });
      }
    } catch (err: any) {
      console.warn(`Market discovery query "${query}" failed: ${err.message}`);
    }
  }

  return results;
}

/**
 * Auto-discover markets for a topic using AI-powered search query generation.
 * Used at activation time when no target markets are configured.
 */
export async function autoDiscoverMarkets(
  topic: string,
  meta: StrategyMeta,
  limit: number = 20,
): Promise<TargetMarket[]> {
  // Build search queries from the topic directly — simple keyword extraction
  // works better than LLM for API search because we need short search terms
  const topicWords = topic.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2);

  // Start with the full topic, then individual keywords
  let queries = [topic, ...topicWords];

  // Add meta-based queries for targeted search
  const typeQueries: Record<string, string[]> = {
    crypto_short_term: ['bitcoin', 'ethereum', 'crypto', 'btc', 'solana'],
    politics: ['election', 'president', 'congress', 'senate'],
    sports: ['nfl', 'nba', 'soccer', 'world cup', 'mlb'],
  };
  if (meta.marketType && typeQueries[meta.marketType]) {
    queries.push(...typeQueries[meta.marketType]);
  }

  // Also try LLM-powered query generation for smarter search terms
  const llm = getLLMAdapter();
  if (llm) {
    try {
      const prompt = buildMarketDiscoveryPrompt(topic, []);
      const response = await llm.complete(prompt);
      const parsed = parseMarketDiscoveryResponse(response);
      if (parsed && parsed.searchQueries.length > 0) {
        queries = [...parsed.searchQueries, ...queries];
      }
    } catch (err: any) {
      console.warn(`AI market discovery failed, using keyword search: ${err.message}`);
    }
  }

  // Deduplicate queries
  queries = [...new Set(queries)];

  // Run discovery — no slug patterns, let the search be broad
  const discovered = await discoverMarkets(queries, [], limit);

  return discovered;
}

/**
 * Update market state (prices, depth, spread) for all target markets.
 */
export async function updateMarketStates(
  strategyId: string,
  markets: TargetMarket[],
): Promise<MarketState[]> {
  initNicheDb();
  const db = getDb();
  const states: MarketState[] = [];

  for (const market of markets) {
    if (!market.active || !market.tokenIds.yes) continue;

    try {
      const book = await fetchOrderbook(market.tokenIds.yes);
      const ask = bestAsk(book);
      const bid = bestBid(book);
      const sp = spread(book);
      const askDepth = depthAtPrice(book.asks, 'asks');
      const bidDepth = depthAtPrice(book.bids, 'bids');

      const yesPrice = ask?.price ?? 0.5;
      const noPrice = 1 - yesPrice;
      const now = new Date().toISOString();

      // Get existing price history
      const existing = db.prepare(
        'SELECT price_history_json FROM niche_market_state WHERE condition_id = ? AND strategy_id = ?'
      ).get(market.conditionId, strategyId) as any;

      let priceHistory: { t: string; p: number }[] = [];
      if (existing) {
        priceHistory = JSON.parse(existing.price_history_json || '[]');
      }
      priceHistory.push({ t: now, p: yesPrice });
      if (priceHistory.length > PRICE_HISTORY_CAP) priceHistory.shift();

      db.prepare(`
        INSERT INTO niche_market_state (condition_id, strategy_id, slug, question, yes_price, no_price, spread, yes_depth_usdc, no_depth_usdc, last_updated_at, price_history_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(condition_id, strategy_id) DO UPDATE SET
          yes_price = excluded.yes_price,
          no_price = excluded.no_price,
          spread = excluded.spread,
          yes_depth_usdc = excluded.yes_depth_usdc,
          no_depth_usdc = excluded.no_depth_usdc,
          last_updated_at = excluded.last_updated_at,
          price_history_json = excluded.price_history_json
      `).run(
        market.conditionId, strategyId, market.slug, market.question,
        yesPrice, noPrice, sp, askDepth.depthUsdc, bidDepth.depthUsdc,
        now, JSON.stringify(priceHistory),
      );

      states.push({
        conditionId: market.conditionId,
        strategyId,
        slug: market.slug,
        question: market.question,
        yesPrice,
        noPrice,
        spread: sp,
        yesDepthUsdc: askDepth.depthUsdc,
        noDepthUsdc: bidDepth.depthUsdc,
        volume24h: null,
        lastUpdatedAt: now,
        priceHistory,
      });
    } catch (err: any) {
      console.warn(`Market ${market.slug} orderbook fetch failed: ${err.message}`);
    }
  }

  return states;
}

/**
 * Get persisted market states for a strategy.
 */
export function getMarketStates(strategyId: string): MarketState[] {
  initNicheDb();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM niche_market_state WHERE strategy_id = ?').all(strategyId) as any[];
  return rows.map(r => ({
    conditionId: r.condition_id,
    strategyId: r.strategy_id,
    slug: r.slug,
    question: r.question,
    yesPrice: r.yes_price,
    noPrice: r.no_price,
    spread: r.spread,
    yesDepthUsdc: r.yes_depth_usdc,
    noDepthUsdc: r.no_depth_usdc,
    volume24h: r.volume_24h,
    lastUpdatedAt: r.last_updated_at,
    priceHistory: JSON.parse(r.price_history_json || '[]'),
  }));
}
