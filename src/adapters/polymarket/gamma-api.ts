// ═══════════════════════════════════════════════════════════════
// ZVI v1 — Polymarket Gamma API Adapter
// Market discovery + metadata. Observation-only safe.
// ═══════════════════════════════════════════════════════════════

import type { GammaMarket } from '@/lib/types';

const GAMMA_BASE = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';

/**
 * Fetch all active NegRisk markets from Gamma API.
 */
export async function fetchNegRiskMarkets(): Promise<GammaMarket[]> {
  const allMarkets: GammaMarket[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${GAMMA_BASE}/markets?closed=false&active=true&neg_risk=true&limit=${limit}&offset=${offset}`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!resp.ok) {
      throw new Error(`Gamma API error: ${resp.status} ${resp.statusText}`);
    }

    const markets: GammaMarket[] = await resp.json();
    if (markets.length === 0) break;

    allMarkets.push(...markets);
    offset += limit;

    // Safety: don't paginate forever
    if (offset > 2000) break;
  }

  return allMarkets;
}

/**
 * Fetch a single market by ID.
 */
export async function fetchMarketById(marketId: string): Promise<GammaMarket | null> {
  const url = `${GAMMA_BASE}/markets/${marketId}`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Gamma API error: ${resp.status}`);

  return resp.json();
}

/**
 * Search markets by query string.
 * The Gamma API doesn't have reliable server-side text search,
 * so we fetch a large set of events and filter client-side by keyword matching.
 */
export async function searchMarkets(query: string, limit = 20): Promise<GammaMarket[]> {
  // Extract meaningful keywords from the query
  const stopWords = new Set(['the', 'and', 'for', 'are', 'this', 'that', 'with', 'from', 'will', 'can',
    'any', 'its', 'our', 'has', 'had', 'not', 'but', 'all', 'been', 'have', 'were', 'what', 'when',
    'term', 'short', 'long', 'movements', 'movement', 'based']);
  const keywords = query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return [];

  // Fetch a large batch of events (each event contains nested markets)
  const allEvents: any[] = [];
  try {
    // Fetch 2 pages of events for broad coverage
    for (let offset = 0; offset < 400; offset += 200) {
      const url = `${GAMMA_BASE}/events?active=true&closed=false&limit=200&offset=${offset}`;
      const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) break;
      const events: any[] = await resp.json();
      if (events.length === 0) break;
      allEvents.push(...events);
    }
  } catch {}

  // Score each event by keyword relevance
  const scored: { event: any; score: number }[] = [];
  for (const ev of allEvents) {
    const text = `${ev.title || ''} ${ev.slug || ''} ${ev.description || ''}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > 0) scored.push({ event: ev, score });
  }

  // Sort by relevance score (most matches first)
  scored.sort((a, b) => b.score - a.score);

  // Extract markets from top-scoring events
  const seen = new Set<string>();
  const results: GammaMarket[] = [];

  for (const { event } of scored) {
    if (results.length >= limit) break;
    for (const m of event.markets || []) {
      if (results.length >= limit) break;
      const id = m.condition_id || m.conditionId || m.id;
      if (!id || seen.has(id)) continue;
      // Skip closed markets
      if (String(m.closed).toLowerCase() === 'true') continue;
      if (String(m.active).toLowerCase() === 'false') continue;
      seen.add(id);
      results.push(m);
    }
  }

  return results;
}

/**
 * Group markets by their neg_risk_market_id to find NegRisk event groups.
 * Each group = one NegRisk event with multiple outcome markets.
 */
export function groupByNegRiskEvent(markets: GammaMarket[]): Map<string, GammaMarket[]> {
  const groups = new Map<string, GammaMarket[]>();

  for (const market of markets) {
    const isNegRisk = market.negRisk ?? market.neg_risk;
    const negRiskId = market.negRiskMarketID ?? market.neg_risk_market_id;
    if (!isNegRisk || !negRiskId) continue;

    if (!groups.has(negRiskId)) groups.set(negRiskId, []);
    groups.get(negRiskId)!.push(market);
  }

  return groups;
}
