// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Database Layer
// SQLite tables for strategies, sources, events, signals, trades.
// Reuses existing getDb() singleton — same database, new tables.
// ═══════════════════════════════════════════════════════════════

import { getDb } from '@/lib/db';

let _initialized = false;

export function initNicheDb(): void {
  if (_initialized) return;
  const db = getDb();

  db.exec(`
    -- Strategy definitions
    CREATE TABLE IF NOT EXISTS niche_strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      topic TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','validating','active','paused','stopped','error')),
      execution_mode TEXT NOT NULL DEFAULT 'observe'
        CHECK(execution_mode IN ('observe','paper','live')),
      data_sources_json TEXT NOT NULL DEFAULT '[]',
      target_markets_json TEXT NOT NULL DEFAULT '[]',
      decision_interval_ms INTEGER NOT NULL DEFAULT 15000,
      edge_threshold_pct REAL NOT NULL DEFAULT 0.03,
      confidence_minimum REAL NOT NULL DEFAULT 0.6,
      risk_config_json TEXT NOT NULL DEFAULT '{}',
      session_config_json TEXT NOT NULL DEFAULT '{}',
      meta_json TEXT NOT NULL DEFAULT '{}',
      analysis_report TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activated_at TEXT,
      stopped_at TEXT,
      stop_reason TEXT
    );

    -- Data source configurations (per-strategy)
    CREATE TABLE IF NOT EXISTS niche_sources (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('api','polymarket','llm')),
      config_json TEXT NOT NULL DEFAULT '{}',
      poll_interval_ms INTEGER NOT NULL DEFAULT 10000,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (strategy_id) REFERENCES niche_strategies(id) ON DELETE CASCADE
    );

    -- Data source runtime state (health tracking)
    CREATE TABLE IF NOT EXISTS niche_source_state (
      source_id TEXT PRIMARY KEY,
      health TEXT NOT NULL DEFAULT 'healthy'
        CHECK(health IN ('healthy','degraded','down')),
      last_poll_at TEXT,
      last_value TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      total_polls INTEGER NOT NULL DEFAULT 0,
      total_failures INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (source_id) REFERENCES niche_sources(id) ON DELETE CASCADE
    );

    -- Raw events from data sources
    CREATE TABLE IF NOT EXISTS niche_events_raw (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      value TEXT NOT NULL,
      numeric_value REAL,
      direction TEXT NOT NULL DEFAULT 'neutral'
        CHECK(direction IN ('bullish','bearish','neutral')),
      raw_payload_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    -- Compound / aggregated events (the core IP)
    CREATE TABLE IF NOT EXISTS niche_events_compound (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      constituent_event_ids_json TEXT NOT NULL DEFAULT '[]',
      source_ids_json TEXT NOT NULL DEFAULT '[]',
      direction TEXT NOT NULL DEFAULT 'neutral',
      strength REAL NOT NULL DEFAULT 0,
      details_json TEXT NOT NULL DEFAULT '{}',
      ttl_ms INTEGER NOT NULL DEFAULT 60000,
      expires_at TEXT NOT NULL
    );

    -- Market state snapshots
    CREATE TABLE IF NOT EXISTS niche_market_state (
      condition_id TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      question TEXT NOT NULL DEFAULT '',
      yes_price REAL NOT NULL DEFAULT 0.5,
      no_price REAL NOT NULL DEFAULT 0.5,
      spread REAL NOT NULL DEFAULT 0,
      yes_depth_usdc REAL NOT NULL DEFAULT 0,
      no_depth_usdc REAL NOT NULL DEFAULT 0,
      volume_24h REAL,
      last_updated_at TEXT NOT NULL,
      price_history_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (condition_id, strategy_id)
    );

    -- Signals (decision engine output)
    CREATE TABLE IF NOT EXISTS niche_signals (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      market_slug TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL CHECK(action IN ('BUY_YES','BUY_NO','HOLD')),
      estimated_probability REAL NOT NULL,
      market_price REAL NOT NULL,
      edge REAL NOT NULL,
      confidence REAL NOT NULL,
      reasoning_json TEXT NOT NULL DEFAULT '[]',
      active_events_json TEXT NOT NULL DEFAULT '[]',
      risk_gates_json TEXT NOT NULL DEFAULT '[]',
      outcome TEXT NOT NULL DEFAULT 'pending'
        CHECK(outcome IN ('pending','win','loss','expired','skipped')),
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    -- Trades (paper or live)
    CREATE TABLE IF NOT EXISTS niche_trades (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      signal_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      market_slug TEXT NOT NULL DEFAULT '',
      side TEXT NOT NULL CHECK(side IN ('YES','NO')),
      price REAL NOT NULL,
      size REAL NOT NULL,
      shares REAL NOT NULL DEFAULT 0,
      fees REAL NOT NULL DEFAULT 0,
      slippage REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','filled','cancelled','failed')),
      demo INTEGER NOT NULL DEFAULT 1,
      order_id TEXT,
      resolution TEXT CHECK(resolution IN ('pending','won','lost')),
      realized_pnl REAL,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    -- Performance tracking (one row per strategy)
    CREATE TABLE IF NOT EXISTS niche_performance (
      strategy_id TEXT PRIMARY KEY,
      bankroll REAL NOT NULL DEFAULT 100,
      initial_bankroll REAL NOT NULL DEFAULT 100,
      total_trades INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0,
      win_rate REAL NOT NULL DEFAULT 0,
      total_pnl REAL NOT NULL DEFAULT 0,
      total_pnl_pct REAL NOT NULL DEFAULT 0,
      peak_bankroll REAL NOT NULL DEFAULT 100,
      max_drawdown REAL NOT NULL DEFAULT 0,
      max_drawdown_pct REAL NOT NULL DEFAULT 0,
      sharpe_estimate REAL,
      current_streak INTEGER NOT NULL DEFAULT 0,
      longest_win_streak INTEGER NOT NULL DEFAULT 0,
      longest_loss_streak INTEGER NOT NULL DEFAULT 0,
      avg_win_size REAL NOT NULL DEFAULT 0,
      avg_loss_size REAL NOT NULL DEFAULT 0,
      profit_factor REAL,
      equity_curve_json TEXT NOT NULL DEFAULT '[]',
      last_updated TEXT NOT NULL
    );

    -- Structured log entries (decisions, events, errors)
    CREATE TABLE IF NOT EXISTS niche_logs (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info'
        CHECK(level IN ('info','warn','error','decision','trade')),
      module TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}'
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_niche_strat_status ON niche_strategies(status);
    CREATE INDEX IF NOT EXISTS idx_niche_sources_strat ON niche_sources(strategy_id);
    CREATE INDEX IF NOT EXISTS idx_niche_raw_strat ON niche_events_raw(strategy_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_niche_raw_source ON niche_events_raw(source_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_niche_compound_strat ON niche_events_compound(strategy_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_niche_compound_expires ON niche_events_compound(expires_at);
    CREATE INDEX IF NOT EXISTS idx_niche_signals_strat ON niche_signals(strategy_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_niche_trades_strat ON niche_trades(strategy_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_niche_logs_strat ON niche_logs(strategy_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_niche_logs_level ON niche_logs(strategy_id, level);
  `);

  _initialized = true;
}

