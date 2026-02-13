import { NextResponse } from 'next/server';
import { initDb } from '@/lib/db';
import { updatePrice } from '@/agents/signal-watcher-agent';
import { checkOnce } from '@/agents/signal-watcher-agent';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    initDb();
    const body = await req.json();
    const { symbol, price } = body;

    if (!symbol || price === undefined) {
      return NextResponse.json({ error: 'symbol and price required' }, { status: 400 });
    }

    // Update the in-memory price store
    updatePrice(symbol, Number(price));

    // Immediately check thresholds
    const alerts = await checkOnce();

    return NextResponse.json({
      ok: true,
      symbol: symbol.toUpperCase(),
      price: Number(price),
      alertsTriggered: alerts.length,
      alerts: alerts.map(a => ({
        id: a.id,
        symbol: a.symbol,
        triggeredPrice: a.triggeredPrice,
        thresholdPrice: a.thresholdPrice,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
