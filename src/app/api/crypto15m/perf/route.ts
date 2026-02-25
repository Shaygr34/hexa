import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';

interface ShadowEntry {
  id: string;
  status: string;
  ts: string;
  resolvedAt?: string;
  symbol: string;
  side: string;
  p_hat: number | null;
  z: number | null;
  edge: number | null;
  netEdge: number | null;
  buyPrice: number | null;
  fees: number | null;
  slippage: number | null;
  buffer: number | null;
  outcome?: string;
  won?: boolean | null;
  realizedPnl?: number | null;
  costs?: number | null;
}

interface TrimmedEntry {
  id: string;
  ts: string;
  symbol: string;
  side: string;
  p_hat: number | null;
  z: number | null;
  edge: number | null;
  netEdge: number | null;
  buyPrice: number | null;
  realizedPnl: number | null;
  outcome: string;
  won: boolean | null;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const hours = Math.min(Math.max(parseInt(searchParams.get('hours') || '24', 10) || 24, 1), 168);

  const shadowPath = join(process.cwd(), 'crypto15m_shadow.jsonl');
  if (!existsSync(shadowPath)) {
    return NextResponse.json({ hours, proposals: 0, pending: 0, resolved: 0, wins: 0, losses: 0, winRate: null, avgEdge: 0, avgNetEdge: 0, totalPnl: 0, avgPnl: 0, pnlBySymbol: {}, maxDrawdown: 0, topWins: [], topLosses: [] });
  }

  let entries: ShadowEntry[];
  try {
    const content = readFileSync(shadowPath, 'utf-8').trim();
    if (!content) {
      return NextResponse.json({ hours, proposals: 0, pending: 0, resolved: 0, wins: 0, losses: 0, winRate: null, avgEdge: 0, avgNetEdge: 0, totalPnl: 0, avgPnl: 0, pnlBySymbol: {}, maxDrawdown: 0, topWins: [], topLosses: [] });
    }
    entries = content.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean) as ShadowEntry[];
  } catch {
    return NextResponse.json({ error: 'read error', hours, proposals: 0 });
  }

  // Deduplicate by id — keep latest entry per id
  const byId = new Map<string, ShadowEntry>();
  for (const e of entries) {
    if (e.id) byId.set(e.id, e);
  }
  const unique = Array.from(byId.values());

  // Filter to entries within the hours window
  const cutoff = Date.now() - hours * 3600_000;
  const inWindow = unique.filter(e => new Date(e.ts).getTime() >= cutoff);

  // Partition
  const pending = inWindow.filter(e => e.status === 'pending');
  const resolved = inWindow.filter(e =>
    e.status === 'resolved' && e.outcome !== 'UNRESOLVED' && e.outcome !== 'FETCH_ERROR'
  );

  const wins = resolved.filter(e => e.won === true);
  const losses = resolved.filter(e => e.won === false);

  const avgEdge = resolved.length > 0
    ? resolved.reduce((s, e) => s + (e.edge ?? 0), 0) / resolved.length
    : 0;
  const avgNetEdge = resolved.length > 0
    ? resolved.reduce((s, e) => s + (e.netEdge ?? 0), 0) / resolved.length
    : 0;

  // PnL — only from entries that have realizedPnl
  const withPnl = resolved.filter(e => e.realizedPnl != null);
  const totalPnl = withPnl.reduce((s, e) => s + (e.realizedPnl ?? 0), 0);
  const avgPnl = withPnl.length > 0 ? totalPnl / withPnl.length : 0;

  // Per-symbol breakdown
  const pnlBySymbol: Record<string, { resolved: number; wins: number; losses: number; totalPnl: number }> = {};
  for (const e of resolved) {
    if (!pnlBySymbol[e.symbol]) {
      pnlBySymbol[e.symbol] = { resolved: 0, wins: 0, losses: 0, totalPnl: 0 };
    }
    pnlBySymbol[e.symbol].resolved++;
    if (e.won === true) pnlBySymbol[e.symbol].wins++;
    if (e.won === false) pnlBySymbol[e.symbol].losses++;
    if (e.realizedPnl != null) pnlBySymbol[e.symbol].totalPnl += e.realizedPnl;
  }
  // Round totalPnl per symbol
  for (const sym of Object.keys(pnlBySymbol)) {
    pnlBySymbol[sym].totalPnl = parseFloat(pnlBySymbol[sym].totalPnl.toFixed(6));
  }

  // Max drawdown — sort resolved by resolvedAt, walk cumulative PnL
  const sortedResolved = [...withPnl].sort((a, b) =>
    new Date(a.resolvedAt || a.ts).getTime() - new Date(b.resolvedAt || b.ts).getTime()
  );
  let cumPnl = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const e of sortedResolved) {
    cumPnl += e.realizedPnl ?? 0;
    if (cumPnl > peak) peak = cumPnl;
    const drawdown = peak - cumPnl;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Top wins / losses
  const trimEntry = (e: ShadowEntry): TrimmedEntry => ({
    id: e.id,
    ts: e.ts,
    symbol: e.symbol,
    side: e.side,
    p_hat: e.p_hat,
    z: e.z,
    edge: e.edge,
    netEdge: e.netEdge,
    buyPrice: e.buyPrice,
    realizedPnl: e.realizedPnl ?? null,
    outcome: e.outcome ?? '',
    won: e.won ?? null,
  });

  const topWins = [...withPnl]
    .filter(e => (e.realizedPnl ?? 0) > 0)
    .sort((a, b) => (b.realizedPnl ?? 0) - (a.realizedPnl ?? 0))
    .slice(0, 3)
    .map(trimEntry);

  const topLosses = [...withPnl]
    .filter(e => (e.realizedPnl ?? 0) < 0)
    .sort((a, b) => (a.realizedPnl ?? 0) - (b.realizedPnl ?? 0))
    .slice(0, 3)
    .map(trimEntry);

  return NextResponse.json({
    hours,
    proposals: inWindow.length,
    pending: pending.length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    winRate: resolved.length > 0 ? parseFloat((wins.length / resolved.length).toFixed(4)) : null,
    avgEdge: parseFloat(avgEdge.toFixed(6)),
    avgNetEdge: parseFloat(avgNetEdge.toFixed(6)),
    totalPnl: parseFloat(totalPnl.toFixed(6)),
    avgPnl: parseFloat(avgPnl.toFixed(6)),
    pnlBySymbol,
    maxDrawdown: parseFloat(maxDrawdown.toFixed(6)),
    topWins,
    topLosses,
  });
}
