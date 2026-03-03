import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initNicheDb } from '@/niche/db-niche';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM niche_signals WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(params.id) as any[];

    const signals = rows.map(r => ({
      id: r.id,
      strategyId: r.strategy_id,
      marketId: r.market_id,
      marketSlug: r.market_slug,
      action: r.action,
      estimatedProbability: r.estimated_probability,
      marketPrice: r.market_price,
      edge: r.edge,
      confidence: r.confidence,
      reasoning: JSON.parse(r.reasoning_json || '[]'),
      activeEvents: JSON.parse(r.active_events_json || '[]'),
      riskGates: JSON.parse(r.risk_gates_json || '[]'),
      outcome: r.outcome,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    }));

    return NextResponse.json(signals);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
