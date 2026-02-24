import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
  const statePath = join(process.cwd(), 'zvi_state.json');
  if (!existsSync(statePath)) {
    return NextResponse.json({ activeCount: 0, activeWindow: null, resolvedAt: null });
  }
  try {
    const data = JSON.parse(readFileSync(statePath, 'utf-8'));
    return NextResponse.json({
      activeCount: data.activeCount ?? 0,
      closedCount: data.closedCount ?? 0,
      activeWindow: data.activeWindow ?? null,
      resolvedAt: data.resolvedAt ?? null,
      symbols: (data.universeActive || []).map((m: any) => m.symbol),
    });
  } catch (_) {
    return NextResponse.json({ activeCount: 0, activeWindow: null, resolvedAt: null });
  }
}
