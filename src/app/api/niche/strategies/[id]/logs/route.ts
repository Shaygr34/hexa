import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initNicheDb } from '@/niche/db-niche';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    const db = getDb();
    const url = new URL(req.url);
    const level = url.searchParams.get('level');
    const limit = parseInt(url.searchParams.get('limit') || '200');

    let query = 'SELECT * FROM niche_logs WHERE strategy_id = ?';
    const queryParams: any[] = [params.id];

    if (level) {
      query += ' AND level = ?';
      queryParams.push(level);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    queryParams.push(Math.min(limit, 1000));

    const rows = db.prepare(query).all(...queryParams) as any[];

    const logs = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      level: r.level,
      module: r.module,
      message: r.message,
      data: JSON.parse(r.data_json || '{}'),
    }));

    return NextResponse.json(logs);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
