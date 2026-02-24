import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
  const controllerPath = join(process.cwd(), 'zvi_controller.json');
  if (!existsSync(controllerPath)) {
    return NextResponse.json({
      lastCycle: null,
      lastTs: null,
      activeWindow: null,
      decisions: [],
      proposals: [],
      proposalCount: 0,
      doNothingCount: 0,
      config: null,
    });
  }
  try {
    const data = JSON.parse(readFileSync(controllerPath, 'utf-8'));
    // Strip tickBuffer from response (too large for UI poll)
    const { tickBuffer, ...rest } = data;
    return NextResponse.json({
      ...rest,
      tickBufferSymbols: tickBuffer ? Object.keys(tickBuffer) : [],
      tickBufferCounts: tickBuffer
        ? Object.fromEntries(Object.entries(tickBuffer).map(([k, v]: [string, any]) => [k, v.length]))
        : {},
    });
  } catch (_) {
    return NextResponse.json({ lastCycle: null, decisions: [], proposals: [] });
  }
}
