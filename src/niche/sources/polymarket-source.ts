// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Polymarket Data Source
// Wraps existing gamma-api + clob-api → RawDataEvent
// ═══════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { fetchOrderbook, bestAsk, bestBid, spread, depthAtPrice } from '@/adapters/polymarket/clob-api';
import { searchMarkets } from '@/adapters/polymarket/gamma-api';
import type { PolymarketSourceConfig, RawDataEvent, EventDirection } from '../types';

export async function pollPolymarketSource(
  sourceId: string,
  strategyId: string,
  config: PolymarketSourceConfig,
): Promise<RawDataEvent> {
  // Resolve tokenId: if we have marketSlug, search for it
  let tokenId = config.tokenId;
  if (!tokenId && config.marketSlug) {
    const markets = await searchMarkets(config.marketSlug, 1);
    if (markets.length === 0) throw new Error(`No market found for slug: ${config.marketSlug}`);
    const m = markets[0];
    const tokens = m.tokens || [];
    const yesToken = tokens.find(t => t.outcome === 'Yes');
    tokenId = yesToken?.token_id || (m.clobTokenIds ? JSON.parse(m.clobTokenIds)[0] : undefined);
    if (!tokenId) throw new Error(`No token ID found for market: ${config.marketSlug}`);
  }
  if (!tokenId) throw new Error('Polymarket source needs tokenId or marketSlug');

  const book = await fetchOrderbook(tokenId);
  const ask = bestAsk(book);
  const bid = bestBid(book);
  const sp = spread(book);
  const askDepth = depthAtPrice(book.asks, 'asks');
  const bidDepth = depthAtPrice(book.bids, 'bids');

  let value: number;
  let direction: EventDirection = 'neutral';

  switch (config.metric) {
    case 'price': {
      value = ask ? ask.price : 0.5;
      // Price > 0.5 is bullish (market thinks YES likely)
      direction = value > 0.55 ? 'bullish' : value < 0.45 ? 'bearish' : 'neutral';
      break;
    }
    case 'spread': {
      value = sp;
      // Wide spread = neutral (uncertain), tight = bullish for trading
      direction = value < 0.02 ? 'bullish' : value > 0.1 ? 'bearish' : 'neutral';
      break;
    }
    case 'depth': {
      value = Math.min(askDepth.depthUsdc, bidDepth.depthUsdc);
      direction = value > 100 ? 'bullish' : value < 10 ? 'bearish' : 'neutral';
      break;
    }
    case 'imbalance': {
      // Bid/ask depth imbalance — strong bid depth = bullish
      const totalBid = bidDepth.depthUsdc;
      const totalAsk = askDepth.depthUsdc;
      const total = totalBid + totalAsk;
      value = total > 0 ? (totalBid - totalAsk) / total : 0;
      direction = value > 0.2 ? 'bullish' : value < -0.2 ? 'bearish' : 'neutral';
      break;
    }
    default: {
      value = ask ? ask.price : 0.5;
      break;
    }
  }

  return {
    id: uuid(),
    sourceId,
    strategyId,
    timestamp: new Date().toISOString(),
    value,
    numericValue: value,
    direction,
    rawPayload: {
      tokenId,
      askPrice: ask?.price ?? null,
      bidPrice: bid?.price ?? null,
      spread: sp,
      askDepth: askDepth.depthUsdc,
      bidDepth: bidDepth.depthUsdc,
    },
    metadata: { metric: config.metric, slug: config.marketSlug },
  };
}
