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

// ── Dashboard ──
export default function Dashboard() {
  const [tab, setTab] = useState<'opportunities' | 'pinned' | 'signals' | 'control'>('opportunities');
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [pinnedMarkets, setPinnedMarkets] = useState<PinnedMarket[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [agents, setAgents] = useState<AgentHealth[]>([]);
  const [config, setConfig] = useState<SystemConfig>({ observationOnly: true, manualApprovalRequired: true, autoExec: false, killSwitch: false });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [oppRes, pinnedRes, sigRes, healthRes, cfgRes] = await Promise.all([
        fetch('/api/opportunities').then(r => r.json()).catch(() => []),
        fetch('/api/pinned-markets').then(r => r.json()).catch(() => []),
        fetch('/api/signals').then(r => r.json()).catch(() => []),
        fetch('/api/health').then(r => r.json()).catch(() => []),
        fetch('/api/control').then(r => r.json()).catch(() => ({})),
      ]);
      setOpportunities(oppRes);
      setPinnedMarkets(pinnedRes);
      setSignals(sigRes);
      setAgents(healthRes);
      if (cfgRes.observationOnly !== undefined) setConfig(cfgRes);
    } catch (_) {}
    setLoading(false);
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
      <header className="header">
        <div>
          <h1>ZVI v1</h1>
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

      <div className="tabs">
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
