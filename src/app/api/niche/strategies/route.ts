// ═══════════════════════════════════════════════════════════════
// Niche API — GET list strategies + POST create strategy
// ═══════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { initNicheDb, appendLog } from '@/niche/db-niche';
import { listStrategies, createStrategy, updateStrategy } from '@/niche/strategy-manager';
import { getPerformance } from '@/niche/trade-executor';
import { isControllerRunning, getControllerStats } from '@/niche/strategy-controller';
import { getAllSourceStates } from '@/niche/data-source-registry';
import { autoDiscoverMarkets } from '@/niche/market-scanner';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    initNicheDb();
    const strategies = listStrategies();

    const enriched = strategies.map(s => ({
      ...s,
      performance: getPerformance(s.id),
      controllerRunning: isControllerRunning(s.id),
      controllerStats: getControllerStats(s.id),
      sourceStates: getAllSourceStates(s.id),
    }));

    return NextResponse.json(enriched);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    initNicheDb();
    const body = await req.json();

    if (!body.name || !body.topic) {
      return NextResponse.json({ error: 'name and topic are required' }, { status: 400 });
    }

    const strategy = createStrategy(body);

    // Auto-discover markets for the topic immediately
    if (strategy.targetMarkets.length === 0 && strategy.topic) {
      try {
        appendLog(strategy.id, 'info', 'create', `Auto-discovering markets for topic: "${strategy.topic}"`, {});
        const discovered = await autoDiscoverMarkets(strategy.topic, strategy.meta);
        if (discovered.length > 0) {
          updateStrategy(strategy.id, { targetMarkets: discovered });
          appendLog(strategy.id, 'info', 'create', `Auto-discovered ${discovered.length} markets`, {
            markets: discovered.map(m => m.slug),
          });
          // Return updated strategy with markets
          const updated = { ...strategy, targetMarkets: discovered };
          return NextResponse.json(updated, { status: 201 });
        } else {
          appendLog(strategy.id, 'warn', 'create', 'No markets found for topic — add markets manually or they will be discovered on activation', {});
        }
      } catch (err: any) {
        appendLog(strategy.id, 'warn', 'create', `Market auto-discovery failed: ${err.message} — markets can be added manually`, {});
      }
    }

    return NextResponse.json(strategy, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