// ── Query Helpers ──

export function getStrategyRow(id: string): any {
  const db = getDb();
  return db.prepare('SELECT * FROM niche_strategies WHERE id = ?').get(id);
}

export function listStrategyRows(): any[] {
  const db = getDb();
  return db.prepare('SELECT * FROM niche_strategies ORDER BY updated_at DESC').all() as any[];
}

export function upsertPerformance(strategyId: string, data: Record<string, any>): void {
  const db = getDb();
  const existing = db.prepare('SELECT strategy_id FROM niche_performance WHERE strategy_id = ?').get(strategyId);
  if (existing) {
    const sets = Object.entries(data).map(([k, _]) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE niche_performance SET ${sets} WHERE strategy_id = @strategy_id`).run({ strategy_id: strategyId, ...data });
  } else {
    db.prepare(`
      INSERT INTO niche_performance (strategy_id, last_updated)
      VALUES (?, datetime('now'))
    `).run(strategyId);
  }
}

export function appendLog(
  strategyId: string, level: string, module: string, message: string, data: Record<string, unknown> = {}
): void {
  const db = getDb();
  const { v4: uuid } = require('uuid');
  db.prepare(`
    INSERT INTO niche_logs (id, strategy_id, timestamp, level, module, message, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuid(), strategyId, new Date().toISOString(), level, module, message, JSON.stringify(data));
}

export function pruneOldRawEvents(strategyId: string, keepCount: number = 1000): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM niche_events_raw
    WHERE strategy_id = ? AND id NOT IN (
      SELECT id FROM niche_events_raw WHERE strategy_id = ? ORDER BY timestamp DESC LIMIT ?
    )
  `).run(strategyId, strategyId, keepCount);
}

export function pruneExpiredCompoundEvents(): void {
  const db = getDb();
  db.prepare(`DELETE FROM niche_events_compound WHERE expires_at < datetime('now')`).run();
}
