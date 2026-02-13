// ═══════════════════════════════════════════════════════════════
// ZVI v1 — MODULE 3: RP Optical-Style Signal Watcher
// Watches external assets for price threshold crossings.
// Generates RP Optical-style mini-briefs on alert.
// Provider A (v1): manual POST price update endpoint.
// Provider B (v2): real market-data API integration.
// ═══════════════════════════════════════════════════════════════

import { getDb, initDb } from '@/lib/db';
import { generateEquitySignalReport, formatReportText } from '@/reports/optical-style';
import { sendAlert } from '@/adapters/alerts/dispatcher';
import { logAudit } from '@/audit/logger';
import type { PriceThreshold, SignalAlert, OpticalReport } from '@/lib/types';
import { v4 as uuid } from 'uuid';

const AGENT_ID = 'signal-watcher';
const CHECK_INTERVAL_MS = 10_000; // 10 seconds

// ── In-memory price store (updated via manual POST) ──
const latestPrices: Map<string, { price: number; updatedAt: string }> = new Map();

/**
 * Update a price (called from API route / manual endpoint).
 */
export function updatePrice(symbol: string, price: number): void {
  latestPrices.set(symbol.toUpperCase(), {
    price,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Get latest price for a symbol.
 */
export function getPrice(symbol: string): { price: number; updatedAt: string } | null {
  return latestPrices.get(symbol.toUpperCase()) || null;
}

/**
 * Get all active thresholds from DB.
 */
function getActiveThresholds(): PriceThreshold[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM price_thresholds WHERE active = 1').all() as any[];
  return rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    exchange: r.exchange,
    currency: r.currency,
    thresholdPrice: r.threshold_price,
    direction: r.direction,
    active: !!r.active,
    createdAt: r.created_at,
  }));
}

/**
 * Check if threshold should fire given current price and direction.
 */
function shouldTrigger(threshold: PriceThreshold, currentPrice: number): boolean {
  switch (threshold.direction) {
    case 'below':
      return currentPrice <= threshold.thresholdPrice;
    case 'above':
      return currentPrice >= threshold.thresholdPrice;
    case 'cross':
      return Math.abs(currentPrice - threshold.thresholdPrice) / threshold.thresholdPrice < 0.005; // Within 0.5%
    default:
      return false;
  }
}

/**
 * Check if we already fired this alert recently (dedup).
 */
function alreadyFired(thresholdId: string, withinMs: number = 3600_000): boolean {
  const db = getDb();
  const cutoff = new Date(Date.now() - withinMs).toISOString();
  const row = db.prepare(
    'SELECT id FROM signal_alerts WHERE threshold_id = ? AND triggered_at > ?'
  ).get(thresholdId, cutoff);
  return !!row;
}

/**
 * Fire an alert: generate report, persist, send notifications.
 */
async function fireAlert(threshold: PriceThreshold, currentPrice: number): Promise<SignalAlert> {
  // Generate RP Optical-style report
  const report = generateEquitySignalReport(
    threshold.symbol,
    threshold.exchange,
    threshold.currency,
    currentPrice,
    threshold.thresholdPrice,
    threshold.direction,
  );

  const alert: SignalAlert = {
    id: uuid(),
    thresholdId: threshold.id,
    symbol: threshold.symbol,
    triggeredPrice: currentPrice,
    thresholdPrice: threshold.thresholdPrice,
    direction: threshold.direction,
    report,
    triggeredAt: new Date().toISOString(),
    acknowledged: false,
  };

  // Persist
  const db = getDb();
  db.prepare(`
    INSERT INTO signal_alerts (id, threshold_id, symbol, triggered_price, threshold_price, direction, report_json, triggered_at, acknowledged)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    alert.id, alert.thresholdId, alert.symbol, alert.triggeredPrice,
    alert.thresholdPrice, alert.direction, JSON.stringify(alert.report),
    alert.triggeredAt,
  );

  // Format and send alert
  const title = `SIGNAL: ${threshold.symbol} ${threshold.direction} ${threshold.currency}${threshold.thresholdPrice}`;
  const reportText = formatReportText(report, title);

  console.log(reportText);

  // Send via all configured channels
  try {
    await sendAlert(title, reportText);
  } catch (e: any) {
    console.warn(`[Signal] Alert dispatch error: ${e.message}`);
  }

  // Audit
  logAudit({
    module: 'signal_watcher',
    action: 'alert_fired',
    inputs: {
      symbol: threshold.symbol,
      currentPrice,
      thresholdPrice: threshold.thresholdPrice,
      direction: threshold.direction,
    },
    computedMetrics: { alertId: alert.id },
  });

  return alert;
}

/**
 * Run one check cycle.
 */
export async function checkOnce(): Promise<SignalAlert[]> {
  const thresholds = getActiveThresholds();
  const alerts: SignalAlert[] = [];

  for (const threshold of thresholds) {
    const latest = getPrice(threshold.symbol);
    if (!latest) continue;

    if (shouldTrigger(threshold, latest.price) && !alreadyFired(threshold.id)) {
      const alert = await fireAlert(threshold, latest.price);
      alerts.push(alert);
    }
  }

  return alerts;
}

/**
 * Run the agent in continuous mode.
 */
export async function runAgent(): Promise<void> {
  console.log('[Signal] Agent starting...');
  initDb();

  // Update heartbeat
  const db = getDb();

  while (true) {
    try {
      db.prepare(`
        INSERT OR REPLACE INTO agent_health (agent_id, agent_name, status, last_heartbeat, last_error, cycle_count)
        VALUES (?, ?, 'running', ?, NULL, COALESCE((SELECT cycle_count FROM agent_health WHERE agent_id = ?), 0) + 1)
      `).run(AGENT_ID, 'Signal Watcher', new Date().toISOString(), AGENT_ID);

      await checkOnce();
    } catch (e: any) {
      console.error(`[Signal] Check error: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

// Run directly if executed as script
if (require.main === module || process.argv[1]?.includes('signal-watcher')) {
  runAgent().catch(e => {
    console.error('[Signal] Fatal:', e);
    process.exit(1);
  });
}
