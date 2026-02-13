import { NextResponse } from 'next/server';
import { getDb, initDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    initDb();
    const db = getDb();
    const rows = db.prepare('SELECT * FROM signal_alerts ORDER BY triggered_at DESC LIMIT 50').all() as any[];

    const signals = rows.map(r => ({
      id: r.id,
      thresholdId: r.threshold_id,
      symbol: r.symbol,
      triggeredPrice: r.triggered_price,
      thresholdPrice: r.threshold_price,
      direction: r.direction,
      report: JSON.parse(r.report_json),
      triggeredAt: r.triggered_at,
      acknowledged: !!r.acknowledged,
    }));

    return NextResponse.json(signals);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
