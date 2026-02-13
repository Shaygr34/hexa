#!/usr/bin/env tsx
// ═══════════════════════════════════════════════════════════════
// TEST: NegRisk Observatory — synthetic opportunity detection
// Verifies: math engine computes correct edge, ranks, explains.
// ═══════════════════════════════════════════════════════════════

import { computeOpportunity, type MathEngineInput } from '../src/engine/math-engine';
import { generateNegRiskBrief, formatReportText } from '../src/reports/optical-style';

console.log('═══════════════════════════════════════════');
console.log('  TEST: NegRisk Observatory');
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

// ── Test 1: 1A opportunity (Σ(YES) < 1) ──
console.log('\n▸ Test 1: Type 1A — Buy-All-YES (resolution arb)');
{
  const input: MathEngineInput = {
    marketId: 'test-market-1',
    conditionId: 'cond-1',
    marketName: 'Who will win the 2026 Presidential Election?',
    marketSlug: 'who-wins-2026',
    type: '1A_BUY_ALL_YES',
    legs: [
      { tokenId: 't1', outcome: 'Candidate A', price: 0.45, depthUsdc: 500, spread: 0.02, stale: false },
      { tokenId: 't2', outcome: 'Candidate B', price: 0.35, depthUsdc: 300, spread: 0.03, stale: false },
      { tokenId: 't3', outcome: 'Candidate C', price: 0.10, depthUsdc: 200, spread: 0.05, stale: false },
    ],
    feeRate: 0.02,
    convertActive: false,
    minDepthThreshold: 100,
  };

  const opp = computeOpportunity(input);

  assert(Math.abs(opp.sumPrices - 0.9) < 0.001, `Σ(YES) = ${opp.sumPrices} (expected 0.90)`);
  assert(Math.abs(opp.grossEdge - 0.1) < 0.001, `Gross edge = ${(opp.grossEdge * 100).toFixed(2)}% (expected 10%)`);
  assert(opp.netEdge > 0, `Net edge = ${(opp.netEdge * 100).toFixed(2)}% (positive)`);
  assert(opp.status === 'GO', `Status = ${opp.status} (expected GO)`);
  assert(opp.confidence.overall > 0.5, `Confidence = ${(opp.confidence.overall * 100).toFixed(0)}% (> 50%)`);
  assert(opp.confidence.feeRateKnown === true, 'feeRate is known');
  assert(opp.outcomeCount === 3, `Outcome count = ${opp.outcomeCount}`);
  assert(opp.minDepthUsdc === 200, `Min depth = $${opp.minDepthUsdc}`);

  // Generate brief
  const brief = generateNegRiskBrief(opp);
  assert(brief.executiveSummary.includes('ACTIONABLE'), 'Brief says ACTIONABLE');
  assert(brief.whatMakesThisSpecial.length >= 3, `Brief has ${brief.whatMakesThisSpecial.length} special bullets`);
  assert(brief.multiTimeframeActions.length === 3, 'Brief has 3 timeframe actions');
  assert(brief.riskRules.length >= 3, `Brief has ${brief.riskRules.length} risk rules`);

  console.log('\n  Generated Mini-Brief:');
  console.log(formatReportText(brief, 'TEST: 1A Opportunity').split('\n').map(l => '    ' + l).join('\n'));
}

// ── Test 2: 1B opportunity (Σ(YES) > 1) ──
console.log('\n▸ Test 2: Type 1B — Buy-All-NO + Convert (instant extract)');
{
  const input: MathEngineInput = {
    marketId: 'test-market-2',
    conditionId: 'cond-2',
    marketName: 'Which party wins the Senate?',
    marketSlug: 'senate-winner',
    type: '1B_BUY_ALL_NO_CONVERT',
    legs: [
      { tokenId: 't4', outcome: 'Democrats', price: 0.55, depthUsdc: 800, spread: 0.01, stale: false },
      { tokenId: 't5', outcome: 'Republicans', price: 0.52, depthUsdc: 700, spread: 0.02, stale: false },
    ],
    feeRate: 0.015,
    convertActive: true,
    minDepthThreshold: 100,
  };

  const opp = computeOpportunity(input);

  assert(Math.abs(opp.sumPrices - 1.07) < 0.001, `Σ(YES) = ${opp.sumPrices} (expected 1.07)`);
  assert(opp.grossEdge > 0, `Gross edge = ${(opp.grossEdge * 100).toFixed(2)}% (positive — sum > 1)`);
  assert(opp.type === '1B_BUY_ALL_NO_CONVERT', 'Type is 1B');
  assert(opp.convertActive === true, 'Convert is active');
}

