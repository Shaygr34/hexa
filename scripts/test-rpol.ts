#!/usr/bin/env tsx
// ═══════════════════════════════════════════════════════════════
// TEST: RP Optical Signal Watcher
// Verifies: POST price 33 → triggers alert → renders report.
// ═══════════════════════════════════════════════════════════════

import { initDb, getDb } from '../src/lib/db';
import { updatePrice, checkOnce } from '../src/agents/signal-watcher-agent';
import { formatReportText, generateEquitySignalReport } from '../src/reports/optical-style';
import { v4 as uuid } from 'uuid';

console.log('═══════════════════════════════════════════');
console.log('  TEST: RP Optical Signal Watcher (RPOL)');
console.log('═══════════════════════════════════════════\n');

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  [PASS] ${msg}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${msg}`);
    failed++;
  }
}

async function main() {
  // Init DB
  process.env.DATABASE_PATH = './data/test-rpol.db';
  initDb();
  const db = getDb();

  // ── Test 1: Create threshold ──
  console.log('▸ Test 1: Create RPOL threshold at ₪33');
  {
    const id = uuid();
    db.prepare(`
      INSERT INTO price_thresholds (id, symbol, exchange, currency, threshold_price, direction, active, created_at)
      VALUES (?, 'RPOL', 'TASE', 'ILS', 33, 'below', 1, ?)
    `).run(id, new Date().toISOString());

    const row = db.prepare('SELECT * FROM price_thresholds WHERE symbol = ?').get('RPOL') as any;
    assert(!!row, 'Threshold created in DB');
    assert(row.threshold_price === 33, `Threshold price = ₪${row.threshold_price}`);
    assert(row.direction === 'below', `Direction = ${row.direction}`);
  }

  // ── Test 2: Update price above threshold — no alert ──
  console.log('\n▸ Test 2: Price ₪36 (above threshold) — no alert expected');
  {
    updatePrice('RPOL', 36);
    const alerts = await checkOnce();
    assert(alerts.length === 0, 'No alert triggered (price above threshold)');
  }

  // ── Test 3: Update price below threshold — alert fires ──
  console.log('\n▸ Test 3: Price ₪33 (at threshold) — alert expected');
  {
    updatePrice('RPOL', 33);
    const alerts = await checkOnce();
    assert(alerts.length > 0, `Alert triggered! (${alerts.length} alert(s))`);

    if (alerts.length > 0) {
      const alert = alerts[0];
      assert(alert.symbol === 'RPOL', `Symbol = ${alert.symbol}`);
      assert(alert.triggeredPrice === 33, `Triggered price = ₪${alert.triggeredPrice}`);
      assert(alert.thresholdPrice === 33, `Threshold = ₪${alert.thresholdPrice}`);
      assert(!!alert.report, 'Report is generated');

      // Verify report structure
      const r = alert.report;
      assert(!!r.executiveSummary, 'Has executive summary');
      assert(r.whatMakesThisSpecial.length >= 3, `Has ${r.whatMakesThisSpecial.length} special bullets`);
      assert(r.multiTimeframeActions.length >= 3, `Has ${r.multiTimeframeActions.length} timeframe actions`);
      assert(r.riskRules.length >= 3, `Has ${r.riskRules.length} risk rules`);
      assert(r.assumptions.length >= 3, `Has ${r.assumptions.length} assumptions`);
      assert(r.verdictChangers.length >= 3, `Has ${r.verdictChangers.length} verdict changers`);

      // Check RP Optical style elements
      assert(r.executiveSummary.includes('RPOL'), 'Summary mentions RPOL');
      assert(r.executiveSummary.includes('33'), 'Summary mentions threshold price');
      assert(r.multiTimeframeActions.some((a: any) => ['1m', '3m', '12m'].includes(a.timeframe)),
        'Uses equity timeframes (1m/3m/12m)');

      // Print the formatted report
      console.log('\n  ── Rendered Report ──');
      const formatted = formatReportText(r, 'SIGNAL: RPOL below ₪33');
      console.log(formatted.split('\n').map(l => '    ' + l).join('\n'));
    }
  }

  // ── Test 4: Dedup — same alert doesn't fire twice ──
  console.log('\n▸ Test 4: Dedup — same price again, no duplicate alert');
  {
    updatePrice('RPOL', 32);
    const alerts = await checkOnce();
    assert(alerts.length === 0, 'No duplicate alert (dedup working)');
  }

  // ── Test 5: Report generator standalone ──
  console.log('\n▸ Test 5: Standalone report generation');
  {
    const report = generateEquitySignalReport('RPOL', 'TASE', 'ILS', 33, 33, 'below');
    assert(report.executiveSummary.length > 50, `Summary length = ${report.executiveSummary.length} chars`);
    assert(report.riskRules.some(r => r.type === 'stop_loss'), 'Has stop-loss rule');
    assert(report.riskRules.some(r => r.type === 'invalidation'), 'Has invalidation rule');
  }

  // Clean up test DB
  try {
    const fs = await import('fs');
    fs.unlinkSync('./data/test-rpol.db');
    fs.unlinkSync('./data/test-rpol.db-wal');
    fs.unlinkSync('./data/test-rpol.db-shm');
  } catch (_) {}

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
