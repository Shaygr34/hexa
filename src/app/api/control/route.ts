import { NextResponse } from 'next/server';
import { getDb, initDb } from '@/lib/db';
import { logAudit } from '@/audit/logger';

export const dynamic = 'force-dynamic';

const KEY_MAP: Record<string, string> = {
  observationOnly: 'observation_only',
  manualApprovalRequired: 'manual_approval_required',
  autoExec: 'auto_exec',
  killSwitch: 'kill_switch',
};

export async function GET() {
  try {
    initDb();
    const db = getDb();
    const rows = db.prepare('SELECT * FROM system_config').all() as any[];

    const config: Record<string, any> = {};
    for (const row of rows) {
      // Reverse map to camelCase
      const camelKey = Object.entries(KEY_MAP).find(([_, v]) => v === row.key)?.[0] || row.key;
      config[camelKey] = row.value === 'true' ? true : row.value === 'false' ? false : row.value;
    }

    return NextResponse.json(config);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    initDb();
    const body = await req.json();
    const db = getDb();

    const updates: string[] = [];

    for (const [key, value] of Object.entries(body)) {
      const dbKey = KEY_MAP[key] || key;
      const strValue = String(value);

      db.prepare(`
        INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      `).run(dbKey, strValue);

      updates.push(`${dbKey}=${strValue}`);
    }

    logAudit({
      module: 'execution',
      action: 'config_updated',
      inputs: body,
      computedMetrics: {},
      founderAction: 'config_change',
    });

    return NextResponse.json({ ok: true, updates });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
