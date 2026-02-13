// ═══════════════════════════════════════════════════════════════
// ZVI v1 — Deterministic Audit Logger
// Every decision: inputs → computed metrics → LLM narrative → founder action
// This is the immutable record of all system activity.
// ═══════════════════════════════════════════════════════════════

import { getDb } from '@/lib/db';
import { v4 as uuid } from 'uuid';
import type { AuditRecord } from '@/lib/types';

interface AuditInput {
  module: AuditRecord['module'];
  action: string;
  inputs: Record<string, unknown>;
  computedMetrics: Record<string, unknown>;
  llmNarrative?: string;
  founderAction?: string;
  result?: string;
}

/**
 * Log an audit record. Deterministic and immutable.
 */
export function logAudit(input: AuditInput): string {
  const id = uuid();
  const timestamp = new Date().toISOString();

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (id, timestamp, module, action, inputs_json, computed_metrics_json, llm_narrative, founder_action, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      timestamp,
      input.module,
      input.action,
      JSON.stringify(input.inputs),
      JSON.stringify(input.computedMetrics),
      input.llmNarrative || null,
      input.founderAction || null,
      input.result || null,
    );
  } catch (e: any) {
    // Audit logging should never crash the system
    console.error(`[Audit] Failed to log: ${e.message}`);
    console.log(`[Audit] ${timestamp} | ${input.module} | ${input.action} | ${JSON.stringify(input.computedMetrics)}`);
  }

  return id;
}

/**
 * Get recent audit records.
 */
export function getAuditLog(limit: number = 100, module?: string): AuditRecord[] {
  const db = getDb();
  let query = 'SELECT * FROM audit_log';
  const params: any[] = [];

  if (module) {
    query += ' WHERE module = ?';
    params.push(module);
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params) as any[];

  return rows.map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    module: r.module,
    action: r.action,
    inputs: JSON.parse(r.inputs_json),
    computedMetrics: JSON.parse(r.computed_metrics_json),
    llmNarrative: r.llm_narrative,
    founderAction: r.founder_action,
    result: r.result,
  }));
}
