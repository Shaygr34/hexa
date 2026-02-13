// ═══════════════════════════════════════════════════════════════
// ZVI v1 — RP Optical-Style Report Generator
// Mimics the RP Optical Enhanced Analysis report structure:
//   - Executive Summary
//   - "What Makes This Special" bullets
//   - Multi-timeframe action table
//   - Risk rules (stop-loss / invalidation)
//   - Assumptions + verdict changers
// ═══════════════════════════════════════════════════════════════

import type {
  OpticalReport,
  TimeframeAction,
  RiskRule,
  NegRiskOpportunity,
  SignalAlert,
} from '@/lib/types';

// ── For NegRisk Opportunities ──

export function generateNegRiskBrief(opp: NegRiskOpportunity): OpticalReport {
  const typeLabel = opp.type === '1A_BUY_ALL_YES'
    ? 'Resolution Arbitrage (Buy-All-YES)'
    : 'Instant Extract (Buy-All-NO + Convert)';

  const edgePct = (opp.netEdge * 100).toFixed(2);
  const grossPct = (opp.grossEdge * 100).toFixed(2);

  return {
    executiveSummary: buildNegRiskSummary(opp, typeLabel, edgePct, grossPct),

    whatMakesThisSpecial: [
      `${typeLabel}: ${opp.outcomeCount} outcomes with Σ(YES) = ${opp.sumPrices.toFixed(4)} → ${grossPct}% gross edge`,
      `Net edge after fees + slippage: ${edgePct}% (${opp.netEdge > 0.03 ? 'STRONG' : opp.netEdge > 0.01 ? 'MODERATE' : 'MARGINAL'})`,
      `Minimum depth across legs: $${opp.minDepthUsdc.toFixed(0)} USDC — max deployable: $${opp.maxNotional.toFixed(0)}`,
      opp.feeRate !== null
        ? `On-chain feeRate confirmed: ${(opp.feeRate * 100).toFixed(2)}%`
        : `⚠ On-chain feeRate UNKNOWN — using 2% estimate. VERIFY BEFORE EXECUTION.`,
      `Data confidence: ${(opp.confidence.overall * 100).toFixed(0)}% — ${opp.confidence.factors.join('; ')}`,
    ],

    multiTimeframeActions: [
      {
        timeframe: '1h',
        action: opp.status === 'GO' ? 'EXECUTE' : opp.status === 'CONDITIONAL' ? 'MONITOR' : 'SKIP',
        probability: opp.status === 'GO' ? 0.85 : opp.status === 'CONDITIONAL' ? 0.5 : 0.1,
        rationale: opp.status === 'GO'
          ? 'Edge is actionable. Fill all legs immediately.'
          : opp.status === 'CONDITIONAL'
          ? 'Edge exists but conditions (depth/feeRate) need confirmation.'
          : 'Edge insufficient or data quality too low.',
      },
      {
        timeframe: '24h',
        action: opp.netEdge > 0.03 ? 'ACCUMULATE' : 'MONITOR',
        probability: 0.6,
        rationale: 'NegRisk arbs can persist for hours. Watch for depth improvement or edge compression.',
      },
      {
        timeframe: '7d',
        action: opp.type === '1A_BUY_ALL_YES' ? 'HOLD_TO_RESOLUTION' : 'EXTRACTED',
        probability: opp.type === '1A_BUY_ALL_YES' ? 0.9 : 0.95,
        rationale: opp.type === '1A_BUY_ALL_YES'
          ? `Capital locked until market resolution. ${opp.capitalLockDays ? `Est. ${opp.capitalLockDays}d` : 'Duration unknown.'}`
          : 'If 1B executed and converted, profit is instant.',
      },
    ],

    riskRules: [
      {
        type: 'invalidation',
        description: 'Edge compression',
        trigger: `Σ(YES) moves to ${opp.type === '1A_BUY_ALL_YES' ? '≥ 0.99' : '≤ 1.01'} — edge evaporates`,
        action: 'Cancel unfilled legs immediately.',
      },
      {
        type: 'max_loss',
        description: 'Partial fill risk',
        trigger: `Filled < ${Math.ceil(opp.outcomeCount * 0.7)} of ${opp.outcomeCount} legs`,
        action: 'Evaluate PnL on partial basket. May need to sell individual legs at loss.',
      },
      {
        type: 'stop_loss',
        description: 'Depth evaporates',
        trigger: `Any leg depth drops below $${Math.max(10, opp.minDepthUsdc * 0.3).toFixed(0)} USDC`,
        action: 'Pause execution. Re-evaluate fill feasibility.',
      },
      {
        type: 'time_stop',
        description: 'Stale opportunity',
        trigger: 'Opportunity age > 2 hours without execution',
        action: 'Re-scan and re-price all legs before proceeding.',
      },
    ],

    assumptions: [
      'Polymarket CLOB orderbooks are accurate and not stale',
      opp.feeRate !== null
        ? `On-chain feeRate of ${(opp.feeRate * 100).toFixed(2)}% is current`
        : 'Assumed feeRate of 2% — must verify on-chain before execution',
      'No sudden market closures or resolution before legs are filled',
      'Gas costs on Polygon remain negligible (<$0.50)',
      'CLOB API rate limits allow rapid leg execution',
    ],

    verdictChangers: [
      'feeRate increases significantly above estimate → edge destroyed',
      `Market resolves unexpectedly during leg filling → ${opp.type === '1A_BUY_ALL_YES' ? 'possible profit on resolved leg, loss on unfilled' : 'convert may fail'}`,
      'Polymarket disables NegRisk convert → 1B strategy invalid',
      'Large player front-runs the basket → prices move before fill',
      'CLOB API downtime → cannot complete leg execution',
    ],
  };
}

