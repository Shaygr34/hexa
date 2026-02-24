import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const gammaUrl = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
  const clobUrl = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';

  // Gamma: fetch 1 market to verify connectivity
  let gamma: 'PASS' | 'FAIL' = 'FAIL';
  let gammaDetail = '';
  try {
    const r = await fetch(`${gammaUrl}/markets?limit=1&active=true`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) { gamma = 'PASS'; gammaDetail = 'reachable'; }
    else { gammaDetail = `HTTP ${r.status}`; }
  } catch (e: any) { gammaDetail = e.message || 'timeout'; }

  // CLOB: ping the server endpoint
  let clob: 'PASS' | 'FAIL' = 'FAIL';
  let clobDetail = '';
  try {
    const r = await fetch(`${clobUrl}/time`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) { clob = 'PASS'; clobDetail = 'reachable'; }
    else { clobDetail = `HTTP ${r.status}`; }
  } catch (e: any) { clobDetail = e.message || 'timeout'; }

  // LLM keys: presence check only
  const llm = {
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    xai: !!process.env.XAI_API_KEY,
  };

  return NextResponse.json({ gamma, gammaDetail, clob, clobDetail, llm });
}
