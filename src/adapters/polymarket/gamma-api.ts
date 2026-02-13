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
 */
export async function searchMarkets(query: string, limit = 20): Promise<GammaMarket[]> {
  const url = `${GAMMA_BASE}/markets?closed=false&active=true&limit=${limit}&slug=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!resp.ok) throw new Error(`Gamma API error: ${resp.status}`);
  return resp.json();
}

/**
 * Group markets by their neg_risk_market_id to find NegRisk event groups.
 * Each group = one NegRisk event with multiple outcome markets.
 */
export function groupByNegRiskEvent(markets: GammaMarket[]): Map<string, GammaMarket[]> {
  const groups = new Map<string, GammaMarket[]>();

  for (const market of markets) {
    if (!market.neg_risk || !market.neg_risk_market_id) continue;

    const key = market.neg_risk_market_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(market);
  }

  return groups;
}
