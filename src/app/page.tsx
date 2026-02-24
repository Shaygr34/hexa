'use client';

import { useState, useEffect, useCallback } from 'react';

// ── Types matching backend ──
interface Opportunity {
  id: string;
  marketName: string;
  type: string;
  outcomeCount: number;
  sumPrices: number;
  grossEdge: number;
  netEdge: number;
  estimatedFees: number;
  estimatedSlippage: number;
  feeRate: number | null;
  minDepthUsdc: number;
  maxNotional: number;
  capitalLockDays: number | null;
  convertActive: boolean;
  confidence: { overall: number; factors: string[]; feeRateKnown: boolean; depthComplete: boolean; allLegsLive: boolean; legCount: number };
  status: string;
  approvalStatus: string;
  discoveredAt: string;
  updatedAt: string;
  narrative?: string;
  brief?: any;
}

interface PinnedMarket {
  id: string;
  marketId: string;
  marketName: string;
  marketPrice: number;
  zviProbability: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  mispricingGap: number | null;
  reasoning: string[];
  sources: string[];
  suggestedAction: string | null;
  lastAnalyzedAt: string | null;
}

interface Signal {
  id: string;
  symbol: string;
  triggeredPrice: number;
  thresholdPrice: number;
  direction: string;
  report: any;
  triggeredAt: string;
  acknowledged: boolean;
}

interface AgentHealth {
  agentId: string;
  agentName: string;
  status: string;
  lastHeartbeat: string | null;
  lastError: string | null;
  cycleCount: number;
}

interface SystemConfig {
  observationOnly: boolean;
  manualApprovalRequired: boolean;
  autoExec: boolean;
  killSwitch: boolean;
}

// ── Types for instance info ──
interface InstanceInfo {
  cwd: string;
  gitHash: string;
  port: string;
}

interface ApiStatus {
  gamma: 'PASS' | 'FAIL';
  gammaDetail: string;
  clob: 'PASS' | 'FAIL';
  clobDetail: string;
  llm: { openai: boolean; anthropic: boolean; xai: boolean };
}

// ── Controller types ──
interface ControllerGate {
  name: string;
  pass: boolean;
  value: string | number | null;
  threshold: string;
}

interface ControllerDecision {
  symbol: string;
  slug: string;
  decision: string;
  signal: string;
  reason: string;
  gateBlock: string | null;
  gates: ControllerGate[];
  allGatesPass: boolean;
  timeRemaining: number;
  // Binance-derived
  binancePrice: number | null;
  return_60s: number | null;
  vol_60s: number | null;
  p_hat: number | null;
  z: number | null;
  rawZ: number | null;
  volFloorHit: boolean;
  zClamped: boolean;
  pHatClamped: boolean;
  // Persistence
  persistenceCount: number;
  persistenceNeeded: number;
  persisted: boolean;
  shadowId?: string;
  // Edge breakdown
  edge: number | null;
  fees: number | null;
  slippage: number | null;
  buffer: number | null;
  netEdge: number | null;
  // Book state
  upMid: number | null;
  dnMid: number | null;
  buySide: string | null;
  buyPrice: number | null;
  window: { start: string | null; end: string | null };
  bookSnapshot: { up: any; down: any; sanitySum: number | null };
}

interface ShadowStats {
  totalProposals: number;
  pendingCount: number;
  resolvedCount: number;
  wins: number;
  losses: number;
  winRate: number;
  avgEdge: number;
  avgNetEdge: number;
  avgPHat: number;
  volFloorFiltered: number;
  zClampFiltered: number;
}

interface ControllerState {
  lastCycle: number | null;
  lastTs: string | null;
  activeWindow: string | null;
  binanceFeed: boolean;
  shadowMode: boolean;
  shadowStats: ShadowStats | null;
  decisions: ControllerDecision[];
  proposals: ControllerDecision[];
  candidates: ControllerDecision[];
  proposalCount: number;
  candidateCount: number;
  doNothingCount: number;
  tickBufferSymbols: string[];
  tickBufferCounts: Record<string, number>;
  config: {
    feeRate: number;
    feeExponent: number;
    notional: number;
    sigmoidK: number;
    volFloor: number;
    zClamp: number;
    pHatRange: [number, number];
    proposalThreshold: number;
    edgeBuffer: number;
    persistenceN: number;
    gates: {
      sanityTol: number;
      maxSpread: number;
      minDepth: number;
      minTimeRemaining: number;
      minNetEdge: number;
    };
  } | null;
}

