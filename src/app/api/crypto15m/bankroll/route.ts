import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';

const STARTING_CAPITAL = 100;

interface EquityEntry {
  ts: string;
  bankroll: number;
  tradeId: string;
  pnl: number;
}

interface BankrollState {
  bankroll: number;
  totalTrades: number;
  wins: number;
  losses: number;
  peakBankroll: number;
  maxDrawdown: number;
  equity: EquityEntry[];
  lastControllerTickAt?: string | null;
  lastResolveScanAt?: string | null;
  lastResolvedAt?: string | null;
  pendingCount?: number;
  pendingOldestTs?: string | null;
}

interface ShadowEntry {
  id: string;
  status: string;
  won?: boolean | null;
  edge?: number | null;
  netEdge?: number | null;
  symbol?: string;
}

interface WindowAgg {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnl: number;
  roiPct: number;
  maxDrawdown: number;
  avgPnl: number;
  avgEdge: number | null;
  avgNetEdge: number | null;
}

function computeWindowAgg(
  entries: EquityEntry[],
  startBankroll: number,
  shadowById: Map<string, ShadowEntry>,
): WindowAgg {
  if (entries.length === 0) {
    return { trades: 0, wins: 0, losses: 0, winRate: null, pnl: 0, roiPct: 0, maxDrawdown: 0, avgPnl: 0, avgEdge: null, avgNetEdge: null };
  }

  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let peak = startBankroll;
  let maxDD = 0;
  let running = startBankroll;
  let edgeSum = 0;
  let netEdgeSum = 0;
  let edgeCount = 0;

  for (const e of entries) {
    running += e.pnl;
    totalPnl += e.pnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;

    const shadow = shadowById.get(e.tradeId);
    if (shadow) {
      if (shadow.won === true) wins++;
      else if (shadow.won === false) losses++;
      if (shadow.edge != null) { edgeSum += shadow.edge; edgeCount++; }
      if (shadow.netEdge != null) { netEdgeSum += shadow.netEdge; }
    } else {
      // Infer win/loss from pnl sign
      if (e.pnl > 0) wins++;
      else losses++;
    }
  }

  const trades = entries.length;
  return {
    trades,
    wins,
    losses,
    winRate: trades > 0 ? parseFloat((wins / trades).toFixed(4)) : null,
    pnl: parseFloat(totalPnl.toFixed(4)),
    roiPct: startBankroll > 0 ? parseFloat(((totalPnl / startBankroll) * 100).toFixed(2)) : 0,
    maxDrawdown: parseFloat(maxDD.toFixed(4)),
    avgPnl: trades > 0 ? parseFloat((totalPnl / trades).toFixed(6)) : 0,
    avgEdge: edgeCount > 0 ? parseFloat((edgeSum / edgeCount).toFixed(6)) : null,
    avgNetEdge: edgeCount > 0 ? parseFloat((netEdgeSum / edgeCount).toFixed(6)) : null,
  };
}

function loadShadowIndex(): Map<string, ShadowEntry> {
  const shadowPath = join(process.cwd(), 'crypto15m_shadow.jsonl');
  const map = new Map<string, ShadowEntry>();
  if (!existsSync(shadowPath)) return map;
  try {
    const lines = readFileSync(shadowPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.id && e.status === 'resolved') map.set(e.id, e);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return map;
}

export async function GET() {
  const bankrollPath = join(process.cwd(), 'shadow_bankroll.json');

  const emptyWindow: WindowAgg = { trades: 0, wins: 0, losses: 0, winRate: null, pnl: 0, roiPct: 0, maxDrawdown: 0, avgPnl: 0, avgEdge: null, avgNetEdge: null };
  const empty = {
    bankroll: STARTING_CAPITAL,
    startingCapital: STARTING_CAPITAL,
    totalPnl: 0,
    roi: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    peakBankroll: STARTING_CAPITAL,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    equity: [],
    recentTrades: [],
    // Liveness
    lastControllerTickAt: null,
    lastResolveScanAt: null,
    lastResolvedAt: null,
    pendingCount: 0,
    pendingOldestAgeSec: null as number | null,
    // Windows
    windows: { '1h': emptyWindow, '24h': emptyWindow, all: emptyWindow },
  };

  if (!existsSync(bankrollPath)) {
    return NextResponse.json(empty);
  }

  let state: BankrollState;
  try {
    const content = readFileSync(bankrollPath, 'utf-8').trim();
    if (!content) return NextResponse.json(empty);
    state = JSON.parse(content);
  } catch {
    return NextResponse.json(empty);
  }

  const totalPnl = state.bankroll - STARTING_CAPITAL;
  const roi = (totalPnl / STARTING_CAPITAL) * 100;
  const winRate = state.totalTrades > 0
    ? parseFloat((state.wins / state.totalTrades).toFixed(4))
    : null;
  const maxDrawdownPct = state.peakBankroll > 0
    ? parseFloat(((state.maxDrawdown / state.peakBankroll) * 100).toFixed(2))
    : 0;

  // Recent trades: last 20, most recent first
  const equity = state.equity || [];
  const recentTrades = equity
    .slice(-20)
    .reverse()
    .map(e => ({
      ts: e.ts,
      tradeId: e.tradeId,
      pnl: e.pnl,
      bankroll: e.bankroll,
    }));

  // Liveness
  const now = Date.now();
  const pendingOldestAgeSec = state.pendingOldestTs
    ? parseFloat(((now - new Date(state.pendingOldestTs).getTime()) / 1000).toFixed(0))
    : null;

  // Rolling window aggregates
  const shadowById = loadShadowIndex();
  const cutoff1h = now - 3600_000;
  const cutoff24h = now - 86400_000;

  const eq1h = equity.filter(e => new Date(e.ts).getTime() >= cutoff1h);
  const eq24h = equity.filter(e => new Date(e.ts).getTime() >= cutoff24h);

  // For window start bankroll: the bankroll just before the first trade in the window
  // = (first entry's bankroll - first entry's pnl), or STARTING_CAPITAL if empty
  const windowStartBankroll = (entries: EquityEntry[]) => {
    if (entries.length === 0) return state.bankroll;
    return entries[0].bankroll - entries[0].pnl;
  };

  const windows = {
    '1h': computeWindowAgg(eq1h, windowStartBankroll(eq1h), shadowById),
    '24h': computeWindowAgg(eq24h, windowStartBankroll(eq24h), shadowById),
    all: computeWindowAgg(equity, STARTING_CAPITAL, shadowById),
  };

  return NextResponse.json({
    bankroll: state.bankroll,
    startingCapital: STARTING_CAPITAL,
    totalPnl: parseFloat(totalPnl.toFixed(4)),
    roi: parseFloat(roi.toFixed(2)),
    totalTrades: state.totalTrades,
    wins: state.wins,
    losses: state.losses,
    winRate,
    peakBankroll: state.peakBankroll,
    maxDrawdown: parseFloat(state.maxDrawdown.toFixed(4)),
    maxDrawdownPct,
    equity,
    recentTrades,
    // Liveness
    lastControllerTickAt: state.lastControllerTickAt ?? null,
    lastResolveScanAt: state.lastResolveScanAt ?? null,
    lastResolvedAt: state.lastResolvedAt ?? null,
    pendingCount: state.pendingCount ?? 0,
    pendingOldestAgeSec,
    // Windows
    windows,
  });
}
