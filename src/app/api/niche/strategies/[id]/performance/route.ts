import { NextResponse } from 'next/server';
import { initNicheDb } from '@/niche/db-niche';
import { getPerformance, updatePerformanceStats } from '@/niche/trade-executor';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    const perf = getPerformance(params.id);
    return NextResponse.json(perf);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