function buildNegRiskSummary(
  opp: NegRiskOpportunity,
  typeLabel: string,
  edgePct: string,
  grossPct: string,
): string {
  if (opp.status === 'GO') {
    return `ACTIONABLE: "${opp.marketName}" presents a ${typeLabel} opportunity with ${edgePct}% net edge across ${opp.outcomeCount} outcomes. ` +
      `The market sums to Σ(YES) = ${opp.sumPrices.toFixed(4)}, creating ${grossPct}% gross edge before costs. ` +
      `After estimated fees (${(opp.estimatedFees * 100).toFixed(2)}%), slippage (${(opp.estimatedSlippage * 100).toFixed(2)}%), and gas, ` +
      `net edge of ${edgePct}% is available on up to $${opp.maxNotional.toFixed(0)} notional. ` +
      `Confidence: ${(opp.confidence.overall * 100).toFixed(0)}%. Recommend immediate execution pending founder approval.`;
  }

  if (opp.status === 'CONDITIONAL') {
    return `CONDITIONAL: "${opp.marketName}" shows a ${typeLabel} signal with ${edgePct}% estimated net edge, but conditions need verification. ` +
      `${opp.confidence.factors.join('. ')}. Monitor closely — may become actionable.`;
  }

  return `PASS: "${opp.marketName}" ${typeLabel} — insufficient edge (${edgePct}%) or data quality too low. No action recommended.`;
}

// ── For RP Optical / Equity Signals ──

