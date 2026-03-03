// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Data Poller
// Per-source poll loop with exponential backoff + health tracking.
// Called by the strategy controller on each cycle.
// ═══════════════════════════════════════════════════════════════

import { getDb } from '@/lib/db';
import { v4 as uuid } from 'uuid';
import { createPoller } from './sources/source-factory';
import { recordPollSuccess, recordPollFailure, getSourceState } from './data-source-registry';
import { appendLog } from './db-niche';
import type { DataSourceConfig, RawDataEvent } from './types';

const MAX_BACKOFF_MS = 120000; // 2 minutes

function backoffMs(failures: number): number {
  return Math.min(1000 * Math.pow(2, failures), MAX_BACKOFF_MS);
}

/**
 * Poll a single source. Returns the event or null if skipped/failed.
 */
export async function pollSource(
  source: DataSourceConfig,
  templateVars?: Record<string, string>,
): Promise<RawDataEvent | null> {
  const state = getSourceState(source.id);

  // Exponential backoff: skip if we're in backoff window
  if (state.consecutiveFailures > 0 && state.lastPollAt) {
    const elapsed = Date.now() - new Date(state.lastPollAt).getTime();
    const requiredWait = backoffMs(state.consecutiveFailures);
    if (elapsed < requiredWait) {
      return null; // still in backoff
    }
  }

  try {
    const poller = createPoller(source);
    const event = await poller(source.id, source.strategyId, templateVars);

    // Record success
    recordPollSuccess(source.id, String(event.value).slice(0, 200));

    // Persist raw event
    const db = getDb();
    db.prepare(`
      INSERT INTO niche_events_raw (id, source_id, strategy_id, timestamp, value, numeric_value, direction, raw_payload_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.sourceId, event.strategyId, event.timestamp,
      String(event.value), event.numericValue, event.direction,
      JSON.stringify(event.rawPayload), JSON.stringify(event.metadata),
    );

    return event;
  } catch (err: any) {
    recordPollFailure(source.id, err.message);
    appendLog(source.strategyId, 'warn', 'data-poller',
      `Source "${source.name}" poll failed: ${err.message}`,
      { sourceId: source.id, error: err.message });
    return null;
  }
}

/**
 * Poll all sources for a strategy. Returns collected events.
 */
export async function pollAllSources(
  sources: DataSourceConfig[],
  templateVars?: Record<string, string>,
): Promise<RawDataEvent[]> {
  const results = await Promise.allSettled(
    sources.filter(s => s.enabled).map(s => pollSource(s, templateVars))
  );

  return results
    .filter((r): r is PromiseFulfilledResult<RawDataEvent | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((e): e is RawDataEvent => e !== null);
}
