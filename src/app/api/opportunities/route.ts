import { NextResponse } from 'next/server';
import { getDb, initDb } from '@/lib/db';
import { generateNegRiskBrief } from '@/reports/optical-style';
import type { NegRiskOpportunity, ConfidenceScore } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    initDb();
    const db = getDb();
    const rows = db.prepare('SELECT * FROM opportunities ORDER BY net_edge DESC').all() as any[];

    const opps = rows.map(r => {
      const opp: any = {
        id: r.id,
        marketId: r.market_id,
        marketName: r.market_name,
        marketSlug: r.market_slug,
        type: r.type,
        outcomeCount: r.outcome_count,
        sumPrices: r.sum_prices,
        grossEdge: r.gross_edge,
        netEdge: r.net_edge,
        estimatedFees: r.estimated_fees,
        estimatedSlippage: r.estimated_slippage,
        estimatedGasCost: r.estimated_gas_cost,
        feeRate: r.fee_rate,
        minDepthUsdc: r.min_depth_usdc,
        maxNotional: r.max_notional,
        capitalLockDays: r.capital_lock_days,
        convertActive: !!r.convert_active,
        confidence: JSON.parse(r.confidence_json),
        status: r.status,
        approvalStatus: r.approval_status,
        discoveredAt: r.discovered_at,
        updatedAt: r.updated_at,
      };

      // Generate RP Optical-style brief
      try {
        opp.brief = generateNegRiskBrief(opp as NegRiskOpportunity);
      } catch (_) {}

      return opp;
    });

    return NextResponse.json(opps);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
