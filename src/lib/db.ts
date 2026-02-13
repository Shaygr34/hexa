// ═══════════════════════════════════════════════════════════════
// ZVI v1 — SQLite Database Layer
// Clean repository boundary. Swap to Postgres/Supabase later.
// ═══════════════════════════════════════════════════════════════

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = process.env.DATABASE_PATH || './data/zvi.db';
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function initDb(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL,
      condition_id TEXT,
      market_name TEXT NOT NULL,
      market_slug TEXT,
      type TEXT NOT NULL CHECK(type IN ('1A_BUY_ALL_YES','1B_BUY_ALL_NO_CONVERT')),
      outcomes_json TEXT NOT NULL,
      outcome_count INTEGER NOT NULL,
      sum_prices REAL NOT NULL,
      gross_edge REAL NOT NULL,
      fee_rate REAL,
      estimated_fees REAL NOT NULL DEFAULT 0,
      estimated_slippage REAL NOT NULL DEFAULT 0,
      estimated_gas_cost REAL NOT NULL DEFAULT 0,
      net_edge REAL NOT NULL,
      min_depth_usdc REAL NOT NULL DEFAULT 0,
      max_notional REAL NOT NULL DEFAULT 0,
      capital_lock_days REAL,
      convert_active INTEGER NOT NULL DEFAULT 0,
      confidence_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'KILL',
      discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approval_status TEXT NOT NULL DEFAULT 'pending',
      approved_by TEXT,
      approved_at TEXT,
      narrative TEXT
    );

    CREATE TABLE IF NOT EXISTS pinned_markets (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL UNIQUE,
      market_name TEXT NOT NULL,
      market_slug TEXT,
      market_price REAL NOT NULL DEFAULT 0,
      zvi_probability REAL,
      confidence_low REAL,
      confidence_high REAL,
      mispricing_gap REAL,
      reasoning_json TEXT,
      sources_json TEXT,
      suggested_action TEXT,
      last_analyzed_at TEXT,
      pinned_at TEXT NOT NULL,
      pinned_by TEXT NOT NULL DEFAULT 'founder'
    );

    CREATE TABLE IF NOT EXISTS price_thresholds (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'USD',
      threshold_price REAL NOT NULL,
      direction TEXT NOT NULL DEFAULT 'cross',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_alerts (
      id TEXT PRIMARY KEY,
      threshold_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      triggered_price REAL NOT NULL,
      threshold_price REAL NOT NULL,
      direction TEXT NOT NULL,
      report_json TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (threshold_id) REFERENCES price_thresholds(id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      inputs_json TEXT NOT NULL,
      computed_metrics_json TEXT NOT NULL,
      llm_narrative TEXT,
      founder_action TEXT,
      result TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_health (
      agent_id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'stopped',
      last_heartbeat TEXT,
      last_error TEXT,
      cycle_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities(status);
    CREATE INDEX IF NOT EXISTS idx_opp_net_edge ON opportunities(net_edge DESC);
    CREATE INDEX IF NOT EXISTS idx_opp_updated ON opportunities(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_time ON signal_alerts(triggered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(timestamp DESC);
  `);

  // Seed default system config
  const upsert = db.prepare(`
    INSERT OR IGNORE INTO system_config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
  `);
  upsert.run('observation_only', 'true');
  upsert.run('manual_approval_required', 'true');
  upsert.run('auto_exec', 'false');
  upsert.run('kill_switch', 'false');
  upsert.run('max_exposure_per_market', '500');
  upsert.run('daily_max_exposure', '2000');
  upsert.run('min_edge_threshold', '0.02');
  upsert.run('min_depth_usdc', '100');
}
