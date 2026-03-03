// ═══════════════════════════════════════════════════════════════
// Niche API — GET detail + PATCH update + DELETE strategy
// ═══════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { initNicheDb } from '@/niche/db-niche';
import { getStrategy, updateStrategy, deleteStrategy } from '@/niche/strategy-manager';
import { getPerformance } from '@/niche/trade-executor';
import { isControllerRunning, getControllerStats } from '@/niche/strategy-controller';
import { getAllSourceStates } from '@/niche/data-source-registry';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    const strategy = getStrategy(params.id);
    if (!strategy) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 });

    return NextResponse.json({
      ...strategy,
      performance: getPerformance(strategy.id),
      controllerRunning: isControllerRunning(strategy.id),
      controllerStats: getControllerStats(strategy.id),
      sourceStates: getAllSourceStates(strategy.id),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    const body = await req.json();
    const updated = updateStrategy(params.id, body);
    if (!updated) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 });
    return NextResponse.json(updated);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.message.includes('Cannot') ? 409 : 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    const deleted = deleteStrategy(params.id);
    if (!deleted) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.message.includes('Cannot') ? 409 : 500 });
  }
}
