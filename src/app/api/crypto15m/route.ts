import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

const STATE_PATH = path.join(process.cwd(), 'zvi_state.json');

export async function GET() {
  try {
    let state: any = {};
    try {
      state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    } catch {
      return NextResponse.json({
        universe: [],
        lastRefresh: null,
        pollCadenceMs: 1000,
        anchorCount: 4,
        resolvedCount: 0,
        caps: getCaps(),
        message: 'No state file. Run: node src/adapters/polymarket/crypto15m-adapter.mjs',
      });
    }

    const crypto15m = state.crypto15m || {};
    return NextResponse.json({
      universe: crypto15m.universe || [],
      lastRefresh: crypto15m.lastRefresh || null,
      pollCadenceMs: crypto15m.pollCadenceMs || 1000,
      anchorCount: crypto15m.anchorCount || 0,
      resolvedCount: crypto15m.resolvedCount || 0,
      caps: getCaps(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

function getCaps() {
  return {
    fetchMarkets_standalone: {
      location: 'standalone.mjs:760',
      description: 'targetLimit = max(marketLimit || 200, 500) — up to 500/cycle',
      effectiveCap: 500,
    },
    fetchMarkets_maxBatches: {
      location: 'standalone.mjs:764',
      description: 'maxBatches = 5 (5×100 = 500 hard cap)',
    },
    gammaApi_negrisk: {
      location: 'src/adapters/polymarket/gamma-api.ts:35',
      description: 'offset > 2000 safety break',
      effectiveCap: 2000,
    },
    tierSlice: {
      location: 'standalone.mjs:796',
      description: 'Tier arrays sliced to 200 each (A/B/C)',
      effectiveCap: 600,
    },
  };
}
