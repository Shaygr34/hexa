import { NextResponse } from 'next/server';
import { initNicheDb, appendLog } from '@/niche/db-niche';
import { getStrategy, updateStrategy, transitionStatus } from '@/niche/strategy-manager';
import { startController } from '@/niche/strategy-controller';
import { autoDiscoverMarkets } from '@/niche/market-scanner';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    let strategy = getStrategy(params.id);
    if (!strategy) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 });

    // Validate: need at least 1 source
    if (strategy.dataSources.length === 0) {
      return NextResponse.json({ error: 'Strategy needs at least one data source. Go to Config and add sources.' }, { status: 400 });
    }

    // Transition to validating
    if (strategy.status === 'draft' || strategy.status === 'error' || strategy.status === 'stopped') {
      transitionStatus(params.id, 'validating');
    }

    // Auto-discover markets if none are set
    if (strategy.targetMarkets.length === 0) {
      appendLog(params.id, 'info', 'activate', `Auto-discovering markets for topic: "${strategy.topic}"`, {});
      const discovered = await autoDiscoverMarkets(strategy.topic, strategy.meta);
      if (discovered.length > 0) {
        updateStrategy(params.id, { targetMarkets: discovered });
        appendLog(params.id, 'info', 'activate', `Auto-discovered ${discovered.length} markets`, {
          markets: discovered.map(m => m.slug),
        });
      } else {
        appendLog(params.id, 'warn', 'activate', 'No markets found for topic — strategy will run without trade targets', {});
      }
    }

    // Re-read strategy after market update
    strategy = getStrategy(params.id)!;
    const activated = transitionStatus(params.id, 'active');

    // Start the controller loop
    await startController(params.id);

    return NextResponse.json({
      ...activated,
      marketsDiscovered: strategy.targetMarkets.length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
