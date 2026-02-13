import { NextResponse } from 'next/server';
import { getDb, initDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    initDb();
    const db = getDb();
    const rows = db.prepare('SELECT * FROM agent_health').all() as any[];

    const agents = rows.map(r => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      status: r.status,
      lastHeartbeat: r.last_heartbeat,
      lastError: r.last_error,
      cycleCount: r.cycle_count,
    }));

    return NextResponse.json(agents);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
