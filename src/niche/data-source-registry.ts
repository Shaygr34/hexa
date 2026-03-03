// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Data Source Registry
// Source CRUD + health state management.
// ═══════════════════════════════════════════════════════════════

import { getDb } from '@/lib/db';
import { initNicheDb } from './db-niche';
import type { DataSourceConfig, DataSourceState } from './types';

export function getSourcesForStrategy(strategyId: string): DataSourceConfig[] {
  initNicheDb();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM niche_sources WHERE strategy_id = ? AND enabled = 1 ORDER BY priority DESC').all(strategyId) as any[];
  return rows.map(r => ({
    id: r.id,
    strategyId: r.strategy_id,
    name: r.name,
    type: r.type,
    config: JSON.parse(r.config_json),
    pollIntervalMs: r.poll_interval_ms,
    enabled: !!r.enabled,
    priority: r.priority,
  }));
}

export function getSourceState(sourceId: string): DataSourceState {
  initNicheDb();
  const db = getDb();
  const row = db.prepare('SELECT * FROM niche_source_state WHERE source_id = ?').get(sourceId) as any;
  if (!row) {
    return {
      sourceId,
      health: 'healthy',
      lastPollAt: null,
      lastValue: null,
      lastError: null,
      consecutiveFailures: 0,
      totalPolls: 0,
      totalFailures: 0,
    };
  }
  return {
    sourceId: row.source_id,
    health: row.health,
    lastPollAt: row.last_poll_at,
    lastValue: row.last_value,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    totalPolls: row.total_polls,
    totalFailures: row.total_failures,
  };
}

export function recordPollSuccess(sourceId: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO niche_source_state (source_id, health, last_poll_at, last_value, last_error, consecutive_failures, total_polls, total_failures)
    VALUES (?, 'healthy', ?, ?, NULL, 0, 1, 0)
    ON CONFLICT(source_id) DO UPDATE SET
      health = 'healthy',
      last_poll_at = excluded.last_poll_at,
      last_value = excluded.last_value,
      last_error = NULL,
      consecutive_failures = 0,
      total_polls = total_polls + 1
  `).run(sourceId, new Date().toISOString(), value);
}

export function recordPollFailure(sourceId: string, error: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT consecutive_failures FROM niche_source_state WHERE source_id = ?').get(sourceId) as any;
  const failures = (existing?.consecutive_failures || 0) + 1;
  const health = failures >= 5 ? 'down' : failures >= 2 ? 'degraded' : 'healthy';

  db.prepare(`
    INSERT INTO niche_source_state (source_id, health, last_poll_at, last_error, consecutive_failures, total_polls, total_failures)
    VALUES (?, ?, ?, ?, ?, 1, 1)
    ON CONFLICT(source_id) DO UPDATE SET
      health = excluded.health,
      last_poll_at = excluded.last_poll_at,
      last_error = excluded.last_error,
      consecutive_failures = excluded.consecutive_failures,
      total_polls = total_polls + 1,
      total_failures = total_failures + 1
  `).run(sourceId, health, new Date().toISOString(), error, failures);
}

export function getAllSourceStates(strategyId: string): DataSourceState[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ss.* FROM niche_source_state ss
    JOIN niche_sources s ON ss.source_id = s.id
    WHERE s.strategy_id = ?
  `).all(strategyId) as any[];

  return rows.map(r => ({
    sourceId: r.source_id,
    health: r.health,
    lastPollAt: r.last_poll_at,
    lastValue: r.last_value,
    lastError: r.last_error,
    consecutiveFailures: r.consecutive_failures,
    totalPolls: r.total_polls,
    totalFailures: r.total_failures,
  }));
}
