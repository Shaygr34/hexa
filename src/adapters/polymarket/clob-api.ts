// ═══════════════════════════════════════════════════════════════
// ZVI v1 — Polymarket CLOB API Adapter
// Orderbook fetching (observation) + trading (execution mode).
// ═══════════════════════════════════════════════════════════════

import type { CLOBOrderbook, OrderbookLevel } from '@/lib/types';

const CLOB_BASE = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';

/**
 * Fetch orderbook for a specific token (outcome).
 * Observation-safe: no private key needed.
 */
export async function fetchOrderbook(tokenId: string): Promise<CLOBOrderbook> {
  const url = `${CLOB_BASE}/book?token_id=${tokenId}`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!resp.ok) {
    throw new Error(`CLOB API error: ${resp.status} ${resp.statusText} for token ${tokenId}`);
  }

  return resp.json();
}

/**
 * Get the best ask price for a token (cheapest YES available).
 */
export function bestAsk(book: CLOBOrderbook): { price: number; size: number } | null {
  if (!book.asks || book.asks.length === 0) return null;
  // Asks sorted ascending by price
  const sorted = [...book.asks].sort((a, b) => Number(a.price) - Number(b.price));
  return { price: Number(sorted[0].price), size: Number(sorted[0].size) };
}

/**
 * Get the best bid price for a token.
 */
export function bestBid(book: CLOBOrderbook): { price: number; size: number } | null {
  if (!book.bids || book.bids.length === 0) return null;
  const sorted = [...book.bids].sort((a, b) => Number(b.price) - Number(a.price));
  return { price: Number(sorted[0].price), size: Number(sorted[0].size) };
}

/**
 * Calculate total depth available up to a certain price level.
 * For asks: sum up sizes from best ask up to maxPrice.
 * Returns depth in USDC terms.
 */
export function depthAtPrice(
  levels: OrderbookLevel[],
  side: 'asks' | 'bids',
  maxSlippage: number = 0.05,
): { depthUsdc: number; avgPrice: number } {
  if (!levels || levels.length === 0) return { depthUsdc: 0, avgPrice: 0 };

  const sorted = [...levels].sort((a, b) =>
    side === 'asks'
      ? Number(a.price) - Number(b.price)
      : Number(b.price) - Number(a.price)
  );

  const basePrice = Number(sorted[0].price);
  const limit = side === 'asks' ? basePrice + maxSlippage : basePrice - maxSlippage;

  let totalSize = 0;
  let totalValue = 0;

  for (const level of sorted) {
    const price = Number(level.price);
    if (side === 'asks' && price > limit) break;
    if (side === 'bids' && price < limit) break;

    const size = Number(level.size);
    totalSize += size;
    totalValue += size * price;
  }

  return {
    depthUsdc: totalValue,
    avgPrice: totalSize > 0 ? totalValue / totalSize : 0,
  };
}

/**
 * Compute bid-ask spread for a token.
 */
export function spread(book: CLOBOrderbook): number {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  if (!bid || !ask) return 1; // Max spread if no liquidity
  return ask.price - bid.price;
}

// ── Execution Mode (behind switch) ──

export interface OrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  type: 'GTC' | 'FOK' | 'GTD';
}

/**
 * Place an order (EXECUTION MODE ONLY).
 * Requires API credentials.
 * Returns order ID or throws.
 */
export async function placeOrder(
  params: OrderParams,
  credentials: { apiKey: string; apiSecret: string; apiPassphrase: string },
): Promise<{ orderId: string }> {
  const url = `${CLOB_BASE}/order`;

  const body = {
    token_id: params.tokenId,
    side: params.side,
    price: params.price.toString(),
    size: params.size.toString(),
    type: params.type,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'POLY_API_KEY': credentials.apiKey,
      'POLY_API_SECRET': credentials.apiSecret,
      'POLY_PASSPHRASE': credentials.apiPassphrase,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`CLOB order failed: ${resp.status} — ${text}`);
  }

  return resp.json();
}
