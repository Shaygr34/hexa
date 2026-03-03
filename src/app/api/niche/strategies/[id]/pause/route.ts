import { NextResponse } from 'next/server';
import { initNicheDb } from '@/niche/db-niche';
import { transitionStatus } from '@/niche/strategy-manager';
import { stopController } from '@/niche/strategy-controller';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    stopController(params.id, 'Paused by user');
    const updated = transitionStatus(params.id, 'paused', 'Paused by user');
    return NextResponse.json(updated);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
