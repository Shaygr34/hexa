import { NextResponse } from 'next/server';
import { getDb, initDb } from '@/lib/db';
import { logAudit } from '@/audit/logger';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    initDb();
    const body = await req.json();
    const { id, action } = body; // action: 'approve' | 'simulate' | 'reject'

    if (!id || !action) {
      return NextResponse.json({ error: 'id and action required' }, { status: 400 });
    }

    const db = getDb();

    // Check kill switch
    const killSwitch = db.prepare("SELECT value FROM system_config WHERE key = 'kill_switch'").get() as any;
    if (killSwitch?.value === 'true') {
      return NextResponse.json({ error: 'KILL SWITCH is active. No approvals allowed.' }, { status: 403 });
    }

    // Check observation mode
    const obsOnly = db.prepare("SELECT value FROM system_config WHERE key = 'observation_only'").get() as any;
    if (obsOnly?.value === 'true' && action === 'approve') {
      return NextResponse.json({ error: 'System is in OBSERVATION ONLY mode. Disable to approve trades.' }, { status: 403 });
    }

    const status = action === 'approve' ? 'approved' : action === 'simulate' ? 'simulated' : 'rejected';

    db.prepare(`
      UPDATE opportunities SET approval_status = ?, approved_by = 'founder', approved_at = ? WHERE id = ?
    `).run(status, new Date().toISOString(), id);

    logAudit({
      module: 'execution',
      action: `opportunity_${status}`,
      inputs: { opportunityId: id },
      computedMetrics: {},
      founderAction: action,
    });

    return NextResponse.json({ ok: true, status });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
