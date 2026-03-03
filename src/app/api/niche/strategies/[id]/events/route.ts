import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initNicheDb } from '@/niche/db-niche';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    initNicheDb();
    const db = getDb();

    // Active compound events
    const compound = db.prepare(`
      SELECT * FROM niche_events_compound
      WHERE strategy_id = ? AND expires_at > datetime('now')
      ORDER BY timestamp DESC LIMIT 50
    `).all(params.id) as any[];

    // Recent raw events
    const raw = db.prepare(`
      SELECT * FROM niche_events_raw
      WHERE strategy_id = ?
      ORDER BY timestamp DESC LIMIT 50
    `).all(params.id) as any[];

    return NextResponse.json({
      compound: compound.map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        type: r.type,
        title: r.title,
        direction: r.direction,
        strength: r.strength,
        sourceIds: JSON.parse(r.source_ids_json || '[]'),
        details: JSON.parse(r.details_json || '{}'),
        expiresAt: r.expires_at,
      })),
      raw: raw.map(r => ({
        id: r.id,
        sourceId: r.source_id,
        timestamp: r.timestamp,
        value: r.value,
        numericValue: r.numeric_value,
        direction: r.direction,
        metadata: JSON.parse(r.metadata_json || '{}'),
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
