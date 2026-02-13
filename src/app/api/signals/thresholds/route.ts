import { NextResponse } from 'next/server';
import { getDb, initDb } from '@/lib/db';
import { v4 as uuid } from 'uuid';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    initDb();
    const db = getDb();
    const rows = db.prepare('SELECT * FROM price_thresholds ORDER BY created_at DESC').all() as any[];
    return NextResponse.json(rows.map(r => ({
      id: r.id,
      symbol: r.symbol,
      exchange: r.exchange,
      currency: r.currency,
      thresholdPrice: r.threshold_price,
      direction: r.direction,
      active: !!r.active,
      createdAt: r.created_at,
    })));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    initDb();
    const body = await req.json();
    const { symbol, exchange, currency, thresholdPrice, direction } = body;

    if (!symbol || !thresholdPrice) {
      return NextResponse.json({ error: 'symbol and thresholdPrice required' }, { status: 400 });
    }

    const db = getDb();
    const id = uuid();
    db.prepare(`
      INSERT INTO price_thresholds (id, symbol, exchange, currency, threshold_price, direction, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, symbol.toUpperCase(), exchange || '', currency || 'USD', thresholdPrice, direction || 'cross', new Date().toISOString());

    return NextResponse.json({ id, ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
