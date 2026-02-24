// ═══════════════════════════════════════════════════════════════
// ZVI v1 — MODULE 1: NegRisk Observatory Agent
// Continuously scans Polymarket for NegRisk opportunities.
// Default: OBSERVATION ONLY. No trading.
// ═══════════════════════════════════════════════════════════════

import { fetchNegRiskMarkets, groupByNegRiskEvent } from '@/adapters/polymarket/gamma-api';
import { fetchOrderbook, bestAsk, bestBid, depthAtPrice, spread } from '@/adapters/polymarket/clob-api';
import { fetchFeeRateCached, isFeeRateError } from '@/adapters/polymarket/fee-rate-fetcher';
import { computeOpportunity, type MathEngineInput } from '@/engine/math-engine';
import { getDb, initDb } from '@/lib/db';
import { logAudit } from '@/audit/logger';
import type { OutcomeLeg, NegRiskOpportunity, GammaMarket } from '@/lib/types';

const SCAN_INTERVAL_MS = 30_000; // 30 seconds
const MIN_DEPTH_THRESHOLD = Number(process.env.MIN_DEPTH_USDC || '100');
const AGENT_ID = 'negrisk-scanner';

/**
 * Build outcome legs from a group of NegRisk markets.
 * Each market in the group represents one outcome.
 */
/**
 * Parse token IDs from a GammaMarket.
 * API returns clobTokenIds as a JSON string: '["yesTokenId", "noTokenId"]'
 */
function getTokenIds(market: GammaMarket): { yesTokenId: string; noTokenId: string } | null {
  if (market.tokens && market.tokens.length >= 2) {
    const yes = market.tokens.find(t => t.outcome === 'Yes') || market.tokens[0];
    const no = market.tokens.find(t => t.outcome === 'No') || market.tokens[1];
    return { yesTokenId: yes.token_id, noTokenId: no.token_id };
  }
  if (market.clobTokenIds) {
    try {
      const ids: string[] = typeof market.clobTokenIds === 'string'
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;
      if (ids.length >= 2) return { yesTokenId: ids[0], noTokenId: ids[1] };
    } catch (_) {}
  }
  return null;
}

async function buildLegs(markets: GammaMarket[], mode: '1A' | '1B'): Promise<OutcomeLeg[]> {
  const legs: OutcomeLeg[] = [];

  for (const market of markets) {
    const tokenIds = getTokenIds(market);
    if (!tokenIds) continue;

    try {
      const book = await fetchOrderbook(tokenIds.yesTokenId);
      const ask = bestAsk(book);
      const bookSpread = spread(book);

      if (mode === '1A') {
        const depth = depthAtPrice(book.asks, 'asks');
        legs.push({
          tokenId: tokenIds.yesTokenId,
          outcome: market.question,
          price: ask?.price ?? 1,
          depthUsdc: depth.depthUsdc,
          spread: bookSpread,
          stale: false,
        });
      } else {
        const noBook = await fetchOrderbook(tokenIds.noTokenId);
        const noDepth = depthAtPrice(noBook.asks, 'asks');

        legs.push({
          tokenId: tokenIds.noTokenId,
          outcome: market.question,
          price: ask?.price ?? 0,
          depthUsdc: noDepth.depthUsdc,
          spread: bookSpread,
          stale: false,
        });
      }

      await sleep(200);
    } catch (e: any) {
      console.warn(`[NegRisk] Failed to fetch orderbook for ${market.question}: ${e.message}`);
      legs.push({
        tokenId: tokenIds.yesTokenId,
        outcome: market.question,
        price: mode === '1A' ? 1 : 0,
        depthUsdc: 0,
        spread: 1,
        stale: true,
      });
    }
  }

  return legs;
}

/**
 * Run one scan cycle.
 */
