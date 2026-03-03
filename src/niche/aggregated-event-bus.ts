// ═══════════════════════════════════════════════════════════════
// Niche Strategy Platform — Aggregated Event Bus
// CORE IP: Cross-source pattern detection.
// Raw events → ring buffer per source → pattern detectors → compound events.
// All detectors are pure functions — no side effects, fully testable.
// ═══════════════════════════════════════════════════════════════

import { getDb } from '@/lib/db';
import { v4 as uuid } from 'uuid';
import { appendLog } from './db-niche';
import type { RawDataEvent, AggregatedEvent, CompoundEventType, EventDirection } from './types';

const RING_BUFFER_CAP = 200;

// ── Ring Buffer (in-memory per strategy) ──

interface SourceBuffer {
  events: RawDataEvent[];
  lastDirection: EventDirection;
  directionStreak: number;
  avgInterval: number; // running average of inter-event intervals
}

const strategyBuffers = new Map<string, Map<string, SourceBuffer>>();

function getBuffer(strategyId: string): Map<string, SourceBuffer> {
  if (!strategyBuffers.has(strategyId)) {
    strategyBuffers.set(strategyId, new Map());
  }
  return strategyBuffers.get(strategyId)!;
}

export function clearBuffers(strategyId: string): void {
  strategyBuffers.delete(strategyId);
}

function pushEvent(buffer: SourceBuffer, event: RawDataEvent): void {
  // Update interval tracking
  if (buffer.events.length > 0) {
    const lastTs = new Date(buffer.events[buffer.events.length - 1].timestamp).getTime();
    const thisTs = new Date(event.timestamp).getTime();
    const interval = thisTs - lastTs;
    buffer.avgInterval = buffer.avgInterval === 0
      ? interval
      : buffer.avgInterval * 0.9 + interval * 0.1; // EMA
  }

  // Direction streak tracking
  if (event.direction === buffer.lastDirection && event.direction !== 'neutral') {
    buffer.directionStreak++;
  } else {
    buffer.directionStreak = event.direction !== 'neutral' ? 1 : 0;
  }
  buffer.lastDirection = event.direction;

  // Ring buffer cap
  buffer.events.push(event);
  if (buffer.events.length > RING_BUFFER_CAP) {
    buffer.events.shift();
  }
}

// ── Pattern Detectors (pure functions) ──

/**
 * Temporal Coincidence: ≥2 sources fire within `windowMs`.
 * Multiple sources producing events close together = something's happening.
 */
export function detectTemporalCoincidence(
  newEvents: RawDataEvent[],
  windowMs: number = 5000,
): AggregatedEvent | null {
  if (newEvents.length < 2) return null;

  // Group by time proximity
  const sorted = [...newEvents].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const first = new Date(sorted[0].timestamp).getTime();
  const last = new Date(sorted[sorted.length - 1].timestamp).getTime();

  if (last - first > windowMs) return null;

  // All within window — temporal coincidence
  const uniqueSources = new Set(sorted.map(e => e.sourceId));
  if (uniqueSources.size < 2) return null;

  const directions = sorted.map(e => e.direction);
  const direction = majorityDirection(directions);
  const strength = uniqueSources.size / Math.max(newEvents.length, 3); // more sources = stronger

  const now = new Date();
  return {
    id: uuid(),
    strategyId: sorted[0].strategyId,
    timestamp: now.toISOString(),
    type: 'temporal_coincidence',
    title: `${uniqueSources.size} sources fired within ${windowMs / 1000}s`,
    constituentEventIds: sorted.map(e => e.id),
    sourceIds: [...uniqueSources],
    direction,
    strength: Math.min(strength, 1),
    details: { windowMs, sourceCount: uniqueSources.size, directions },
    ttlMs: 60000,
    expiresAt: new Date(now.getTime() + 60000).toISOString(),
  };
}

/**
 * Cross-Source Confirmation: multiple sources agree on direction.
 */
export function detectCrossSourceConfirmation(
  newEvents: RawDataEvent[],
  minAgreement: number = 2,
): AggregatedEvent | null {
  const directional = newEvents.filter(e => e.direction !== 'neutral');
  if (directional.length < minAgreement) return null;

  const bullish = directional.filter(e => e.direction === 'bullish');
  const bearish = directional.filter(e => e.direction === 'bearish');

  const dominant = bullish.length >= bearish.length ? bullish : bearish;
  const direction = dominant[0]?.direction || 'neutral';

  if (dominant.length < minAgreement) return null;

  const uniqueSources = new Set(dominant.map(e => e.sourceId));
  if (uniqueSources.size < minAgreement) return null;

  const agreementRatio = dominant.length / directional.length;
  const now = new Date();

  return {
    id: uuid(),
    strategyId: newEvents[0].strategyId,
    timestamp: now.toISOString(),
    type: 'cross_source_confirmation',
    title: `${uniqueSources.size} sources confirm ${direction} signal`,
    constituentEventIds: dominant.map(e => e.id),
    sourceIds: [...uniqueSources],
    direction,
    strength: agreementRatio,
    details: { bullishCount: bullish.length, bearishCount: bearish.length, agreementRatio },
    ttlMs: 90000,
    expiresAt: new Date(now.getTime() + 90000).toISOString(),
  };
}