// ── Dashboard ──
export default function Dashboard() {
  const [tab, setTab] = useState<'opportunities' | 'pinned' | 'signals' | 'control' | 'crypto15m'>('crypto15m');
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [pinnedMarkets, setPinnedMarkets] = useState<PinnedMarket[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [agents, setAgents] = useState<AgentHealth[]>([]);
  const [config, setConfig] = useState<SystemConfig>({ observationOnly: true, manualApprovalRequired: true, autoExec: false, killSwitch: false });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [apiStatus, setApiStatus] = useState<ApiStatus | null>(null);
  const [universe, setUniverse] = useState<{ activeCount: number; closedCount: number; activeWindow: string | null; symbols: string[] } | null>(null);
  const [controller, setController] = useState<ControllerState | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [oppRes, pinnedRes, sigRes, healthRes, cfgRes, instRes] = await Promise.all([
        fetch('/api/opportunities').then(r => r.json()).catch(() => []),
        fetch('/api/pinned-markets').then(r => r.json()).catch(() => []),
        fetch('/api/signals').then(r => r.json()).catch(() => []),
        fetch('/api/health').then(r => r.json()).catch(() => []),
        fetch('/api/control').then(r => r.json()).catch(() => ({})),
        fetch('/api/instance').then(r => r.json()).catch(() => null),
      ]);
      setOpportunities(oppRes);
      setPinnedMarkets(pinnedRes);
      setSignals(sigRes);
      setAgents(healthRes);
      if (cfgRes.observationOnly !== undefined) setConfig(cfgRes);
      if (instRes) setInstance(instRes);
    } catch (_) {}
    setLoading(false);
  }, []);

  // Fetch API status + universe once on mount (not on every 5s poll — they hit external APIs / disk)
  useEffect(() => {
    fetch('/api/status').then(r => r.json()).then(setApiStatus).catch(() => {});
    fetch('/api/universe').then(r => r.json()).then(setUniverse).catch(() => {});
  }, []);

  // Poll controller state on 5s interval (reads local JSON, cheap)
  useEffect(() => {
    const fetchController = () => fetch('/api/crypto15m').then(r => r.json()).then(setController).catch(() => {});
    fetchController();
    const i = setInterval(fetchController, 5000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => { fetchData(); const i = setInterval(fetchData, 5000); return () => clearInterval(i); }, [fetchData]);

  const handleApprove = async (id: string) => {
    await fetch('/api/approve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, action: 'approve' }) });
    fetchData();
  };

  const handleSimulate = async (id: string) => {
    await fetch('/api/approve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, action: 'simulate' }) });
    fetchData();
  };

  const handleToggle = async (key: string, value: boolean) => {
    await fetch('/api/control', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ [key]: value }) });
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleKillSwitch = async () => {
    const confirmed = window.confirm('KILL SWITCH: This will halt all execution immediately. Continue?');
    if (confirmed) {
      await handleToggle('killSwitch', true);
      await handleToggle('autoExec', false);
    }
  };

  const goCount = opportunities.filter(o => o.status === 'GO').length;
  const condCount = opportunities.filter(o => o.status === 'CONDITIONAL').length;

  return (
    <div className="container">
      {/* ── Instance Banner ── */}
      {instance && (
        <div style={{
          background: 'var(--accent)',
          color: '#fff',
          padding: '6px 16px',
          fontSize: 12,
          fontFamily: 'monospace',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderRadius: '6px 6px 0 0',
          marginBottom: 0,
          letterSpacing: '0.02em',
        }}>
          <span style={{ opacity: 0.85 }}>{instance.cwd}</span>
          <span>
            <span style={{ opacity: 0.6, marginRight: 12 }}>git:{instance.gitHash}</span>
            <span style={{ background: 'rgba(255,255,255,0.2)', padding: '2px 8px', borderRadius: 3, fontWeight: 600 }}>
              :{instance.port}
            </span>
          </span>
        </div>
      )}

      <header className="header" style={instance ? { borderRadius: 0 } : undefined}>
        <div>
          <h1>ZVI v2</h1>
          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>POLYMARKET FUND OS</span>
        </div>
        <div className="status">
          <span className={`badge ${config.observationOnly ? 'badge-conditional' : 'badge-go'}`}>
            {config.observationOnly ? 'OBSERVE' : 'LIVE'}
          </span>
          <span className={`badge ${config.killSwitch ? 'badge-kill' : 'badge-running'}`}>
            {config.killSwitch ? 'KILLED' : 'ACTIVE'}
          </span>
          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            {goCount} GO / {condCount} COND / {opportunities.length} total
          </span>
        </div>
      </header>

      {/* ── Quickstart Box ── */}
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '16px 20px',
        marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Quickstart</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textAlign: 'right' }}>
            <div>
              crypto15m.universe: <span style={{ color: (universe?.activeCount ?? 0) > 0 ? 'var(--green)' : 'var(--yellow)', fontWeight: 600 }}>
                {universe ? `${universe.activeCount} active` : '...'}
              </span>
              {universe && universe.symbols.length > 0 && (
                <span style={{ marginLeft: 6, color: 'var(--text-dim)' }}>
                  [{universe.symbols.join('/')}]
                </span>
              )}
            </div>
            {universe?.activeWindow && universe.activeWindow !== 'none' && (
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                window: {universe.activeWindow}
              </div>
            )}
          </div>
        </div>

        {/* Core API Status */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12, fontSize: 12 }}>
          <StatusPill label="Gamma" status={apiStatus?.gamma ?? null} detail={apiStatus?.gammaDetail} />
          <StatusPill label="CLOB" status={apiStatus?.clob ?? null} detail={apiStatus?.clobDetail} />
          <StatusPill label="OpenAI" status={apiStatus ? (apiStatus.llm.openai ? 'PASS' : 'FAIL') : null} detail={apiStatus?.llm.openai ? 'key set' : 'missing'} />
          <StatusPill label="Anthropic" status={apiStatus ? (apiStatus.llm.anthropic ? 'PASS' : 'FAIL') : null} detail={apiStatus?.llm.anthropic ? 'key set' : 'missing'} />
          <StatusPill label="xAI" status={apiStatus ? (apiStatus.llm.xai ? 'PASS' : 'FAIL') : null} detail={apiStatus?.llm.xai ? 'key set' : 'missing'} />
        </div>

        {/* Command chips */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <CmdChip cmd="npm run crypto15m:resolve" />
          <CmdChip cmd="npm run crypto15m:controller -- --once" />
          <CmdChip cmd="npm run measure:crypto15m -- --duration 600000 --interval 1000" />
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 8 }}>
          These buttons copy commands — run them in your terminal.
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'crypto15m' ? 'active' : ''}`} onClick={() => setTab('crypto15m')}>
          Crypto15m {controller?.proposalCount ? `(${controller.proposalCount})` : ''}
        </button>
        <button className={`tab ${tab === 'opportunities' ? 'active' : ''}`} onClick={() => setTab('opportunities')}>
          Opportunities ({opportunities.length})
        </button>
        <button className={`tab ${tab === 'pinned' ? 'active' : ''}`} onClick={() => setTab('pinned')}>
          Pinned Markets ({pinnedMarkets.length})
        </button>
        <button className={`tab ${tab === 'signals' ? 'active' : ''}`} onClick={() => setTab('signals')}>
          Signals ({signals.length})
        </button>
        <button className={`tab ${tab === 'control' ? 'active' : ''}`} onClick={() => setTab('control')}>
          Control Panel
        </button>
      </div>

      <div className="scroll-y">
        {tab === 'crypto15m' && <Crypto15mTab controller={controller} />}
        {tab === 'opportunities' && <OpportunitiesTab opps={opportunities} expandedId={expandedId} setExpandedId={setExpandedId} onApprove={handleApprove} onSimulate={handleSimulate} />}
        {tab === 'pinned' && <PinnedMarketsTab markets={pinnedMarkets} onRefresh={fetchData} />}
        {tab === 'signals' && <SignalsTab signals={signals} onRefresh={fetchData} />}
        {tab === 'control' && <ControlPanel config={config} agents={agents} onToggle={handleToggle} />}
      </div>

      {!config.killSwitch && (
        <button className="kill-switch" onClick={handleKillSwitch}>KILL SWITCH</button>
      )}
      {config.killSwitch && (
        <button className="kill-switch active" onClick={() => handleToggle('killSwitch', false)}>RESUME SYSTEM</button>
      )}
    </div>
  );
}

// ══════════════════════════════════════════
// TAB 0: Crypto15m Controller
// ══════════════════════════════════════════
function Crypto15mTab({ controller }: { controller: ControllerState | null }) {
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  if (!controller || controller.lastCycle === null) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 16, marginBottom: 8 }}>Controller not running</div>
        <div style={{ color: 'var(--text-dim)' }}>Start with: <code>npm run crypto15m:controller -- --once</code></div>
        <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 4 }}>
          Or loop: <code>npm run crypto15m:controller -- --interval 60000 --duration 3600000</code>
        </div>
      </div>
    );
  }

  const decisionColor = (d: string) => {
    if (d === 'PROPOSE_UP') return 'var(--green)';
    if (d === 'PROPOSE_DN') return 'var(--red)';
    if (d === 'CANDIDATE_UP') return '#4ade80';  // lighter green
    if (d === 'CANDIDATE_DN') return '#f87171';  // lighter red
    if (d === 'EXIT') return 'var(--yellow)';
    return 'var(--text-dim)';
  };

  const pct = (v: number | null) => v != null ? `${(v * 100).toFixed(2)}%` : '--';
  const pct3 = (v: number | null) => v != null ? `${(v * 100).toFixed(3)}%` : '--';
  const num4 = (v: number | null) => v != null ? v.toFixed(4) : '--';
  const num8 = (v: number | null) => v != null ? v.toFixed(8) : '--';

  return (
    <div>
      {/* Controller Status Box */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div className="card-title">Crypto15m Controller</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>
              p_hat = sigmoid({controller.config?.sigmoidK} * ret60 / (vol60 + eps)) | volFloor={controller.config?.volFloor} | z-clamp=&plusmn;{controller.config?.zClamp} | persist={controller.config?.persistenceN}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, color: 'var(--text)' }}>
              Cycle #{controller.lastCycle}
              <span style={{
                marginLeft: 8,
                color: controller.binanceFeed ? 'var(--green)' : 'var(--red)',
                fontSize: 11,
                fontWeight: 600,
              }}>
                {controller.binanceFeed ? 'BN:OK' : 'BN:DOWN'}
              </span>
              {controller.shadowMode && (
                <span style={{ marginLeft: 8, color: 'var(--yellow)', fontSize: 10, fontWeight: 600 }}>
                  SHADOW
                </span>
              )}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
              {controller.lastTs ? new Date(controller.lastTs).toLocaleTimeString() : '--'}
            </div>
          </div>
        </div>

        <div className="metrics">
          <div className="metric">
            <div className="metric-label">Proposals</div>
            <div className={`metric-value ${controller.proposalCount > 0 ? 'positive' : ''}`}>
              {controller.proposalCount}
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">Candidates</div>
            <div className={`metric-value ${(controller.candidateCount ?? 0) > 0 ? 'warn' : ''}`}>
              {controller.candidateCount ?? 0}
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">DO_NOTHING</div>
            <div className="metric-value">{controller.doNothingCount}</div>
          </div>
          <div className="metric">
            <div className="metric-label">Active Window</div>
            <div className="metric-value" style={{ fontSize: 11 }}>
              {controller.activeWindow && controller.activeWindow !== 'none'
                ? controller.activeWindow.split(' → ').pop()?.replace(' UTC', '')
                : 'none'}
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">Tick Buffer</div>
            <div className="metric-value" style={{ fontSize: 11 }}>
              {controller.tickBufferSymbols?.join('/') || 'empty'}
            </div>
          </div>
        </div>

        {/* Config tags */}
        {controller.config && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {Object.entries(controller.config.gates).map(([k, v]) => (
              <span key={k} style={{
                padding: '2px 8px', background: 'var(--bg)', borderRadius: 3,
                fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border)',
              }}>
                {k}: {v}
              </span>
            ))}
            <span style={{ padding: '2px 8px', background: 'var(--bg)', borderRadius: 3, fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border)' }}>
              threshold: {controller.config.proposalThreshold}
            </span>
            <span style={{ padding: '2px 8px', background: 'var(--bg)', borderRadius: 3, fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border)' }}>
              buffer: {controller.config.edgeBuffer}
            </span>
            <span style={{ padding: '2px 8px', background: 'var(--bg)', borderRadius: 3, fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border)' }}>
              volFloor: {controller.config.volFloor}
            </span>
            <span style={{ padding: '2px 8px', background: 'var(--bg)', borderRadius: 3, fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border)' }}>
              zClamp: &plusmn;{controller.config.zClamp}
            </span>
            <span style={{ padding: '2px 8px', background: 'var(--bg)', borderRadius: 3, fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border)' }}>
              persist: {controller.config.persistenceN}
            </span>
          </div>
        )}
      </div>

      {/* Decisions Table */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 10 }}>Decisions</div>
        <table className="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Decision</th>
              <th>Binance</th>
              <th>p_hat</th>
              <th>z</th>
              <th>upMid</th>
              <th>Edge</th>
              <th>Net Edge</th>
              <th>Persist</th>
              <th>Flags</th>
              <th>Gates</th>
              <th>Time</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {controller.decisions.map(d => (
              <tr key={d.symbol} style={{ cursor: 'pointer' }} onClick={() => setExpandedSymbol(expandedSymbol === d.symbol ? null : d.symbol)}>
                <td style={{ fontWeight: 600 }}>{d.symbol}</td>
                <td>
                  <span style={{ color: decisionColor(d.decision), fontWeight: 600, fontSize: 12 }}>
                    {d.decision}
                  </span>
                </td>
                <td style={{ fontSize: 11 }}>
                  {d.binancePrice != null ? `$${d.binancePrice.toLocaleString()}` : <span style={{ color: 'var(--red)' }}>N/A</span>}
                </td>
                <td style={{ fontWeight: 600, fontSize: 12 }}>{num4(d.p_hat)}</td>
                <td style={{ fontSize: 11, color: 'var(--text-dim)' }}>{d.z != null ? d.z.toFixed(2) : '--'}</td>
                <td style={{ fontSize: 12 }}>{num4(d.upMid)}</td>
                <td>{pct(d.edge)}</td>
                <td style={{ color: (d.netEdge ?? 0) >= 0.03 ? 'var(--green)' : 'var(--text-dim)', fontWeight: 600 }}>
                  {pct(d.netEdge)}
                </td>
                <td style={{ fontSize: 10 }}>
                  <span style={{ color: d.persisted ? 'var(--green)' : 'var(--text-dim)' }}>
                    {d.persistenceCount}/{d.persistenceNeeded}
                  </span>
                </td>
                <td style={{ fontSize: 9 }}>
                  {d.volFloorHit && <span style={{ color: 'var(--yellow)', marginRight: 2 }} title="vol below floor">VF</span>}
                  {d.zClamped && <span style={{ color: 'var(--yellow)', marginRight: 2 }} title="z-score clamped">ZC</span>}
                  {d.pHatClamped && <span style={{ color: 'var(--yellow)' }} title="p_hat clamped">PC</span>}
                  {!d.volFloorHit && !d.zClamped && !d.pHatClamped && <span style={{ color: 'var(--text-dim)' }}>--</span>}
                </td>
                <td>
                  <span style={{ color: d.allGatesPass ? 'var(--green)' : 'var(--red)', fontSize: 11 }}>
                    {d.allGatesPass ? 'PASS' : 'FAIL'}
                  </span>
                </td>
                <td style={{ fontSize: 11, color: d.timeRemaining < 240 ? 'var(--red)' : 'var(--text-dim)' }}>
                  {d.timeRemaining}s
                </td>
                <td style={{ color: 'var(--text-dim)', fontSize: 10 }}>
                  {expandedSymbol === d.symbol ? '[-]' : '[+]'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Explain Panel */}
      {expandedSymbol && (() => {
        const d = controller.decisions.find(x => x.symbol === expandedSymbol);
        if (!d) return null;
        return (
          <div className="card" style={{ borderLeft: `3px solid ${decisionColor(d.decision)}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
              <div className="card-title">{d.symbol} — Explain</div>
              <span style={{ color: decisionColor(d.decision), fontWeight: 700 }}>{d.decision}</span>
            </div>

            {/* Reason */}
            <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 12, padding: '8px 12px', background: 'var(--bg)', borderRadius: 4 }}>
              {d.reason}
            </div>

            {/* Binance + Signal */}
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Binance Signal</div>
            <div className="metrics" style={{ marginBottom: 12 }}>
              <div className="metric">
                <div className="metric-label">Binance Price</div>
                <div className="metric-value">{d.binancePrice != null ? `$${d.binancePrice.toLocaleString()}` : '--'}</div>
              </div>
              <div className="metric">
                <div className="metric-label">return_60s</div>
                <div className="metric-value" style={{ color: (d.return_60s ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {d.return_60s != null ? `${(d.return_60s * 100).toFixed(4)}%` : '--'}
                </div>
              </div>
              <div className="metric">
                <div className="metric-label">vol_60s</div>
                <div className="metric-value">{num8(d.vol_60s)}</div>
              </div>
              <div className="metric">
                <div className="metric-label">z-score</div>
                <div className="metric-value">
                  {d.z != null ? d.z.toFixed(4) : '--'}
                  {d.zClamped && <span style={{ color: 'var(--yellow)', fontSize: 9, marginLeft: 4 }}>CLAMPED</span>}
                </div>
              </div>
              <div className="metric">
                <div className="metric-label">rawZ</div>
                <div className="metric-value" style={{ fontSize: 11 }}>{d.rawZ != null ? d.rawZ.toFixed(4) : '--'}</div>
              </div>
              <div className="metric">
                <div className="metric-label">p_hat</div>
                <div className="metric-value" style={{ fontWeight: 700, fontSize: 16 }}>
                  {num4(d.p_hat)}
                  {d.pHatClamped && <span style={{ color: 'var(--yellow)', fontSize: 9, marginLeft: 4 }}>CLAMPED</span>}
                </div>
              </div>
            </div>

            {/* Clamp flags */}
            {(d.volFloorHit || d.zClamped || d.pHatClamped) && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                {d.volFloorHit && (
                  <span style={{ padding: '3px 8px', background: 'rgba(234,179,8,0.15)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 4, fontSize: 10, color: 'var(--yellow)' }}>
                    VOL_FLOOR: vol_60s={num8(d.vol_60s)} &lt; 0.0002 → NO_SIGNAL
                  </span>
                )}
                {d.zClamped && (
                  <span style={{ padding: '3px 8px', background: 'rgba(234,179,8,0.15)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 4, fontSize: 10, color: 'var(--yellow)' }}>
                    Z_CLAMPED: rawZ={d.rawZ?.toFixed(2)} → z={d.z?.toFixed(2)}
                  </span>
                )}
                {d.pHatClamped && (
                  <span style={{ padding: '3px 8px', background: 'rgba(234,179,8,0.15)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 4, fontSize: 10, color: 'var(--yellow)' }}>
                    P_HAT_CLAMPED: clamped to [0.01, 0.99]
                  </span>
                )}
              </div>
            )}

            {/* Persistence */}
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Persistence Gate</div>
            <div style={{ padding: '8px 12px', background: 'var(--bg)', borderRadius: 4, fontSize: 12, fontFamily: 'monospace', marginBottom: 12 }}>
              <div>consecutive same-side: {d.persistenceCount}/{d.persistenceNeeded}</div>
              <div>persisted: <span style={{ color: d.persisted ? 'var(--green)' : 'var(--text-dim)', fontWeight: 600 }}>{d.persisted ? 'YES' : 'NO'}</span></div>
              <div style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 4 }}>
                Signal must fire {d.persistenceNeeded} consecutive ticks on the same side before promoting CANDIDATE → PROPOSE
              </div>
            </div>

            {/* Edge math breakdown */}
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Edge Breakdown</div>
            <div style={{ padding: '8px 12px', background: 'var(--bg)', borderRadius: 4, fontSize: 12, fontFamily: 'monospace', marginBottom: 12 }}>
              <div>edge    = |p_hat - upMid| = |{num4(d.p_hat)} - {num4(d.upMid)}| = {pct(d.edge)}</div>
              <div>fees    = takerFee({num4(d.buyPrice)}) = {pct3(d.fees)}</div>
              <div>slippage = {pct(d.slippage)}</div>
              <div>buffer  = {pct(d.buffer)}</div>
              <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4, fontWeight: 700,
                color: (d.netEdge ?? 0) >= 0.03 ? 'var(--green)' : 'var(--text-dim)' }}>
                netEdge = {pct(d.edge)} - {pct3(d.fees)} - {pct(d.slippage)} - {pct(d.buffer)} = {pct(d.netEdge)}
              </div>
            </div>

            {/* Book state */}
            <div className="metrics" style={{ marginBottom: 12 }}>
              <div className="metric">
                <div className="metric-label">Up Mid</div>
                <div className="metric-value">{num4(d.upMid)}</div>
              </div>
              <div className="metric">
                <div className="metric-label">Dn Mid</div>
                <div className="metric-value">{num4(d.dnMid)}</div>
              </div>
              <div className="metric">
                <div className="metric-label">Buy Side</div>
                <div className="metric-value">{d.buySide ?? '--'}</div>
              </div>
              <div className="metric">
                <div className="metric-label">Buy Price</div>
                <div className="metric-value">{num4(d.buyPrice)}</div>
              </div>
              <div className="metric">
                <div className="metric-label">Sanity Sum</div>
                <div className={`metric-value ${Math.abs((d.bookSnapshot.sanitySum ?? 0) - 1) <= 0.05 ? '' : 'negative'}`}>
                  {d.bookSnapshot.sanitySum?.toFixed(4) ?? '--'}
                </div>
              </div>
            </div>

            {/* Gate details */}
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Gates</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {d.gates.map(g => (
                <span key={g.name} style={{
                  padding: '4px 10px',
                  background: g.pass ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                  border: `1px solid ${g.pass ? 'var(--green)' : 'var(--red)'}33`,
                  borderRadius: 4,
                  fontSize: 11,
                  color: g.pass ? 'var(--green)' : 'var(--red)',
                }}>
                  {g.name}: {String(g.value)} {g.pass ? 'OK' : `(need ${g.threshold})`}
                </span>
              ))}
            </div>

            {/* Book snapshot */}
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Book Snapshot</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {['up', 'down'].map(side => {
                const book = (d.bookSnapshot as any)[side];
                if (!book) return <div key={side} style={{ color: 'var(--text-dim)', fontSize: 11 }}>{side}: no data</div>;
                return (
                  <div key={side} style={{ padding: '6px 10px', background: 'var(--bg)', borderRadius: 4, fontSize: 11 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}>{side}</div>
                    <div>bid={book.bid} ask={book.ask} mid={book.mid?.toFixed(4)}</div>
                    <div>depth: {book.bidSize?.toFixed(1)} bid / {book.askSize?.toFixed(1)} ask</div>
                    <div>levels: {book.bidCount}b / {book.askCount}a</div>
                  </div>
                );
              })}
            </div>

            {/* Window */}
            <div style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 8 }}>
              Window: {d.window.start ? new Date(d.window.start).toLocaleTimeString() : '?'} → {d.window.end ? new Date(d.window.end).toLocaleTimeString() : '?'}
              {' | '}{d.slug}
            </div>
          </div>
        );
      })()}

      {/* Active Candidates (not yet persisted) */}
      {(controller.candidates?.length ?? 0) > 0 && (
        <div className="card" style={{ borderLeft: '3px solid var(--yellow)' }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Candidates (not yet persisted)</div>
          {controller.candidates.map(c => (
            <div key={c.symbol} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 0', borderBottom: '1px solid var(--border)',
            }}>
              <div>
                <span style={{ fontWeight: 600, marginRight: 8 }}>{c.symbol}</span>
                <span style={{ color: decisionColor(c.decision), fontWeight: 600 }}>{c.decision}</span>
                <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 8 }}>
                  p_hat={num4(c.p_hat)} z={c.z?.toFixed(2)} | {c.persistenceCount}/{c.persistenceNeeded} ticks
                </span>
              </div>
              <div style={{ textAlign: 'right', fontSize: 11 }}>
                <div style={{ color: 'var(--text-dim)' }}>edge: {pct(c.edge)}</div>
              </div>
            </div>
          ))}
          <div style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 8, fontStyle: 'italic' }}>
            Need {controller.config?.persistenceN ?? 3} consecutive same-side ticks to promote to PROPOSE.
          </div>
        </div>
      )}

      {/* Active Proposals (persisted) */}
      {controller.proposals.length > 0 && (
        <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Active Proposals (persisted)</div>
          {controller.proposals.map(p => (
            <div key={p.symbol} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 0', borderBottom: '1px solid var(--border)',
            }}>
              <div>
                <span style={{ fontWeight: 600, marginRight: 8 }}>{p.symbol}</span>
                <span style={{ color: decisionColor(p.decision), fontWeight: 600 }}>{p.decision}</span>
                <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 8 }}>
                  p_hat={num4(p.p_hat)} z={p.z?.toFixed(2)} vs upMid={num4(p.upMid)} | buySide={p.buySide} @ {p.buyPrice?.toFixed(3)}
                </span>
              </div>
              <div style={{ textAlign: 'right', fontSize: 11 }}>
                <div style={{ color: 'var(--green)' }}>netEdge: {pct(p.netEdge)}</div>
                <div style={{ color: 'var(--text-dim)' }}>{p.timeRemaining}s remaining</div>
              </div>
            </div>
          ))}
          <div style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 8, fontStyle: 'italic' }}>
            Shadow mode — no auto-execution. Proposals tracked in crypto15m_shadow.jsonl.
          </div>
        </div>
      )}

      {/* Shadow Stats */}
      {controller.shadowMode && controller.shadowStats && (
        <div className="card" style={{ borderLeft: '3px solid var(--yellow)' }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Shadow Mode Stats</div>
          <div className="metrics">
            <div className="metric">
              <div className="metric-label">Resolved</div>
              <div className="metric-value">{controller.shadowStats.resolvedCount}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Win Rate</div>
              <div className={`metric-value ${controller.shadowStats.winRate > 0.5 ? 'positive' : controller.shadowStats.winRate > 0 ? 'warn' : ''}`}>
                {(controller.shadowStats.winRate * 100).toFixed(1)}%
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">W / L</div>
              <div className="metric-value">{controller.shadowStats.wins} / {controller.shadowStats.losses}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Avg Edge</div>
              <div className="metric-value">{(controller.shadowStats.avgEdge * 100).toFixed(2)}%</div>
            </div>
            <div className="metric">
              <div className="metric-label">Avg Net Edge</div>
              <div className="metric-value">{(controller.shadowStats.avgNetEdge * 100).toFixed(2)}%</div>
            </div>
            <div className="metric">
              <div className="metric-label">Pending</div>
              <div className="metric-value">{controller.shadowStats.pendingCount}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <span style={{ padding: '2px 8px', background: 'var(--bg)', borderRadius: 3, fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border)' }}>
              volFloor filtered: {controller.shadowStats.volFloorFiltered}
            </span>
            <span style={{ padding: '2px 8px', background: 'var(--bg)', borderRadius: 3, fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border)' }}>
              zClamp filtered: {controller.shadowStats.zClampFiltered}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════
// TAB 1: Opportunities (NegRisk)
// ══════════════════════════════════════════
function OpportunitiesTab({ opps, expandedId, setExpandedId, onApprove, onSimulate }: {
  opps: Opportunity[]; expandedId: string | null; setExpandedId: (id: string | null) => void;
  onApprove: (id: string) => void; onSimulate: (id: string) => void;
}) {
  if (opps.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 16, marginBottom: 8 }}>No opportunities detected yet</div>
        <div style={{ color: 'var(--text-dim)' }}>Start the NegRisk scanner: <code>npm run agents:negrisk</code></div>
      </div>
    );
  }

  return (
    <div>
      {opps.map(opp => (
        <div key={opp.id} className="card">
          <div className="card-header">
            <div>
              <span className="card-title">{opp.marketName}</span>
              <span className="card-subtitle" style={{ marginLeft: 8 }}>
                {opp.type === '1A_BUY_ALL_YES' ? '1A: Buy-All-YES' : '1B: Buy-All-NO + Convert'} | {opp.outcomeCount} outcomes
              </span>
            </div>
            <div className="btn-group">
              <span className={`badge badge-${opp.status.toLowerCase()}`}>{opp.status}</span>
              {opp.status !== 'KILL' && (
                <>
                  <button className="btn btn-sm" onClick={() => onSimulate(opp.id)}>Simulate</button>
                  <button className="btn btn-sm btn-primary" onClick={() => onApprove(opp.id)}>Approve</button>
                </>
              )}
            </div>
          </div>

          <div className="metrics">
            <div className="metric">
              <div className="metric-label">Sum Prices</div>
              <div className="metric-value">{opp.sumPrices.toFixed(4)}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Gross Edge</div>
              <div className={`metric-value ${opp.grossEdge > 0.02 ? 'positive' : opp.grossEdge > 0 ? 'warn' : 'negative'}`}>
                {(opp.grossEdge * 100).toFixed(2)}%
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">Net Edge</div>
              <div className={`metric-value ${opp.netEdge > 0.02 ? 'positive' : opp.netEdge > 0 ? 'warn' : 'negative'}`}>
                {(opp.netEdge * 100).toFixed(2)}%
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">Fees</div>
              <div className="metric-value">{(opp.estimatedFees * 100).toFixed(2)}%</div>
            </div>
            <div className="metric">
              <div className="metric-label">Min Depth</div>
              <div className={`metric-value ${opp.minDepthUsdc >= 100 ? '' : 'warn'}`}>
                ${opp.minDepthUsdc.toFixed(0)}
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">Max Deploy</div>
              <div className="metric-value">${opp.maxNotional.toFixed(0)}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Fee Rate</div>
              <div className={`metric-value ${opp.feeRate !== null ? '' : 'warn'}`}>
                {opp.feeRate !== null ? `${(opp.feeRate * 100).toFixed(2)}%` : 'UNKNOWN'}
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">Confidence</div>
              <div className={`metric-value ${opp.confidence.overall >= 0.7 ? 'positive' : opp.confidence.overall >= 0.4 ? 'warn' : 'negative'}`}>
                {(opp.confidence.overall * 100).toFixed(0)}%
              </div>
            </div>
          </div>

          <div className="confidence-bar">
            <div className="confidence-fill" style={{
              width: `${opp.confidence.overall * 100}%`,
              background: opp.confidence.overall >= 0.7 ? 'var(--green)' : opp.confidence.overall >= 0.4 ? 'var(--yellow)' : 'var(--red)',
            }} />
          </div>

          <div style={{ marginTop: 6 }}>
            <span className="expandable-trigger" onClick={() => setExpandedId(expandedId === opp.id ? null : opp.id)}>
              {expandedId === opp.id ? '[-] Hide Brief' : '[+] Show Mini-Brief'}
            </span>
          </div>

          {expandedId === opp.id && opp.brief && (
            <MiniBrief report={opp.brief} />
          )}
          {expandedId === opp.id && !opp.brief && (
            <div className="brief">
              <div style={{ color: 'var(--text-dim)' }}>
                {opp.confidence.factors.map((f, i) => <div key={i}>{'> '}{f}</div>)}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════
// TAB 2: Pinned Markets (LLM Probability)
// ══════════════════════════════════════════
function PinnedMarketsTab({ markets, onRefresh }: { markets: PinnedMarket[]; onRefresh: () => void }) {
  const [newMarketId, setNewMarketId] = useState('');
  const [newMarketName, setNewMarketName] = useState('');

  const handlePin = async () => {
    if (!newMarketId || !newMarketName) return;
    await fetch('/api/pinned-markets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketId: newMarketId, marketName: newMarketName }),
    });
    setNewMarketId('');
    setNewMarketName('');
    onRefresh();
  };

  return (
    <div>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Pin a Market</div>
        <div className="form-row">
          <input className="input" placeholder="Market ID" value={newMarketId} onChange={e => setNewMarketId(e.target.value)} style={{ flex: 1 }} />
          <input className="input" placeholder="Market Name / Question" value={newMarketName} onChange={e => setNewMarketName(e.target.value)} style={{ flex: 2 }} />
          <button className="btn btn-primary" onClick={handlePin}>Pin</button>
        </div>
      </div>

      {markets.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--text-dim)' }}>
          No pinned markets. Pin a market above to start LLM analysis.
        </div>
      )}

      {markets.map(m => (
        <div key={m.id} className="card">
          <div className="card-header">
            <div className="card-title">{m.marketName}</div>
            {m.suggestedAction && (
              <span className={`badge ${m.suggestedAction === 'BUY_YES' ? 'badge-go' : m.suggestedAction === 'BUY_NO' ? 'badge-kill' : 'badge-conditional'}`}>
                {m.suggestedAction}
              </span>
            )}
          </div>

          <div className="metrics">
            <div className="metric">
              <div className="metric-label">Market Price</div>
              <div className="metric-value">{(m.marketPrice * 100).toFixed(1)}%</div>
            </div>
            <div className="metric">
              <div className="metric-label">ZVI Probability</div>
              <div className="metric-value">{m.zviProbability !== null ? `${(m.zviProbability * 100).toFixed(1)}%` : 'Pending'}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Mispricing</div>
              <div className={`metric-value ${(m.mispricingGap || 0) > 0.05 ? 'positive' : (m.mispricingGap || 0) < -0.05 ? 'negative' : 'warn'}`}>
                {m.mispricingGap !== null ? `${(m.mispricingGap * 100).toFixed(1)}%` : '--'}
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">CI Band</div>
              <div className="metric-value" style={{ fontSize: 13 }}>
                {m.confidenceLow !== null ? `${(m.confidenceLow * 100).toFixed(0)}-${((m.confidenceHigh || 0) * 100).toFixed(0)}%` : '--'}
              </div>
            </div>
          </div>

          {m.reasoning && m.reasoning.length > 0 && (
            <div className="brief">
              <div className="brief-section">
                <h4>Reasoning</h4>
                <ul>{m.reasoning.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
              {m.sources && m.sources.length > 0 && (
                <div className="brief-section">
                  <h4>Sources</h4>
                  <ul>{m.sources.map((s, i) => <li key={i}><a href={s} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{s}</a></li>)}</ul>
                </div>
              )}
            </div>
          )}

          <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 6 }}>
            Last analyzed: {m.lastAnalyzedAt ? new Date(m.lastAnalyzedAt).toLocaleString() : 'Never'}
          </div>
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════
// TAB 3: Signals (RP Optical-style)
// ══════════════════════════════════════════
function SignalsTab({ signals, onRefresh }: { signals: Signal[]; onRefresh: () => void }) {
  const [symbol, setSymbol] = useState('RPOL');
  const [exchange, setExchange] = useState('TASE');
  const [currency, setCurrency] = useState('ILS');
  const [threshold, setThreshold] = useState('33');
  const [direction, setDirection] = useState('below');
  const [manualPrice, setManualPrice] = useState('');
  const [manualSymbol, setManualSymbol] = useState('RPOL');

  const handleAddThreshold = async () => {
    await fetch('/api/signals/thresholds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, exchange, currency, thresholdPrice: Number(threshold), direction }),
    });
    onRefresh();
  };

  const handlePriceUpdate = async () => {
    if (!manualPrice) return;
    await fetch('/api/price-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: manualSymbol, price: Number(manualPrice) }),
    });
    setManualPrice('');
    onRefresh();
  };

  return (
    <div>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Manual Price Update (Provider A)</div>
        <div className="form-row">
          <input className="input" placeholder="Symbol" value={manualSymbol} onChange={e => setManualSymbol(e.target.value)} style={{ width: 100 }} />
          <input className="input" placeholder="Current Price" value={manualPrice} onChange={e => setManualPrice(e.target.value)} type="number" step="0.01" style={{ width: 120 }} />
          <button className="btn btn-primary" onClick={handlePriceUpdate}>Update Price</button>
        </div>
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Add Threshold</div>
        <div className="form-row">
          <input className="input" placeholder="Symbol" value={symbol} onChange={e => setSymbol(e.target.value)} style={{ width: 80 }} />
          <input className="input" placeholder="Exchange" value={exchange} onChange={e => setExchange(e.target.value)} style={{ width: 80 }} />
          <input className="input" placeholder="Currency" value={currency} onChange={e => setCurrency(e.target.value)} style={{ width: 60 }} />
          <input className="input" placeholder="Price" value={threshold} onChange={e => setThreshold(e.target.value)} type="number" style={{ width: 80 }} />
          <select className="input" value={direction} onChange={e => setDirection(e.target.value)}>
            <option value="below">Below</option>
            <option value="above">Above</option>
            <option value="cross">Cross</option>
          </select>
          <button className="btn btn-primary" onClick={handleAddThreshold}>Add</button>
        </div>
      </div>

      {signals.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--text-dim)' }}>
          No signals yet. Set thresholds above and post price updates to trigger alerts.
        </div>
      )}

      {signals.map(sig => (
        <div key={sig.id} className="card">
          <div className="card-header">
            <div>
              <span className="card-title">{sig.symbol} — {sig.direction} {sig.thresholdPrice}</span>
              <span className="card-subtitle" style={{ marginLeft: 8 }}>
                Triggered at {sig.triggeredPrice} | {new Date(sig.triggeredAt).toLocaleString()}
              </span>
            </div>
            <span className="badge badge-kill">ALERT</span>
          </div>
          {sig.report && <MiniBrief report={sig.report} />}
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════
// TAB 4: Control Panel
// ══════════════════════════════════════════
function ControlPanel({ config, agents, onToggle }: { config: SystemConfig; agents: AgentHealth[]; onToggle: (key: string, value: boolean) => void }) {
  const secretsStatus = [
    { name: 'Polymarket API', key: 'POLYMARKET_API_KEY' },
    { name: 'Polygon RPC', key: 'POLYGON_RPC_URL' },
    { name: 'Anthropic', key: 'ANTHROPIC_API_KEY' },
    { name: 'Telegram', key: 'TELEGRAM_BOT_TOKEN' },
  ];

  return (
    <div>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 12 }}>Execution Toggles</div>
        <div className="toggle-row">
          <div>
            <div className="toggle-label">Observation Only</div>
            <div className="toggle-desc">When ON, no trades are executed. Scanning and analysis only.</div>
          </div>
          <div className={`toggle ${config.observationOnly ? 'on' : ''}`} onClick={() => onToggle('observationOnly', !config.observationOnly)} />
        </div>
        <div className="toggle-row">
          <div>
            <div className="toggle-label">Manual Approval Required</div>
            <div className="toggle-desc">Every trade requires founder click to execute.</div>
          </div>
          <div className={`toggle ${config.manualApprovalRequired ? 'on' : ''}`} onClick={() => onToggle('manualApprovalRequired', !config.manualApprovalRequired)} />
        </div>
        <div className="toggle-row">
          <div>
            <div className="toggle-label">Auto-Execute</div>
            <div className="toggle-desc">DANGER: System executes approved trades without manual confirmation.</div>
          </div>
          <div className={`toggle ${config.autoExec ? 'on' : ''}`} onClick={() => onToggle('autoExec', !config.autoExec)} />
        </div>
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 12 }}>Agent Health</div>
        {agents.length === 0 && <div style={{ color: 'var(--text-dim)' }}>No agents reporting. Start with: <code>npm run agents</code></div>}
        <table className="table">
          <thead>
            <tr><th>Agent</th><th>Status</th><th>Last Heartbeat</th><th>Cycles</th><th>Error</th></tr>
          </thead>
          <tbody>
            {agents.map(a => (
              <tr key={a.agentId}>
                <td>{a.agentName}</td>
                <td><span className={`badge badge-${a.status}`}>{a.status.toUpperCase()}</span></td>
                <td>{a.lastHeartbeat ? new Date(a.lastHeartbeat).toLocaleTimeString() : '--'}</td>
                <td>{a.cycleCount}</td>
                <td style={{ color: 'var(--red)', fontSize: 11 }}>{a.lastError || '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 12 }}>Secrets Status</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {secretsStatus.map(s => (
            <div key={s.key} style={{ padding: '6px 12px', background: 'var(--bg)', borderRadius: 4, fontSize: 12 }}>
              {s.name}: <span style={{ color: 'var(--text-dim)' }}>check .env.local</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
// Mini-Brief Component (RP Optical-style)
// ══════════════════════════════════════════
function MiniBrief({ report }: { report: any }) {
  if (!report) return null;

  return (
    <div className="brief">
      {report.executiveSummary && (
        <div className="brief-section">
          <h4>Executive Summary</h4>
          <p>{report.executiveSummary}</p>
        </div>
      )}
      {report.whatMakesThisSpecial && (
        <div className="brief-section">
          <h4>What Makes This Special</h4>
          <ul>{report.whatMakesThisSpecial.map((b: string, i: number) => <li key={i}>{b}</li>)}</ul>
        </div>
      )}
      {report.multiTimeframeActions && (
        <div className="brief-section">
          <h4>Multi-Timeframe Actions</h4>
          <table className="table">
            <thead><tr><th>Window</th><th>Action</th><th>Prob</th><th>Rationale</th></tr></thead>
            <tbody>
              {report.multiTimeframeActions.map((a: any, i: number) => (
                <tr key={i}>
                  <td>{a.timeframe}</td>
                  <td><strong>{a.action}</strong></td>
                  <td>{(a.probability * 100).toFixed(0)}%</td>
                  <td style={{ color: 'var(--text-dim)' }}>{a.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report.riskRules && (
        <div className="brief-section">
          <h4>Risk Rules</h4>
          <ul>{report.riskRules.map((r: any, i: number) => <li key={i}>[{r.type}] {r.description}: {r.trigger} &rarr; {r.action}</li>)}</ul>
        </div>
      )}
      {report.assumptions && (
        <div className="brief-section">
          <h4>Assumptions</h4>
          <ul>{report.assumptions.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}
      {report.verdictChangers && (
        <div className="brief-section">
          <h4>What Would Change the Verdict</h4>
          <ul>{report.verdictChangers.map((v: string, i: number) => <li key={i}>{v}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════
// Quickstart helper components
// ══════════════════════════════════════════
function StatusPill({ label, status, detail }: { label: string; status: 'PASS' | 'FAIL' | null; detail?: string }) {
  const color = status === 'PASS' ? 'var(--green)' : status === 'FAIL' ? 'var(--red)' : 'var(--text-dim)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', background: 'var(--bg)', borderRadius: 4,
      border: `1px solid ${status === null ? 'var(--border)' : color}22`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ color: 'var(--text)', fontSize: 11 }}>{label}</span>
      <span style={{ color, fontSize: 10, fontWeight: 600 }}>{status ?? '...'}</span>
    </span>
  );
}

function CmdChip({ cmd }: { cmd: string }) {
  return (
    <div
      onClick={() => navigator.clipboard.writeText(cmd)}
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '8px 14px',
        fontSize: 12,
        fontFamily: 'monospace',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
      title="Click to copy"
    >
      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>$</span>
      <span style={{ color: 'var(--text)' }}>{cmd}</span>
      <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>(copy)</span>
    </div>
  );
}
