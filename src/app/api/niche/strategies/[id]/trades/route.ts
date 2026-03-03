import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initNicheDb } from '@/niche/db-niche';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM niche_trades WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(params.id) as any[];

    const trades = rows.map(r => ({
      id: r.id,
      strategyId: r.strategy_id,
      signalId: r.signal_id,
      marketId: r.market_id,
      marketSlug: r.market_slug,
      side: r.side,
      price: r.price,
      size: r.size,
      shares: r.shares,
      fees: r.fees,
      slippage: r.slippage,
      status: r.status,
      demo: !!r.demo,
      orderId: r.order_id,
      resolution: r.resolution,
      realizedPnl: r.realized_pnl,
      provenance: JSON.parse(r.provenance_json || '{}'),
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    }));

    return NextResponse.json(trades);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
