import { NextResponse } from 'next/server';
import { getDb, initDb } from '@/lib/db';
import { v4 as uuid } from 'uuid';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    initDb();
    const db = getDb();
    const rows = db.prepare('SELECT * FROM pinned_markets ORDER BY pinned_at DESC').all() as any[];

    const markets = rows.map(r => ({
      id: r.id,
      marketId: r.market_id,
      marketName: r.market_name,
      marketSlug: r.market_slug,
      marketPrice: r.market_price,
      zviProbability: r.zvi_probability,
      confidenceLow: r.confidence_low,
      confidenceHigh: r.confidence_high,
      mispricingGap: r.mispricing_gap,
      reasoning: r.reasoning_json ? JSON.parse(r.reasoning_json) : [],
      sources: r.sources_json ? JSON.parse(r.sources_json) : [],
      suggestedAction: r.suggested_action,
      lastAnalyzedAt: r.last_analyzed_at,
      pinnedAt: r.pinned_at,
      pinnedBy: r.pinned_by,
    }));

    return NextResponse.json(markets);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    initDb();
    const body = await req.json();
    const { marketId, marketName, marketPrice } = body;

    if (!marketId || !marketName) {
      return NextResponse.json({ error: 'marketId and marketName required' }, { status: 400 });
    }

    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO pinned_markets (id, market_id, market_name, market_slug, market_price, pinned_at, pinned_by)
      VALUES (?, ?, ?, ?, ?, ?, 'founder')
    `).run(uuid(), marketId, marketName, '', marketPrice || 0, new Date().toISOString());

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
