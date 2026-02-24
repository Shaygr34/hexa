// measure_crypto15m.mjs — Timed crypto15m measurement loop
// Usage: node scripts/measure_crypto15m.mjs --duration 600000 --interval 1000 --format csv

import { resolve } from '../src/adapters/polymarket/crypto15m-adapter.mjs';
import { appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function parseArgs() {
  const args = process.argv.slice(2);
  let duration = 300_000;
  let interval = 60_000;
  let format = 'log';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--duration' && args[i + 1]) { duration = Number(args[i + 1]); i++; }
    else if (args[i] === '--interval' && args[i + 1]) { interval = Number(args[i + 1]); i++; }
    else if (args[i] === '--format' && args[i + 1]) { format = args[i + 1]; i++; }
  }

  return { duration, interval, format };
}

const CSV_PATH = join(process.cwd(), 'crypto15m_measures.csv');
const CSV_HEADER = 'timestamp,cycle,symbol,slug,status,lastUp,lastDn,upBid,upAsk,upMid,dnBid,dnAsk,dnMid,sanitySum,upBids,upAsks,dnBids,dnAsks,volume,liquidity,windowStart,windowEnd\n';

function stateToCsvRows(state, cycle) {
  const ts = new Date().toISOString();
  const rows = [];
  for (const m of (state?.universeActive || [])) {
    rows.push([
      ts, cycle, m.symbol, m.slug, m.status,
      m.lastTradePrice?.up ?? '', m.lastTradePrice?.down ?? '',
      m.up?.bid ?? '', m.up?.ask ?? '', m.up?.mid ?? '',
      m.down?.bid ?? '', m.down?.ask ?? '', m.down?.mid ?? '',
      m.sanitySum ?? '',
      m.up?.bidCount ?? '', m.up?.askCount ?? '',
      m.down?.bidCount ?? '', m.down?.askCount ?? '',
      m.volume ?? '', m.liquidity ?? '',
      m.tradingWindowStart ?? '', m.tradingWindowEnd ?? '',
    ].join(','));
  }
  return rows;
}

async function main() {
  const { duration, interval, format } = parseArgs();
  const isCsv = format === 'csv';

  console.log(`[measure:crypto15m] Starting — duration=${duration}ms, interval=${interval}ms, format=${format}`);

  if (isCsv) {
    writeFileSync(CSV_PATH, CSV_HEADER);
    console.log(`[measure:crypto15m] CSV output → ${CSV_PATH}`);
  }

  const deadline = Date.now() + duration;
  let cycles = 0;

  while (Date.now() < deadline) {
    cycles++;
    const remaining = Math.round((deadline - Date.now()) / 1000);

    if (!isCsv) {
      console.log(`[measure:crypto15m] Cycle ${cycles} (${remaining}s remaining)`);
    }

    try {
      const state = await resolve();

      if (isCsv && state) {
        const rows = stateToCsvRows(state, cycles);
        if (rows.length > 0) {
          appendFileSync(CSV_PATH, rows.join('\n') + '\n');
        }
        const active = state.universeActive || [];
        const summary = active.map(m => {
          const uM = m.up?.mid != null ? m.up.mid.toFixed(3) : '?';
          const dM = m.down?.mid != null ? m.down.mid.toFixed(3) : '?';
          const sum = m.sanitySum != null ? m.sanitySum.toFixed(3) : '?';
          return `${m.symbol}:up=${uM}/dn=${dM} Σ=${sum}`;
        }).join(' | ');
        console.log(`[measure] #${cycles} (${remaining}s) ${summary}`);
      }
    } catch (e) {
      console.error(`[measure:crypto15m] Cycle ${cycles} error:`, e.message);
    }

    const left = deadline - Date.now();
    if (left > interval) {
      await new Promise(r => setTimeout(r, interval));
    } else {
      break;
    }
  }

  console.log(`[measure:crypto15m] Done. ${cycles} cycles completed.`);
  if (isCsv) console.log(`[measure:crypto15m] CSV saved → ${CSV_PATH}`);
  process.exit(0);
}

main().catch(e => {
  console.error('[measure:crypto15m] Fatal:', e.message);
  process.exit(1);
});