// ── Test 3: No opportunity (Σ ≈ 1) ──
console.log('\n▸ Test 3: No opportunity — Σ(YES) ≈ 1.00');
{
  const input: MathEngineInput = {
    marketId: 'test-market-3',
    conditionId: 'cond-3',
    marketName: 'Efficient market (no arb)',
    marketSlug: 'no-arb',
    type: '1A_BUY_ALL_YES',
    legs: [
      { tokenId: 't6', outcome: 'Yes', price: 0.50, depthUsdc: 1000, spread: 0.01, stale: false },
      { tokenId: 't7', outcome: 'No', price: 0.51, depthUsdc: 1000, spread: 0.01, stale: false },
    ],
    feeRate: 0.02,
    convertActive: false,
    minDepthThreshold: 100,
  };

  const opp = computeOpportunity(input);

  assert(opp.grossEdge === 0, `Gross edge = 0 (Σ = ${opp.sumPrices} ≥ 1)`);
  assert(opp.status === 'KILL', `Status = ${opp.status} (expected KILL)`);
}

// ── Test 4: Unknown feeRate impacts confidence ──
console.log('\n▸ Test 4: Unknown feeRate reduces confidence');
{
  const input: MathEngineInput = {
    marketId: 'test-market-4',
    conditionId: 'cond-4',
    marketName: 'Market with unknown feeRate',
    marketSlug: 'unknown-fee',
    type: '1A_BUY_ALL_YES',
    legs: [
      { tokenId: 't8', outcome: 'A', price: 0.30, depthUsdc: 500, spread: 0.02, stale: false },
      { tokenId: 't9', outcome: 'B', price: 0.30, depthUsdc: 500, spread: 0.02, stale: false },
      { tokenId: 't10', outcome: 'C', price: 0.30, depthUsdc: 500, spread: 0.02, stale: false },
    ],
    feeRate: null, // UNKNOWN
    convertActive: false,
    minDepthThreshold: 100,
  };

  const opp = computeOpportunity(input);

  assert(opp.confidence.feeRateKnown === false, 'feeRate marked as unknown');
  assert(opp.confidence.overall < 0.8, `Confidence penalized: ${(opp.confidence.overall * 100).toFixed(0)}%`);
  assert(opp.confidence.factors.some(f => f.includes('feeRate')), 'Factor mentions feeRate');
}

// ── Test 5: Stale orderbook impacts confidence ──
console.log('\n▸ Test 5: Stale orderbook reduces confidence');
{
  const input: MathEngineInput = {
    marketId: 'test-market-5',
    conditionId: 'cond-5',
    marketName: 'Market with stale data',
    marketSlug: 'stale-data',
    type: '1A_BUY_ALL_YES',
    legs: [
      { tokenId: 't11', outcome: 'X', price: 0.40, depthUsdc: 500, spread: 0.02, stale: true },
      { tokenId: 't12', outcome: 'Y', price: 0.40, depthUsdc: 500, spread: 0.02, stale: false },
    ],
    feeRate: 0.02,
    convertActive: false,
    minDepthThreshold: 100,
  };

  const opp = computeOpportunity(input);

  assert(opp.confidence.allLegsLive === false, 'Stale flag detected');
  assert(opp.confidence.overall < 1.0, `Confidence penalized for staleness: ${(opp.confidence.overall * 100).toFixed(0)}%`);
}

// ── Summary ──
console.log('\n═══════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════');

process.exit(failed > 0 ? 1 : 0);