export async function scanOnce(): Promise<NegRiskOpportunity[]> {
  console.log(`[NegRisk] Starting scan cycle...`);

  // 1. Fetch feeRate
  const feeResult = await fetchFeeRateCached();
  const feeRate = isFeeRateError(feeResult) ? null : feeResult.feeRate;
  if (isFeeRateError(feeResult)) {
    console.warn(`[NegRisk] feeRate fetch failed: ${feeResult.error}`);
  } else {
    console.log(`[NegRisk] feeRate = ${feeRate} (source: ${feeResult.source})`);
  }

  // 2. Fetch all NegRisk markets
  const markets = await fetchNegRiskMarkets();
  console.log(`[NegRisk] Found ${markets.length} NegRisk markets`);

  // 3. Group by NegRisk event
  const groups = groupByNegRiskEvent(markets);
  console.log(`[NegRisk] Grouped into ${groups.size} NegRisk events`);

  const opportunities: NegRiskOpportunity[] = [];

  // 4. For each group, compute opportunities
  for (const [negRiskId, eventMarkets] of groups) {
    if (eventMarkets.length < 2) continue; // Need at least 2 outcomes

    const eventName = eventMarkets[0]?.question?.split('?')[0] || negRiskId;

    try {
      // 4A: Check for 1A opportunity (Σ(YES) < 1)
      const legs1A = await buildLegs(eventMarkets, '1A');
      if (legs1A.length >= 2) {
        const input1A: MathEngineInput = {
          marketId: negRiskId,
          conditionId: eventMarkets[0]?.conditionId || eventMarkets[0]?.condition_id || '',
          marketName: eventName,
          marketSlug: eventMarkets[0]?.slug || '',
          type: '1A_BUY_ALL_YES',
          legs: legs1A,
          feeRate,
          convertActive: false,
          minDepthThreshold: MIN_DEPTH_THRESHOLD,
        };
        const opp1A = computeOpportunity(input1A);
        if (opp1A.grossEdge > 0) {
          opportunities.push(opp1A);
        }
      }

      // 4B: Check for 1B opportunity (Σ(YES) > 1)
      const sumYes = legs1A.reduce((s, l) => s + l.price, 0);
      if (sumYes > 1) {
        const input1B: MathEngineInput = {
          marketId: negRiskId,
          conditionId: eventMarkets[0]?.conditionId || eventMarkets[0]?.condition_id || '',
          marketName: eventName,
          marketSlug: eventMarkets[0]?.slug || '',
          type: '1B_BUY_ALL_NO_CONVERT',
          legs: legs1A, // Use same legs (YES prices), math engine handles the rest
          feeRate,
          convertActive: true, // TODO: check on-chain if convert is active
          minDepthThreshold: MIN_DEPTH_THRESHOLD,
        };
        const opp1B = computeOpportunity(input1B);
        if (opp1B.grossEdge > 0) {
          opportunities.push(opp1B);
        }
      }
    } catch (e: any) {
      console.warn(`[NegRisk] Error processing event ${negRiskId}: ${e.message}`);
    }
  }

  // 5. Rank by net edge descending
  opportunities.sort((a, b) => b.netEdge - a.netEdge);

  // 6. Persist to database
  await persistOpportunities(opportunities);

  // 7. Audit log
  logAudit({
    module: 'negrisk',
    action: 'scan_complete',
    inputs: { marketCount: markets.length, groupCount: groups.size },
    computedMetrics: {
      opportunitiesFound: opportunities.length,
      goCount: opportunities.filter(o => o.status === 'GO').length,
      conditionalCount: opportunities.filter(o => o.status === 'CONDITIONAL').length,
      feeRateKnown: feeRate !== null,
      feeRate,
    },
  });

  console.log(`[NegRisk] Scan complete: ${opportunities.length} opportunities (${opportunities.filter(o => o.status === 'GO').length} GO)`);
  return opportunities;
}

/**
 * Persist opportunities to SQLite.
 */
function persistOpportunities(opps: NegRiskOpportunity[]): void {
  const db = getDb();

  // Clear old opportunities from this scan
  db.prepare('DELETE FROM opportunities WHERE 1=1').run();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO opportunities (
      id, market_id, condition_id, market_name, market_slug, type,
      outcomes_json, outcome_count, sum_prices, gross_edge,
      fee_rate, estimated_fees, estimated_slippage, estimated_gas_cost,
      net_edge, min_depth_usdc, max_notional, capital_lock_days,
      convert_active, confidence_json, status, discovered_at, updated_at,
      approval_status, approved_by, approved_at, narrative
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  const tx = db.transaction(() => {
    for (const opp of opps) {
      insert.run(
        opp.id, opp.marketId, opp.conditionId, opp.marketName, opp.marketSlug, opp.type,
        JSON.stringify(opp.outcomes), opp.outcomeCount, opp.sumPrices, opp.grossEdge,
        opp.feeRate, opp.estimatedFees, opp.estimatedSlippage, opp.estimatedGasCost,
        opp.netEdge, opp.minDepthUsdc, opp.maxNotional, opp.capitalLockDays,
        opp.convertActive ? 1 : 0, JSON.stringify(opp.confidence), opp.status,
        opp.discoveredAt, opp.updatedAt, opp.approvalStatus, opp.approvedBy, opp.approvedAt,
        opp.narrative || null,
      );
    }
  });

  tx();
}

/**
 * Update agent health heartbeat.
 */
function heartbeat(status: 'running' | 'stopped' | 'error', error?: string): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO agent_health (agent_id, agent_name, status, last_heartbeat, last_error, cycle_count)
      VALUES (?, ?, ?, ?, ?, COALESCE((SELECT cycle_count FROM agent_health WHERE agent_id = ?), 0) + 1)
    `).run(AGENT_ID, 'NegRisk Observatory', status, new Date().toISOString(), error || null, AGENT_ID);
  } catch (_) {
    // Don't fail scan because of heartbeat
  }
}

/**
 * Run the agent in continuous mode.
 */
export async function runAgent(): Promise<void> {
  console.log('[NegRisk] Agent starting...');
  initDb();

  while (true) {
    try {
      heartbeat('running');
      await scanOnce();
    } catch (e: any) {
      console.error(`[NegRisk] Scan error: ${e.message}`);
      heartbeat('error', e.message);
    }

    await sleep(SCAN_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run directly if executed as script
if (require.main === module || process.argv[1]?.includes('negrisk-agent')) {
  runAgent().catch(e => {
    console.error('[NegRisk] Fatal:', e);
    process.exit(1);
  });
}
