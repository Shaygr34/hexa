import { NextResponse } from 'next/server';
import { initNicheDb } from '@/niche/db-niche';
import { getStrategy, updateStrategy } from '@/niche/strategy-manager';
import { getMarketStates } from '@/niche/market-scanner';
import { discoverMarkets } from '@/niche/market-scanner';

export const dynamic = 'force-dynamic';

// GET: return target markets + their live state
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    const strategy = getStrategy(params.id);
    if (!strategy) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 });

    const marketStates = getMarketStates(params.id);

    // Merge target market config with live state
    const markets = strategy.targetMarkets.map(tm => {
      const state = marketStates.find(ms => ms.conditionId === tm.conditionId);
      return {
        ...tm,
        yesPrice: state?.yesPrice ?? null,
        noPrice: state?.noPrice ?? null,
        spread: state?.spread ?? null,
        yesDepthUsdc: state?.yesDepthUsdc ?? null,
        noDepthUsdc: state?.noDepthUsdc ?? null,
        lastUpdatedAt: state?.lastUpdatedAt ?? null,
        priceHistory: state?.priceHistory ?? [],
      };
    });

    return NextResponse.json({ markets });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST: discover new markets for the strategy topic, or add/remove markets
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    const strategy = getStrategy(params.id);
    if (!strategy) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 });

    const body = await req.json();

    // Action: discover markets
    if (body.action === 'discover') {
      const queries = body.queries || [strategy.topic];
      const slugPatterns = body.slugPatterns || [];
      const discovered = await discoverMarkets(queries, slugPatterns, body.limit || 20);
      return NextResponse.json({ discovered });
    }

    // Action: set target markets (replace all)
    if (body.action === 'set') {
      const updated = updateStrategy(params.id, { targetMarkets: body.markets || [] });
      return NextResponse.json(updated);
    }

    // Action: add a single market
    if (body.action === 'add' && body.market) {
      const existing = strategy.targetMarkets;
      if (existing.some(m => m.conditionId === body.market.conditionId)) {
        return NextResponse.json({ error: 'Market already added' }, { status: 400 });
      }
      const updated = updateStrategy(params.id, { targetMarkets: [...existing, body.market] });
      return NextResponse.json(updated);
    }

    // Action: remove a market
    if (body.action === 'remove' && body.conditionId) {
      const updated = updateStrategy(params.id, {
        targetMarkets: strategy.targetMarkets.filter(m => m.conditionId !== body.conditionId),
      });
      return NextResponse.json(updated);
    }

    return NextResponse.json({ error: 'Unknown action. Use: discover, set, add, remove' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.message.includes('Cannot') ? 409 : 500 });
  }
}
