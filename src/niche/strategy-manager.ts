// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Strategy Manager
// CRUD + lifecycle state machine for strategies.
// ═══════════════════════════════════════════════════════════════

import { getDb } from '@/lib/db';
import { v4 as uuid } from 'uuid';
import { initNicheDb, getStrategyRow, listStrategyRows, appendLog } from './db-niche';
import type {
  NicheStrategy, StrategyStatus, ExecutionMode, DataSourceConfig,
  TargetMarket, RiskConfig, SessionConfig, StrategyMeta,
} from './types';

// ── Valid state transitions ──
const TRANSITIONS: Record<StrategyStatus, StrategyStatus[]> = {
  draft:      ['validating', 'stopped'],
  validating: ['active', 'draft', 'error'],
  active:     ['paused', 'stopped', 'error'],
  paused:     ['active', 'stopped'],
  stopped:    ['draft', 'validating'],  // can restart directly
  error:      ['draft', 'stopped', 'validating'],
};

function canTransition(from: StrategyStatus, to: StrategyStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

function rowToStrategy(r: any): NicheStrategy {
  return {
    id: r.id,
    name: r.name,
    topic: r.topic,
    description: r.description,
    status: r.status,
    executionMode: r.execution_mode,
    dataSources: JSON.parse(r.data_sources_json || '[]'),
    targetMarkets: JSON.parse(r.target_markets_json || '[]'),
    decisionIntervalMs: r.decision_interval_ms,
    edgeThresholdPct: r.edge_threshold_pct,
    confidenceMinimum: r.confidence_minimum,
    riskConfig: JSON.parse(r.risk_config_json || '{}'),
    sessionConfig: JSON.parse(r.session_config_json || '{}'),
    meta: JSON.parse(r.meta_json || '{}'),
    analysisReport: r.analysis_report,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    activatedAt: r.activated_at,
    stoppedAt: r.stopped_at,
    stopReason: r.stop_reason,
  };
}

// ── CRUD ──

export function createStrategy(input: {
  name: string;
  topic: string;
  description?: string;
  executionMode?: ExecutionMode;
  dataSources?: DataSourceConfig[];
  targetMarkets?: TargetMarket[];
  decisionIntervalMs?: number;
  edgeThresholdPct?: number;
  confidenceMinimum?: number;
  riskConfig?: Partial<RiskConfig>;
  sessionConfig?: Partial<SessionConfig>;
  meta?: Partial<StrategyMeta>;
  analysisReport?: string;
}): NicheStrategy {
  initNicheDb();
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  const defaultRisk: RiskConfig = {
    maxPositionUsdc: 10,
    maxExposureUsdc: 50,
    maxDrawdownPct: 20,
    stopLossPct: 10,
    maxOpenPositions: 5,
    cooldownMs: 30000,
    killSwitch: false,
    ...input.riskConfig,
  };

  const defaultSession: SessionConfig = {
    maxDurationMs: 3600000,         // 1 hour
    maxTotalTrades: 100,
    budgetUsdc: 100,
    dailyLossLimitUsdc: 20,
    dailyLossLimitPct: 20,
    maxConsecutiveLosses: 5,
    trailingStopPct: 15,
    minBankrollUsdc: 10,
    warmupCycles: 3,
    autoStopOnError: true,
    ...input.sessionConfig,
  };

  const defaultMeta: StrategyMeta = {
    horizon: '15m',
    patternType: 'momentum',
    dataType: 'price',
    eventFrequency: 'high',
    marketType: 'crypto_short_term',
    ...input.meta,
  };

  db.prepare(`
    INSERT INTO niche_strategies (
      id, name, topic, description, status, execution_mode,
      data_sources_json, target_markets_json, decision_interval_ms,
      edge_threshold_pct, confidence_minimum, risk_config_json,
      session_config_json, meta_json, analysis_report, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.name, input.topic, input.description || '',
    input.executionMode || 'observe',
    JSON.stringify(input.dataSources || []),
    JSON.stringify(input.targetMarkets || []),
    input.decisionIntervalMs || 15000,
    input.edgeThresholdPct || 0.03,
    input.confidenceMinimum || 0.6,
    JSON.stringify(defaultRisk),
    JSON.stringify(defaultSession),
    JSON.stringify(defaultMeta),
    input.analysisReport || null,
    now, now,
  );

  // Initialize performance row
  db.prepare(`
    INSERT INTO niche_performance (strategy_id, bankroll, initial_bankroll, last_updated)
    VALUES (?, ?, ?, ?)
  `).run(id, defaultSession.budgetUsdc, defaultSession.budgetUsdc, now);

  // Persist data sources to niche_sources table
  for (const src of input.dataSources || []) {
    db.prepare(`
      INSERT INTO niche_sources (id, strategy_id, name, type, config_json, poll_interval_ms, enabled, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(src.id || uuid(), id, src.name, src.type, JSON.stringify(src.config), src.pollIntervalMs, src.enabled ? 1 : 0, src.priority);
  }

  appendLog(id, 'info', 'strategy-manager', `Strategy "${input.name}" created`, { topic: input.topic });
  return getStrategy(id)!;
}

export function getStrategy(id: string): NicheStrategy | null {
  initNicheDb();
  const row = getStrategyRow(id);
  return row ? rowToStrategy(row) : null;
}

export function listStrategies(): NicheStrategy[] {
  initNicheDb();
  return listStrategyRows().map(rowToStrategy);
}

export function updateStrategy(id: string, updates: Partial<{
  name: string;
  topic: string;
  description: string;
  executionMode: ExecutionMode;
  dataSources: DataSourceConfig[];
  targetMarkets: TargetMarket[];
  decisionIntervalMs: number;
  edgeThresholdPct: number;
  confidenceMinimum: number;
  riskConfig: RiskConfig;
  sessionConfig: SessionConfig;
  meta: StrategyMeta;
  analysisReport: string;
}>): NicheStrategy | null {
  initNicheDb();
  const existing = getStrategyRow(id);
  if (!existing) return null;
  if (existing.status === 'active') {
    throw new Error('Cannot update strategy while active. Pause it first.');
  }

  const db = getDb();
  const now = new Date().toISOString();

  const fields: string[] = ['updated_at = ?'];
  const values: any[] = [now];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.topic !== undefined) { fields.push('topic = ?'); values.push(updates.topic); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.executionMode !== undefined) { fields.push('execution_mode = ?'); values.push(updates.executionMode); }
  if (updates.dataSources !== undefined) { fields.push('data_sources_json = ?'); values.push(JSON.stringify(updates.dataSources)); }
  if (updates.targetMarkets !== undefined) { fields.push('target_markets_json = ?'); values.push(JSON.stringify(updates.targetMarkets)); }
  if (updates.decisionIntervalMs !== undefined) { fields.push('decision_interval_ms = ?'); values.push(updates.decisionIntervalMs); }
  if (updates.edgeThresholdPct !== undefined) { fields.push('edge_threshold_pct = ?'); values.push(updates.edgeThresholdPct); }
  if (updates.confidenceMinimum !== undefined) { fields.push('confidence_minimum = ?'); values.push(updates.confidenceMinimum); }
  if (updates.riskConfig !== undefined) { fields.push('risk_config_json = ?'); values.push(JSON.stringify(updates.riskConfig)); }
  if (updates.sessionConfig !== undefined) { fields.push('session_config_json = ?'); values.push(JSON.stringify(updates.sessionConfig)); }
  if (updates.meta !== undefined) { fields.push('meta_json = ?'); values.push(JSON.stringify(updates.meta)); }
  if (updates.analysisReport !== undefined) { fields.push('analysis_report = ?'); values.push(updates.analysisReport); }

  values.push(id);
  db.prepare(`UPDATE niche_strategies SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // Sync data sources table if updated
  if (updates.dataSources) {
    db.prepare('DELETE FROM niche_sources WHERE strategy_id = ?').run(id);
    for (const src of updates.dataSources) {
      db.prepare(`
        INSERT INTO niche_sources (id, strategy_id, name, type, config_json, poll_interval_ms, enabled, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(src.id || uuid(), id, src.name, src.type, JSON.stringify(src.config), src.pollIntervalMs, src.enabled ? 1 : 0, src.priority);
    }
  }

  return getStrategy(id);
}

export function deleteStrategy(id: string): boolean {
  initNicheDb();
  const existing = getStrategyRow(id);
  if (!existing) return false;
  if (existing.status === 'active') {
    throw new Error('Cannot delete active strategy. Stop it first.');
  }
  const db = getDb();
  db.prepare('DELETE FROM niche_strategies WHERE id = ?').run(id);
  return true;
}

// ── Lifecycle State Machine ──

export function transitionStatus(id: string, targetStatus: StrategyStatus, reason?: string): NicheStrategy {
  initNicheDb();
  const row = getStrategyRow(id);
  if (!row) throw new Error(`Strategy ${id} not found`);

  const currentStatus = row.status as StrategyStatus;
  if (!canTransition(currentStatus, targetStatus)) {
    throw new Error(`Invalid transition: ${currentStatus} → ${targetStatus}`);
  }

  const db = getDb();
  const now = new Date().toISOString();
  const extras: Record<string, any> = { updated_at: now };

  if (targetStatus === 'active' && !row.activated_at) {
    extras.activated_at = now;
  }
  if (targetStatus === 'stopped' || targetStatus === 'error') {
    extras.stopped_at = now;
    extras.stop_reason = reason || null;
  }

  const sets = ['status = ?', ...Object.keys(extras).map(k => `${k} = ?`)];
  const vals = [targetStatus, ...Object.values(extras), id];
  db.prepare(`UPDATE niche_strategies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  appendLog(id, targetStatus === 'error' ? 'error' : 'info', 'strategy-manager',
    `Status: ${currentStatus} → ${targetStatus}${reason ? ` (${reason})` : ''}`,
    { from: currentStatus, to: targetStatus, reason });

  return getStrategy(id)!;
}

export function switchMode(id: string, mode: ExecutionMode): NicheStrategy {
  initNicheDb();
  const row = getStrategyRow(id);
  if (!row) throw new Error(`Strategy ${id} not found`);

  const db = getDb();
  db.prepare('UPDATE niche_strategies SET execution_mode = ?, updated_at = ? WHERE id = ?')
    .run(mode, new Date().toISOString(), id);

  appendLog(id, 'info', 'strategy-manager', `Mode switched to ${mode}`, { mode });
  return getStrategy(id)!;
}