/**
 * Divergence: sources disagree on direction → potential opportunity.
 */
export function detectDivergence(
  newEvents: RawDataEvent[],
): AggregatedEvent | null {
  const directional = newEvents.filter(e => e.direction !== 'neutral');
  if (directional.length < 2) return null;

  const bullish = directional.filter(e => e.direction === 'bullish');
  const bearish = directional.filter(e => e.direction === 'bearish');

  if (bullish.length === 0 || bearish.length === 0) return null;

  const bullSources = new Set(bullish.map(e => e.sourceId));
  const bearSources = new Set(bearish.map(e => e.sourceId));

  // Need at least different sources disagreeing
  const overlap = [...bullSources].filter(s => bearSources.has(s));
  if (bullSources.size + bearSources.size - overlap.length < 2) return null;

  const imbalance = Math.abs(bullish.length - bearish.length) / directional.length;
  const now = new Date();

  return {
    id: uuid(),
    strategyId: newEvents[0].strategyId,
    timestamp: now.toISOString(),
    type: 'divergence',
    title: `Source divergence: ${bullish.length} bullish vs ${bearish.length} bearish`,
    constituentEventIds: directional.map(e => e.id),
    sourceIds: [...new Set(directional.map(e => e.sourceId))],
    direction: 'neutral', // divergence is directionally ambiguous
    strength: 1 - imbalance, // closer to 50/50 = stronger divergence
    details: { bullishCount: bullish.length, bearishCount: bearish.length, bullSources: [...bullSources], bearSources: [...bearSources] },
    ttlMs: 120000,
    expiresAt: new Date(now.getTime() + 120000).toISOString(),
  };
}

/**
 * Momentum Shift: N consecutive same-direction events from a source.
 */
export function detectMomentumShift(
  buffers: Map<string, SourceBuffer>,
  threshold: number = 3,
): AggregatedEvent | null {
  let strongestSource: string | null = null;
  let strongestStreak = 0;
  let strongestDirection: EventDirection = 'neutral';

  for (const [sourceId, buf] of buffers) {
    if (buf.directionStreak >= threshold && buf.directionStreak > strongestStreak) {
      strongestSource = sourceId;
      strongestStreak = buf.directionStreak;
      strongestDirection = buf.lastDirection;
    }
  }

  if (!strongestSource || strongestDirection === 'neutral') return null;

  const buf = buffers.get(strongestSource)!;
  const recentEvents = buf.events.slice(-strongestStreak);
  const strategyId = recentEvents[0]?.strategyId;
  if (!strategyId) return null;

  const now = new Date();
  return {
    id: uuid(),
    strategyId,
    timestamp: now.toISOString(),
    type: 'momentum_shift',
    title: `${strongestStreak}-tick ${strongestDirection} momentum on source ${strongestSource.slice(0, 8)}`,
    constituentEventIds: recentEvents.map(e => e.id),
    sourceIds: [strongestSource],
    direction: strongestDirection,
    strength: Math.min(strongestStreak / (threshold * 2), 1),
    details: { streak: strongestStreak, threshold },
    ttlMs: 45000,
    expiresAt: new Date(now.getTime() + 45000).toISOString(),
  };
}

/**
 * Anomaly: event rate > 2σ above baseline for a source.
 */
