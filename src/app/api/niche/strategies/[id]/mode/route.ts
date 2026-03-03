import { NextResponse } from 'next/server';
import { initNicheDb } from '@/niche/db-niche';
import { switchMode } from '@/niche/strategy-manager';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    const { mode } = await req.json();
    if (!['observe', 'paper', 'live'].includes(mode)) {
      return NextResponse.json({ error: 'mode must be observe, paper, or live' }, { status: 400 });
    }
    const updated = switchMode(params.id, mode);
    return NextResponse.json(updated);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