export function generateEquitySignalReport(
  symbol: string,
  exchange: string,
  currency: string,
  currentPrice: number,
  thresholdPrice: number,
  direction: string,
): OpticalReport {
  const pctFromThreshold = ((currentPrice - thresholdPrice) / thresholdPrice * 100).toFixed(1);
  const isBelow = currentPrice <= thresholdPrice;

  return {
    executiveSummary:
      `${symbol} (${exchange}) has ${direction === 'below' ? 'dropped below' : direction === 'above' ? 'risen above' : 'crossed'} ` +
      `the ${currency}${thresholdPrice.toFixed(2)} threshold, now trading at ${currency}${currentPrice.toFixed(2)} ` +
      `(${pctFromThreshold}% from trigger). ` +
      `This price level was flagged as a key decision point. ` +
      `Based on the RP Optical Enhanced Analysis framework: ` +
      `${isBelow
        ? 'the stock is entering a potential accumulation zone. Mispricing relative to intrinsic value is widening.'
        : 'the stock is confirming upward momentum. Evaluate whether to hold, trim, or add.'
      }`,

    whatMakesThisSpecial: [
      `Price alert triggered: ${currency}${currentPrice.toFixed(2)} ${direction} ${currency}${thresholdPrice.toFixed(2)} threshold`,
      isBelow
        ? `Potential deep-value entry: micro-cap discount + sector tailwinds may create asymmetric upside`
        : `Momentum confirmation: price breaking above key level signals institutional interest`,
      `Defense/tech sector macro backdrop: elevated geopolitical tension drives procurement cycles`,
      `Liquidity event: micro-cap illiquidity means price dislocations can persist for weeks`,
      `Catalyst pipeline: upcoming earnings/contracts could serve as re-rating events`,
    ],

    multiTimeframeActions: [
      {
        timeframe: '1m',
        action: isBelow ? 'ACCUMULATE' : 'HOLD',
        probability: isBelow ? 0.75 : 0.65,
        rationale: isBelow
          ? 'Deep value zone. Begin building position in tranches.'
          : 'Hold existing position. Set trailing stop.',
      },
      {
        timeframe: '3m',
        action: 'HOLD',
        probability: 0.70,
        rationale: 'Allow catalyst pipeline to develop. Defense procurement cycles are multi-quarter.',
      },
      {
        timeframe: '12m',
        action: isBelow ? 'STRONG_ACCUMULATE' : 'HOLD_TRIM_ABOVE_TARGET',
        probability: isBelow ? 0.80 : 0.60,
        rationale: isBelow
          ? 'DCF and comparable analysis suggest 50-100% upside from current levels. M&A floor provides downside protection.'
          : 'If price has appreciated significantly, consider taking partial profits while maintaining core position.',
      },
    ],

    riskRules: [
      {
        type: 'stop_loss',
        description: 'Maximum drawdown protection',
        trigger: `Price drops below ${currency}${(thresholdPrice * 0.85).toFixed(2)} (-15% from threshold)`,
        action: 'Exit 50% of position. Re-evaluate thesis.',
      },
      {
        type: 'invalidation',
        description: 'Thesis invalidation',
        trigger: 'Loss of key defense contract OR management change OR sector de-rating',
        action: 'Exit full position. Thesis no longer intact.',
      },
      {
        type: 'max_loss',
        description: 'Position size limit',
        trigger: 'Position exceeds 5% of portfolio',
        action: 'Do not add. Micro-cap concentration risk.',
      },
      {
        type: 'time_stop',
        description: 'Catalyst deadline',
        trigger: 'No positive catalyst within 6 months of entry',
        action: 'Review position. Consider redeploying capital.',
      },
    ],

    assumptions: [
      'Defense sector demand remains elevated due to geopolitical environment',
      'Company maintains fortress balance sheet (high cash, low debt)',
      'No dilutive capital raises in near term',
      'Micro-cap illiquidity discount persists, creating entry opportunity',
      'M&A interest from strategic acquirers provides valuation floor',
    ],

    verdictChangers: [
      'Peace deal in Middle East → defense demand drops sharply',
      'Company loses major contract → revenue growth thesis invalid',
      'Large insider selling → management confidence signal changes',
      'Sector-wide de-rating → comparable multiples compress',
      'Regulatory change affecting defense exports → growth ceiling lowered',
    ],
  };
}

// ── Format report as text (for alerts / console) ──

export function formatReportText(report: OpticalReport, title: string): string {
  const lines: string[] = [];

  lines.push('═'.repeat(60));
  lines.push(`  ${title}`);
  lines.push('═'.repeat(60));
  lines.push('');

  lines.push('▸ EXECUTIVE SUMMARY');
  lines.push(report.executiveSummary);
  lines.push('');

  lines.push('▸ WHAT MAKES THIS SPECIAL');
  for (const bullet of report.whatMakesThisSpecial) {
    lines.push(`  • ${bullet}`);
  }
  lines.push('');

  lines.push('▸ MULTI-TIMEFRAME ACTIONS');
  lines.push('  ┌─────────┬────────────────┬──────┬──────────────────────────┐');
  lines.push('  │ Window  │ Action         │ Prob │ Rationale                │');
  lines.push('  ├─────────┼────────────────┼──────┼──────────────────────────┤');
  for (const a of report.multiTimeframeActions) {
    const tf = a.timeframe.padEnd(7);
    const act = a.action.padEnd(14);
    const prob = `${(a.probability * 100).toFixed(0)}%`.padEnd(4);
    const rat = a.rationale.substring(0, 50);
    lines.push(`  │ ${tf} │ ${act} │ ${prob} │ ${rat} │`);
  }
  lines.push('  └─────────┴────────────────┴──────┴──────────────────────────┘');
  lines.push('');

  lines.push('▸ RISK RULES');
  for (const r of report.riskRules) {
    lines.push(`  [${r.type.toUpperCase()}] ${r.description}`);
    lines.push(`    Trigger: ${r.trigger}`);
    lines.push(`    Action:  ${r.action}`);
  }
  lines.push('');

  lines.push('▸ ASSUMPTIONS');
  for (const a of report.assumptions) {
    lines.push(`  • ${a}`);
  }
  lines.push('');

  lines.push('▸ WHAT WOULD CHANGE THE VERDICT');
  for (const v of report.verdictChangers) {
    lines.push(`  ⚠ ${v}`);
  }
  lines.push('');
  lines.push('═'.repeat(60));

  return lines.join('\n');
}