export function detectAnomaly(
  buffers: Map<string, SourceBuffer>,
  recentEvents: RawDataEvent[],
): AggregatedEvent | null {
  for (const event of recentEvents) {
    const buf = buffers.get(event.sourceId);
    if (!buf || buf.events.length < 10) continue;

    // Calculate event rate stats
    const intervals: number[] = [];
    for (let i = 1; i < buf.events.length; i++) {
      const prev = new Date(buf.events[i - 1].timestamp).getTime();
      const curr = new Date(buf.events[i].timestamp).getTime();
      intervals.push(curr - prev);
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / intervals.length;
    const stddev = Math.sqrt(variance);

    // Check if the latest interval is anomalously short (burst of events)
    const latestInterval = intervals[intervals.length - 1];
    if (stddev > 0 && latestInterval < mean - 2 * stddev) {
      const now = new Date();
      return {
        id: uuid(),
        strategyId: event.strategyId,
        timestamp: now.toISOString(),
        type: 'anomaly',
        title: `Anomalous event rate from source ${event.sourceId.slice(0, 8)}`,
        constituentEventIds: [event.id],
        sourceIds: [event.sourceId],
        direction: event.direction,
        strength: Math.min(Math.abs(mean - latestInterval) / (2 * stddev), 1),
        details: { mean, stddev, latestInterval, zScore: (mean - latestInterval) / stddev },
        ttlMs: 30000,
        expiresAt: new Date(now.getTime() + 30000).toISOString(),
      };
    }
  }
  return null;
}

// ── Aggregation Orchestrator ──

/**
 * Main entry: feed new raw events → get compound events.
 * Called by strategy controller each cycle.
 */
export function aggregate(
  strategyId: string,
  newEvents: RawDataEvent[],
  config: { coincidenceWindowMs?: number; momentumThreshold?: number; minAgreement?: number } = {},
): AggregatedEvent[] {
  const buffers = getBuffer(strategyId);

  // Push all new events into ring buffers
  for (const event of newEvents) {
    if (!buffers.has(event.sourceId)) {
      buffers.set(event.sourceId, { events: [], lastDirection: 'neutral', directionStreak: 0, avgInterval: 0 });
    }
    pushEvent(buffers.get(event.sourceId)!, event);
  }

  // Run all pattern detectors
  const compound: AggregatedEvent[] = [];

  const tc = detectTemporalCoincidence(newEvents, config.coincidenceWindowMs || 5000);
  if (tc) compound.push(tc);

  const csc = detectCrossSourceConfirmation(newEvents, config.minAgreement || 2);
  if (csc) compound.push(csc);

  const div = detectDivergence(newEvents);
  if (div) compound.push(div);

  const mom = detectMomentumShift(buffers, config.momentumThreshold || 3);
  if (mom) compound.push(mom);

  const anom = detectAnomaly(buffers, newEvents);
  if (anom) compound.push(anom);

  // If we got events but no compound pattern, emit single_source for each directional event
  if (compound.length === 0) {
    for (const event of newEvents) {
      if (event.direction !== 'neutral') {
        const now = new Date();
        compound.push({
          id: uuid(),
          strategyId,
          timestamp: now.toISOString(),
          type: 'single_source',
          title: `${event.direction} from ${event.sourceId.slice(0, 8)}`,
          constituentEventIds: [event.id],
          sourceIds: [event.sourceId],
          direction: event.direction,
          strength: 0.3, // single source = low strength
          details: { value: event.numericValue },
          ttlMs: 30000,
          expiresAt: new Date(now.getTime() + 30000).toISOString(),
        });
      }
    }
  }

  // Persist compound events to DB
  const db = getDb();
  for (const ce of compound) {
    db.prepare(`
      INSERT INTO niche_events_compound (id, strategy_id, timestamp, type, title, constituent_event_ids_json, source_ids_json, direction, strength, details_json, ttl_ms, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ce.id, ce.strategyId, ce.timestamp, ce.type, ce.title,
      JSON.stringify(ce.constituentEventIds), JSON.stringify(ce.sourceIds),
      ce.direction, ce.strength, JSON.stringify(ce.details), ce.ttlMs, ce.expiresAt);
  }

  if (compound.length > 0) {
    appendLog(strategyId, 'info', 'event-bus',
      `Detected ${compound.length} compound event(s): ${compound.map(c => c.type).join(', ')}`,
      { types: compound.map(c => c.type), directions: compound.map(c => c.direction) });
  }

  return compound;
}

/**
 * Get active (non-expired) compound events for a strategy.
 */
export function getActiveEvents(strategyId: string): AggregatedEvent[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM niche_events_compound
    WHERE strategy_id = ? AND expires_at > datetime('now')
    ORDER BY timestamp DESC
    LIMIT 50
  `).all(strategyId) as any[];

  return rows.map(r => ({
    id: r.id,
    strategyId: r.strategy_id,
    timestamp: r.timestamp,
    type: r.type as CompoundEventType,
    title: r.title,
    constituentEventIds: JSON.parse(r.constituent_event_ids_json),
    sourceIds: JSON.parse(r.source_ids_json),
    direction: r.direction as EventDirection,
    strength: r.strength,
    details: JSON.parse(r.details_json),
    ttlMs: r.ttl_ms,
    expiresAt: r.expires_at,
  }));
}

// ── Helpers ──

function majorityDirection(directions: EventDirection[]): EventDirection {
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const d of directions) counts[d]++;
  if (counts.bullish > counts.bearish && counts.bullish > counts.neutral) return 'bullish';
  if (counts.bearish > counts.bullish && counts.bearish > counts.neutral) return 'bearish';
  return 'neutral';
}
