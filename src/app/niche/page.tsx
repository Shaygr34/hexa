'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ── Types ──
interface Strategy {
  id: string; name: string; topic: string; description: string;
  status: string; executionMode: string;
  dataSources: any[]; targetMarkets: any[];
  decisionIntervalMs: number; edgeThresholdPct: number; confidenceMinimum: number;
  riskConfig: RiskConfig; sessionConfig: SessionConfig; meta: any;
  analysisReport: string | null;
  createdAt: string; updatedAt: string; activatedAt: string | null; stoppedAt: string | null; stopReason: string | null;
  performance: Performance; controllerRunning: boolean; controllerStats: { cycleCount: number } | null;
  sourceStates: SourceState[];
}
interface RiskConfig {
  maxPositionUsdc: number; maxExposureUsdc: number; maxDrawdownPct: number;
  stopLossPct: number; maxOpenPositions: number; cooldownMs: number; killSwitch: boolean;
}
interface SessionConfig {
  maxDurationMs: number; maxTotalTrades: number; budgetUsdc: number;
  dailyLossLimitUsdc: number; dailyLossLimitPct: number; maxConsecutiveLosses: number;
  trailingStopPct: number; minBankrollUsdc: number; warmupCycles: number; autoStopOnError: boolean;
}
interface Performance {
  bankroll: number; initialBankroll: number; totalTrades: number;
  wins: number; losses: number; pending: number; winRate: number;
  totalPnl: number; totalPnlPct: number; peakBankroll: number;
  maxDrawdown: number; maxDrawdownPct: number; currentStreak: number;
  avgWinSize: number; avgLossSize: number; profitFactor: number | null;
  equityCurve: { t: string; v: number }[];
}
interface SourceState { sourceId: string; health: string; lastPollAt: string | null; lastValue: string | null; lastError: string | null; consecutiveFailures: number; totalPolls: number; }
interface Signal { id: string; marketSlug: string; action: string; estimatedProbability: number; marketPrice: number; edge: number; confidence: number; reasoning: string[]; riskGates: any[]; outcome: string; createdAt: string; }
interface Trade { id: string; marketSlug: string; side: string; price: number; size: number; shares: number; fees: number; status: string; demo: boolean; resolution: string | null; realizedPnl: number | null; createdAt: string; }
interface LogEntry { id: string; timestamp: string; level: string; module: string; message: string; data: any; }
interface CompoundEvent { id: string; timestamp: string; type: string; title: string; direction: string; strength: number; sourceIds: string[]; expiresAt: string; }
interface Preset { id: string; name: string; description: string; topic: string; icon: string; defaults: any; dataSources: any[]; marketDiscovery: any; }

// ── Main Page ──
export default function NichePage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'create' | 'detail'>('list');
  const [loading, setLoading] = useState(false);

  const fetchStrategies = useCallback(async () => {
    try {
      const res = await fetch('/api/niche/strategies');
      if (res.ok) setStrategies(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchStrategies();
    const iv = setInterval(fetchStrategies, 5000);
    return () => clearInterval(iv);
  }, [fetchStrategies]);

  const selected = strategies.find(s => s.id === selectedId) || null;

  return (
    <div className="container">
      <div className="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a href="/" style={{ color: 'var(--text-dim)', textDecoration: 'none', fontSize: 12 }}>ZVI</a>
          <span style={{ color: 'var(--border)' }}>/</span>
          <h1>NICHE STRATEGY PLATFORM</h1>
        </div>
        <div className="status">
          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            {strategies.filter(s => s.status === 'active').length} active
          </span>
          <button className="btn btn-primary" onClick={() => { setView('create'); setSelectedId(null); }}>
            + New Strategy
          </button>
        </div>
      </div>

      {view === 'list' && (
        <StrategyList
          strategies={strategies}
          onSelect={id => { setSelectedId(id); setView('detail'); }}
          onCreate={() => setView('create')}
        />
      )}

      {view === 'create' && (
        <StrategyCreator
          onCreated={id => { setSelectedId(id); setView('detail'); fetchStrategies(); }}
          onCancel={() => setView('list')}
        />
      )}

      {view === 'detail' && selected && (
        <StrategyDetail
          strategy={selected}
          onBack={() => { setView('list'); setSelectedId(null); }}
          onRefresh={fetchStrategies}
        />
      )}
    </div>
  );
}

// ── Strategy List ──
function StrategyList({ strategies, onSelect, onCreate }: { strategies: Strategy[]; onSelect: (id: string) => void; onCreate: () => void }) {
  if (strategies.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 0' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>&#x25C8;</div>
        <div style={{ color: 'var(--text-dim)', marginBottom: 24, fontSize: 14 }}>No strategies yet</div>
        <button className="btn btn-primary" onClick={onCreate}>Create Your First Strategy</button>
      </div>
    );
  }

  return (
    <div>
      {strategies.map(s => (
        <div key={s.id} className="card" onClick={() => onSelect(s.id)} style={{ cursor: 'pointer' }}>
          <div className="card-header">
            <div>
              <span className="card-title">{s.name}</span>
              <span className={`badge ${badgeClass(s.status)}`} style={{ marginLeft: 8 }}>{s.status.toUpperCase()}</span>
              {s.controllerRunning && <span className="badge badge-running" style={{ marginLeft: 4 }}>LIVE</span>}
              <span className="badge" style={{ marginLeft: 4, background: 'rgba(99,102,241,0.1)', color: 'var(--accent)' }}>{s.executionMode}</span>
            </div>
            <span className="card-subtitle">{s.topic}</span>
          </div>
          <div className="metrics">
            <div className="metric">
              <div className="metric-label">Bankroll</div>
              <div className={`metric-value ${s.performance.totalPnl >= 0 ? 'positive' : 'negative'}`}>
                ${s.performance.bankroll.toFixed(2)}
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">P&L</div>
              <div className={`metric-value ${s.performance.totalPnl >= 0 ? 'positive' : 'negative'}`}>
                {s.performance.totalPnl >= 0 ? '+' : ''}{s.performance.totalPnlPct.toFixed(1)}%
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">Win Rate</div>
              <div className="metric-value">{(s.performance.winRate * 100).toFixed(0)}%</div>
            </div>
            <div className="metric">
              <div className="metric-label">Trades</div>
              <div className="metric-value">{s.performance.totalTrades}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Sources</div>
              <div className="metric-value">{s.dataSources.length}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Cycles</div>
              <div className="metric-value">{s.controllerStats?.cycleCount || 0}</div>
            </div>
          </div>
          {s.performance.equityCurve.length > 1 && <MiniEquityCurve data={s.performance.equityCurve} />}
        </div>
      ))}
    </div>
  );
}

// ── Strategy Creator (with pre-launch config) ──
function StrategyCreator({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [step, setStep] = useState(0);
  const [topic, setTopic] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [analysisReport, setAnalysisReport] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [executionMode, setExecutionMode] = useState<string>('paper');

  // Configuration state
  const [sessionConfig, setSessionConfig] = useState<SessionConfig>({
    maxDurationMs: 3600000, maxTotalTrades: 100, budgetUsdc: 100,
    dailyLossLimitUsdc: 20, dailyLossLimitPct: 20, maxConsecutiveLosses: 5,
    trailingStopPct: 15, minBankrollUsdc: 10, warmupCycles: 3, autoStopOnError: true,
  });
  const [riskConfig, setRiskConfig] = useState<RiskConfig>({
    maxPositionUsdc: 10, maxExposureUsdc: 50, maxDrawdownPct: 20,
    stopLossPct: 10, maxOpenPositions: 5, cooldownMs: 30000, killSwitch: false,
  });
  const [decisionIntervalMs, setDecisionIntervalMs] = useState(15000);
  const [edgeThresholdPct, setEdgeThresholdPct] = useState(0.03);
  const [confidenceMinimum, setConfidenceMinimum] = useState(0.6);

  const [dataSources, setDataSources] = useState<any[]>([]);
  const [targetMarkets, setTargetMarkets] = useState<any[]>([]);
  const [discoveredMarkets, setDiscoveredMarkets] = useState<any[]>([]);
  const [discoveringMarkets, setDiscoveringMarkets] = useState(false);
  const [meta, setMeta] = useState<any>({ horizon: '15m', patternType: 'momentum', dataType: 'price', eventFrequency: 'high', marketType: 'crypto_short_term' });

  useEffect(() => {
    fetch('/api/niche/presets').then(r => r.json()).then(setPresets).catch(() => {});
  }, []);

  const loadPreset = (preset: Preset) => {
    setTopic(preset.topic);
    setName(preset.name);
    setDescription(preset.description);
    setDataSources(preset.dataSources.map((s: any, i: number) => ({ ...s, id: `preset-${i}` })));
    setMeta(preset.defaults.meta);
    setDecisionIntervalMs(preset.defaults.decisionIntervalMs);
    setEdgeThresholdPct(preset.defaults.edgeThresholdPct);
    setConfidenceMinimum(preset.defaults.confidenceMinimum);
    setRiskConfig(preset.defaults.riskConfig);
    setSessionConfig(preset.defaults.sessionConfig);
    setStep(2); // skip to config
  };

  const discoverMarkets = async () => {
    setDiscoveringMarkets(true);
    try {
      const res = await fetch('/api/niche/markets/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic }),
      });
      if (res.ok) {
        const data = await res.json();
        setDiscoveredMarkets(data.markets || []);
        setTargetMarkets(data.markets?.slice(0, 5) || []);
      }
    } catch {} finally { setDiscoveringMarkets(false); }
  };

  const createStrategy = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch('/api/niche/strategies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, topic, description, executionMode, dataSources, targetMarkets,
          decisionIntervalMs, edgeThresholdPct, confidenceMinimum,
          riskConfig, sessionConfig, meta, analysisReport,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        onCreated(data.id);
      }
    } catch {} finally { setAnalyzing(false); }
  };

  const steps = ['Topic', 'Sources', 'Configuration', 'Launch'];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button className="btn btn-sm" onClick={onCancel}>Back</button>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>Create Strategy</h2>
      </div>

      {/* Step indicator */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 24 }}>
        {steps.map((label, i) => (
          <div key={label} style={{ flex: 1, textAlign: 'center', padding: '8px 0', borderBottom: `2px solid ${i <= step ? 'var(--accent)' : 'var(--border)'}`, color: i <= step ? 'var(--accent)' : 'var(--text-dim)', fontSize: 12, fontWeight: i === step ? 700 : 400, cursor: i < step ? 'pointer' : 'default' }}
            onClick={() => i < step && setStep(i)}>
            {i + 1}. {label}
          </div>
        ))}
      </div>

      {/* Step 0: Topic + Presets */}
      {step === 0 && (
        <div>
          {presets.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Quick Start — Presets</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                {presets.map(p => (
                  <div key={p.id} className="card" onClick={() => loadPreset(p)} style={{ cursor: 'pointer' }}>
                    <div className="card-header">
                      <span className="card-title">{p.icon} {p.name}</span>
                    </div>
                    <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{p.description}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>Custom Strategy</div>
            <div className="form-row">
              <label className="form-label">Topic</label>
              <input className="input" value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g. Cryptocurrency short-term, US Politics, AI sector..." style={{ flex: 1 }} />
            </div>
            <div className="form-row">
              <label className="form-label">Name</label>
              <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Strategy name" style={{ flex: 1 }} />
            </div>
            <div className="form-row">
              <label className="form-label">Description</label>
              <input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief description of your strategy" style={{ flex: 1 }} />
            </div>
            <div style={{ marginTop: 16 }}>
              <button className="btn btn-primary" onClick={() => setStep(1)} disabled={!topic || !name}>Next: Data Sources</button>
            </div>
          </div>
        </div>
      )}

      {/* Step 1: Data Sources */}
      {step === 1 && (
        <div>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>Data Sources</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 12 }}>
              Add the data feeds that will power your strategy. Each source polls on an interval and produces directional signals.
            </div>

            {dataSources.map((src, i) => (
              <SourceCard
                key={src.id || i}
                source={src}
                onUpdate={(updated) => setDataSources(ds => ds.map((s, j) => j === i ? { ...s, ...updated } : s))}
                onRemove={() => setDataSources(ds => ds.filter((_, j) => j !== i))}
                onDuplicate={() => setDataSources(ds => [...ds, { ...src, id: `src-${Date.now()}`, name: `${src.name} (copy)` }])}
              />
            ))}

            <AddSourceForm onAdd={(src) => setDataSources(ds => [...ds, { ...src, id: `src-${Date.now()}` }])} />

            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setStep(0)}>Back</button>
              <button className="btn btn-primary" onClick={() => { discoverMarkets(); setStep(2); }}>Next: Configuration</button>
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Pre-Launch Configuration */}
      {step === 2 && (
        <div>
          {/* Session Boundaries */}
          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>Session Boundaries</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 12 }}>Define the guardrails that automatically stop the strategy.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <ConfigField label="Max Duration" value={sessionConfig.maxDurationMs / 60000} onChange={v => setSessionConfig({ ...sessionConfig, maxDurationMs: v * 60000 })} unit="min" />
              <ConfigField label="Budget" value={sessionConfig.budgetUsdc} onChange={v => setSessionConfig({ ...sessionConfig, budgetUsdc: v })} unit="USDC" />
              <ConfigField label="Max Total Trades" value={sessionConfig.maxTotalTrades} onChange={v => setSessionConfig({ ...sessionConfig, maxTotalTrades: v })} />
              <ConfigField label="Daily Loss Limit" value={sessionConfig.dailyLossLimitUsdc} onChange={v => setSessionConfig({ ...sessionConfig, dailyLossLimitUsdc: v })} unit="USDC" />
              <ConfigField label="Daily Loss Limit %" value={sessionConfig.dailyLossLimitPct} onChange={v => setSessionConfig({ ...sessionConfig, dailyLossLimitPct: v })} unit="%" />
              <ConfigField label="Max Consecutive Losses" value={sessionConfig.maxConsecutiveLosses} onChange={v => setSessionConfig({ ...sessionConfig, maxConsecutiveLosses: v })} />
              <ConfigField label="Trailing Stop" value={sessionConfig.trailingStopPct} onChange={v => setSessionConfig({ ...sessionConfig, trailingStopPct: v })} unit="%" />
              <ConfigField label="Min Bankroll" value={sessionConfig.minBankrollUsdc} onChange={v => setSessionConfig({ ...sessionConfig, minBankrollUsdc: v })} unit="USDC" />
              <ConfigField label="Warmup Cycles" value={sessionConfig.warmupCycles} onChange={v => setSessionConfig({ ...sessionConfig, warmupCycles: v })} />
            </div>
            <div className="toggle-row" style={{ marginTop: 8 }}>
              <div><div className="toggle-label">Auto-Stop on Errors</div><div className="toggle-desc">Stop strategy after repeated failures</div></div>
              <div className={`toggle ${sessionConfig.autoStopOnError ? 'on' : ''}`} onClick={() => setSessionConfig({ ...sessionConfig, autoStopOnError: !sessionConfig.autoStopOnError })} />
            </div>
          </div>

          {/* Risk Controls */}
          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>Risk Controls</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <ConfigField label="Max Position Size" value={riskConfig.maxPositionUsdc} onChange={v => setRiskConfig({ ...riskConfig, maxPositionUsdc: v })} unit="USDC" />
              <ConfigField label="Max Total Exposure" value={riskConfig.maxExposureUsdc} onChange={v => setRiskConfig({ ...riskConfig, maxExposureUsdc: v })} unit="USDC" />
              <ConfigField label="Max Drawdown" value={riskConfig.maxDrawdownPct} onChange={v => setRiskConfig({ ...riskConfig, maxDrawdownPct: v })} unit="%" />
              <ConfigField label="Stop Loss" value={riskConfig.stopLossPct} onChange={v => setRiskConfig({ ...riskConfig, stopLossPct: v })} unit="%" />
              <ConfigField label="Max Open Positions" value={riskConfig.maxOpenPositions} onChange={v => setRiskConfig({ ...riskConfig, maxOpenPositions: v })} />
              <ConfigField label="Cooldown Between Trades" value={riskConfig.cooldownMs / 1000} onChange={v => setRiskConfig({ ...riskConfig, cooldownMs: v * 1000 })} unit="sec" />
            </div>
          </div>

          {/* Decision Parameters */}
          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>Decision Parameters</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <ConfigField label="Decision Interval" value={decisionIntervalMs / 1000} onChange={v => setDecisionIntervalMs(v * 1000)} unit="sec" />
              <ConfigField label="Min Edge" value={edgeThresholdPct * 100} onChange={v => setEdgeThresholdPct(v / 100)} unit="%" />
              <ConfigField label="Min Confidence" value={confidenceMinimum * 100} onChange={v => setConfidenceMinimum(v / 100)} unit="%" />
            </div>
          </div>

          {/* Execution Mode */}
          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>Execution Mode</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['observe', 'paper', 'live'] as const).map(mode => (
                <button key={mode} className={`btn ${executionMode === mode ? 'btn-primary' : ''}`} onClick={() => setExecutionMode(mode)} style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{mode.toUpperCase()}</div>
                  <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
                    {mode === 'observe' ? 'Log signals, no trades' : mode === 'paper' ? 'Shadow bankroll, simulated' : 'Real CLOB orders'}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Target Markets */}
          {(discoveredMarkets.length > 0 || discoveringMarkets) && (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Target Markets</span>
                {discoveringMarkets && <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Discovering...</span>}
              </div>
              {discoveredMarkets.map((m, i) => (
                <div key={m.conditionId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 12, flex: 1 }}>{m.question || m.slug}</div>
                  <input type="checkbox" checked={targetMarkets.some(t => t.conditionId === m.conditionId)}
                    onChange={e => {
                      if (e.target.checked) setTargetMarkets(prev => [...prev, m]);
                      else setTargetMarkets(prev => prev.filter(t => t.conditionId !== m.conditionId));
                    }} />
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setStep(1)}>Back</button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>Next: Review & Launch</button>
          </div>
        </div>
      )}

      {/* Step 3: Review & Launch */}
      {step === 3 && (
        <div>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>Launch Summary</div>
            <div className="metrics">
              <div className="metric"><div className="metric-label">Strategy</div><div className="metric-value" style={{ fontSize: 14 }}>{name}</div></div>
              <div className="metric"><div className="metric-label">Topic</div><div className="metric-value" style={{ fontSize: 14 }}>{topic}</div></div>
              <div className="metric"><div className="metric-label">Mode</div><div className="metric-value" style={{ fontSize: 14 }}>{executionMode.toUpperCase()}</div></div>
              <div className="metric"><div className="metric-label">Budget</div><div className="metric-value">${sessionConfig.budgetUsdc}</div></div>
              <div className="metric"><div className="metric-label">Max Duration</div><div className="metric-value">{sessionConfig.maxDurationMs / 60000}min</div></div>
              <div className="metric"><div className="metric-label">Sources</div><div className="metric-value">{dataSources.length}</div></div>
              <div className="metric"><div className="metric-label">Markets</div><div className="metric-value">{targetMarkets.length}</div></div>
              <div className="metric"><div className="metric-label">Interval</div><div className="metric-value">{decisionIntervalMs / 1000}s</div></div>
              <div className="metric"><div className="metric-label">Min Edge</div><div className="metric-value">{(edgeThresholdPct * 100).toFixed(0)}%</div></div>
              <div className="metric"><div className="metric-label">Stop Loss</div><div className="metric-value">{riskConfig.stopLossPct}%</div></div>
              <div className="metric"><div className="metric-label">Max Drawdown</div><div className="metric-value">{riskConfig.maxDrawdownPct}%</div></div>
              <div className="metric"><div className="metric-label">Max Trades</div><div className="metric-value">{sessionConfig.maxTotalTrades}</div></div>
            </div>

            {dataSources.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Data Sources</div>
                {dataSources.map((s, i) => (
                  <div key={i} style={{ fontSize: 12, padding: '2px 0' }}>
                    <span style={{ color: 'var(--accent)' }}>[{s.type}]</span> {s.name} — {s.pollIntervalMs / 1000}s
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setStep(2)}>Back</button>
            <button className="btn btn-primary" onClick={createStrategy} disabled={analyzing}>
              {analyzing ? 'Creating...' : 'Create Strategy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Strategy Detail (Deep Monitoring) ──
function StrategyDetail({ strategy: s, onBack, onRefresh }: { strategy: Strategy; onBack: () => void; onRefresh: () => void }) {
  const [tab, setTab] = useState<'overview' | 'markets' | 'events' | 'signals' | 'trades' | 'logs' | 'config'>('overview');
  const [signals, setSignals] = useState<Signal[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [events, setEvents] = useState<{ compound: CompoundEvent[]; raw: any[] }>({ compound: [], raw: [] });
  const [marketStates, setMarketStates] = useState<any[]>([]);

  const fetchDetail = useCallback(async () => {
    try {
      const [sigRes, tradeRes, eventRes, logRes, mktRes] = await Promise.all([
        fetch(`/api/niche/strategies/${s.id}/signals`).catch(() => null),
        fetch(`/api/niche/strategies/${s.id}/trades`).catch(() => null),
        fetch(`/api/niche/strategies/${s.id}/events`).catch(() => null),
        fetch(`/api/niche/strategies/${s.id}/logs?limit=100`).catch(() => null),
        fetch(`/api/niche/strategies/${s.id}/markets`).catch(() => null),
      ]);
      if (sigRes?.ok) setSignals(await sigRes.json());
      if (tradeRes?.ok) setTrades(await tradeRes.json());
      if (eventRes?.ok) setEvents(await eventRes.json());
      if (logRes?.ok) setLogs(await logRes.json());
      if (mktRes?.ok) { const d = await mktRes.json(); setMarketStates(d.markets || []); }
    } catch {}
  }, [s.id]);

  useEffect(() => {
    fetchDetail();
    const iv = setInterval(fetchDetail, 5000);
    return () => clearInterval(iv);
  }, [fetchDetail]);

  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const handleAction = async (action: 'activate' | 'pause' | 'stop') => {
    setActionError(null);
    setActionLoading(true);
    try {
      const res = await fetch(`/api/niche/strategies/${s.id}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || `Failed to ${action}`);
      }
    } catch (e: any) {
      setActionError(e.message || `Failed to ${action}`);
    } finally {
      setActionLoading(false);
      onRefresh();
    }
  };

  const handleModeSwitch = async (mode: string) => {
    await fetch(`/api/niche/strategies/${s.id}/mode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    onRefresh();
  };

  const p = s.performance;
  const elapsed = s.activatedAt ? Date.now() - new Date(s.activatedAt).getTime() : 0;
  const remainingMs = Math.max(0, s.sessionConfig.maxDurationMs - elapsed);
  const progressPct = s.sessionConfig.maxDurationMs > 0 ? Math.min(100, (elapsed / s.sessionConfig.maxDurationMs) * 100) : 0;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button className="btn btn-sm" onClick={onBack}>Back</button>
        <h2 style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>{s.name}</h2>
        <span className={`badge ${badgeClass(s.status)}`}>{s.status.toUpperCase()}</span>
        {s.controllerRunning && <span className="badge badge-running">LIVE</span>}

        <div className="btn-group">
          {s.status === 'draft' && <button className="btn btn-primary btn-sm" onClick={() => handleAction('activate')} disabled={actionLoading}>{actionLoading ? 'Activating...' : 'Activate'}</button>}
          {s.status === 'active' && <button className="btn btn-sm" style={{ borderColor: 'var(--yellow)', color: 'var(--yellow)' }} onClick={() => handleAction('pause')} disabled={actionLoading}>Pause</button>}
          {s.status === 'paused' && <button className="btn btn-primary btn-sm" onClick={() => handleAction('activate')} disabled={actionLoading}>{actionLoading ? 'Resuming...' : 'Resume'}</button>}
          {(s.status === 'active' || s.status === 'paused') && <button className="btn btn-danger btn-sm" onClick={() => handleAction('stop')} disabled={actionLoading}>Stop</button>}
        </div>
      </div>

      {/* Action error banner */}
      {actionError && (
        <div style={{ padding: '8px 12px', marginBottom: 12, borderRadius: 6, background: 'rgba(239,68,68,0.1)', border: '1px solid var(--red)', color: 'var(--red)', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{actionError}</span>
          <button className="btn btn-sm" style={{ border: 'none', color: 'var(--red)', padding: '2px 8px' }} onClick={() => setActionError(null)}>dismiss</button>
        </div>
      )}

      {/* Session Progress Bar */}
      {s.status === 'active' && (
        <div className="card" style={{ padding: '8px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
            <span>Session Progress</span>
            <span>{formatDuration(elapsed)} / {formatDuration(s.sessionConfig.maxDurationMs)} ({Math.round(progressPct)}%)</span>
          </div>
          <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${progressPct}%`, height: '100%', background: progressPct > 80 ? 'var(--yellow)' : 'var(--accent)', borderRadius: 2, transition: 'width 0.5s' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
            <span>Trades: {p.totalTrades}/{s.sessionConfig.maxTotalTrades}</span>
            <span>Budget: ${p.bankroll.toFixed(2)}/${s.sessionConfig.budgetUsdc}</span>
            <span>Remaining: {formatDuration(remainingMs)}</span>
          </div>
        </div>
      )}

      {/* Key Metrics Bar */}
      <div className="metrics" style={{ marginBottom: 12 }}>
        <div className="metric">
          <div className="metric-label">Bankroll</div>
          <div className={`metric-value ${p.totalPnl >= 0 ? 'positive' : 'negative'}`}>${p.bankroll.toFixed(2)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Total P&L</div>
          <div className={`metric-value ${p.totalPnl >= 0 ? 'positive' : 'negative'}`}>{p.totalPnl >= 0 ? '+' : ''}${p.totalPnl.toFixed(2)} ({p.totalPnlPct >= 0 ? '+' : ''}{p.totalPnlPct.toFixed(1)}%)</div>
        </div>
        <div className="metric">
          <div className="metric-label">Win Rate</div>
          <div className="metric-value">{(p.winRate * 100).toFixed(0)}% ({p.wins}W/{p.losses}L)</div>
        </div>
        <div className="metric">
          <div className="metric-label">Max Drawdown</div>
          <div className={`metric-value ${p.maxDrawdownPct > 10 ? 'negative' : ''}`}>{p.maxDrawdownPct.toFixed(1)}%</div>
        </div>
        <div className="metric">
          <div className="metric-label">Streak</div>
          <div className={`metric-value ${p.currentStreak > 0 ? 'positive' : p.currentStreak < 0 ? 'negative' : ''}`}>{p.currentStreak > 0 ? `+${p.currentStreak}W` : p.currentStreak < 0 ? `${p.currentStreak}L` : '—'}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Cycles</div>
          <div className="metric-value">{s.controllerStats?.cycleCount || 0}</div>
        </div>
      </div>

      {/* Mode Switcher */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {(['observe', 'paper', 'live'] as const).map(mode => (
          <button key={mode} className={`btn btn-sm ${s.executionMode === mode ? 'btn-primary' : ''}`} onClick={() => handleModeSwitch(mode)}>
            {mode.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div className="tabs">
        {(['overview', 'markets', 'events', 'signals', 'trades', 'logs', 'config'] as const).map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === 'markets' && <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--accent)' }}>({marketStates.length})</span>}
            {t === 'signals' && signals.length > 0 && <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--accent)' }}>({signals.length})</span>}
            {t === 'trades' && trades.length > 0 && <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--accent)' }}>({trades.length})</span>}
            {t === 'events' && events.compound.length > 0 && <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--accent)' }}>({events.compound.length})</span>}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === 'overview' && <OverviewTab strategy={s} signals={signals} trades={trades} events={events} marketStates={marketStates} />}
      {tab === 'markets' && <MarketsTab strategy={s} marketStates={marketStates} onRefresh={() => { onRefresh(); fetchDetail(); }} />}
      {tab === 'events' && <EventsTab events={events} />}
      {tab === 'signals' && <SignalsTab signals={signals} />}
      {tab === 'trades' && <TradesTab trades={trades} />}
      {tab === 'logs' && <LogsTab logs={logs} />}
      {tab === 'config' && <ConfigTab strategy={s} onRefresh={onRefresh} />}
    </div>
  );
}

// ── Tab Components ──

function OverviewTab({ strategy: s, signals, trades, events, marketStates }: { strategy: Strategy; signals: Signal[]; trades: Trade[]; events: any; marketStates: any[] }) {
  return (
    <div>
      {/* Equity Curve */}
      {s.performance.equityCurve.length > 1 && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>Equity Curve</div>
          <EquityCurve data={s.performance.equityCurve} initial={s.performance.initialBankroll} />
        </div>
      )}

      {/* Target Markets Summary */}
      {marketStates.length > 0 && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>Target Markets ({marketStates.length})</div>
          {marketStates.slice(0, 5).map((m: any) => (
            <div key={m.conditionId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.question || m.slug}</div>
              <div style={{ display: 'flex', gap: 12, fontSize: 11, flexShrink: 0 }}>
                {m.yesPrice != null && <span>YES <span style={{ fontWeight: 700, color: 'var(--green)' }}>{(m.yesPrice * 100).toFixed(1)}c</span></span>}
                {m.spread != null && <span style={{ color: 'var(--text-dim)' }}>spread {(m.spread * 100).toFixed(1)}c</span>}
                {!m.active && <span className="badge badge-stopped">CLOSED</span>}
              </div>
            </div>
          ))}
          {marketStates.length > 5 && <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 4 }}>+{marketStates.length - 5} more</div>}
        </div>
      )}

      {/* Data Source Health */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Data Source Health</div>
        {s.sourceStates.length === 0 && s.dataSources.length > 0 ? (
          <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>No poll data yet</div>
        ) : (
          <div>
            {s.dataSources.map(src => {
              const state = s.sourceStates.find(ss => ss.sourceId === src.id);
              return (
                <div key={src.id || src.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{src.name}</span>
                    <span className="badge" style={{ marginLeft: 6, background: 'rgba(99,102,241,0.1)', color: 'var(--accent)' }}>{src.type}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 11 }}>
                    <span>Polls: {state?.totalPolls || 0}</span>
                    <span style={{ color: state?.lastError ? 'var(--red)' : 'var(--text-dim)' }}>Fails: {state?.consecutiveFailures || 0}</span>
                    <span className={`badge ${state?.health === 'healthy' ? 'badge-go' : state?.health === 'degraded' ? 'badge-conditional' : 'badge-kill'}`}>
                      {state?.health || 'pending'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Active Compound Events */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Active Compound Events ({events.compound?.length || 0})</div>
        {(events.compound || []).slice(0, 5).map((e: CompoundEvent) => (
          <div key={e.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span><span className="badge" style={directionBadge(e.direction)}>{e.direction}</span> {e.title}</span>
              <span style={{ color: 'var(--text-dim)' }}>{e.type}</span>
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>
              Strength: {(e.strength * 100).toFixed(0)}% | Sources: {e.sourceIds.length} | Expires: {timeAgo(e.expiresAt)}
            </div>
          </div>
        ))}
        {(!events.compound || events.compound.length === 0) && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>No active events</div>}
      </div>

      {/* Recent Signals */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Recent Signals ({signals.length})</div>
        {signals.slice(0, 5).map(sig => (
          <div key={sig.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>
                <span className={`badge ${sig.action === 'BUY_YES' ? 'badge-go' : sig.action === 'BUY_NO' ? 'badge-kill' : 'badge-stopped'}`}>{sig.action}</span>
                {' '}{sig.marketSlug}
              </span>
              <span style={{ color: 'var(--text-dim)' }}>{timeAgo(sig.createdAt)}</span>
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>
              Edge: {(sig.edge * 100).toFixed(1)}% | Conf: {(sig.confidence * 100).toFixed(0)}% | Est. prob: {(sig.estimatedProbability * 100).toFixed(0)}% vs mkt {(sig.marketPrice * 100).toFixed(0)}%
            </div>
          </div>
        ))}
        {signals.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>No signals yet</div>}
      </div>
    </div>
  );
}

function MarketsTab({ strategy: s, marketStates, onRefresh }: { strategy: Strategy; marketStates: any[]; onRefresh: () => void }) {
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const autoDiscoveredRef = useRef(false);

  // Auto-discover markets if none exist (for strategies created before auto-discovery was added)
  useEffect(() => {
    if (s.targetMarkets.length === 0 && !autoDiscoveredRef.current && !discovering) {
      autoDiscoveredRef.current = true;
      handleDiscover();
    }
  }, [s.targetMarkets.length]);

  const handleDiscover = async (query?: string) => {
    setDiscovering(true);
    try {
      const res = await fetch(`/api/niche/strategies/${s.id}/markets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'discover', queries: query ? [query] : [s.topic] }),
      });
      if (res.ok) {
        const data = await res.json();
        const existingIds = new Set(s.targetMarkets.map(m => m.conditionId));
        const newMarkets = (data.discovered || []).filter((m: any) => !existingIds.has(m.conditionId));
        setDiscovered(newMarkets);
        // Auto-add all discovered markets if strategy has none yet
        if (s.targetMarkets.length === 0 && newMarkets.length > 0) {
          await fetch(`/api/niche/strategies/${s.id}/markets`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'set', markets: newMarkets }),
          });
          setDiscovered([]);
          onRefresh();
        }
      }
    } catch {} finally { setDiscovering(false); }
  };

  const handleAdd = async (market: any) => {
    await fetch(`/api/niche/strategies/${s.id}/markets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', market }),
    });
    setDiscovered(prev => prev.filter(m => m.conditionId !== market.conditionId));
    onRefresh();
  };

  const handleRemove = async (conditionId: string) => {
    await fetch(`/api/niche/strategies/${s.id}/markets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', conditionId }),
    });
    onRefresh();
  };

  // Show target markets from strategy (not just live state — show all even without price data)
  const allMarkets = s.targetMarkets.map(tm => {
    const state = marketStates.find((ms: any) => ms.conditionId === tm.conditionId);
    return { ...tm, ...state };
  });

  return (
    <div>
      {/* Current Target Markets */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Target Markets ({allMarkets.length})</span>
          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            {allMarkets.length > 0 ? 'Polymarket markets the strategy monitors and trades' : 'Auto-discovering markets...'}
          </span>
        </div>

        {discovering && allMarkets.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <div style={{ color: 'var(--accent)', fontSize: 13 }}>Discovering markets for "{s.topic}"...</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 8 }}>Searching Polymarket for relevant prediction markets</div>
          </div>
        ) : allMarkets.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 8 }}>No markets found for this topic</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>Use the search below to find markets manually</div>
          </div>
        ) : (
          <div>
            {allMarkets.map((m: any) => (
              <div key={m.conditionId} className="card" style={{ background: 'var(--bg)', marginTop: 8 }}>
                <div className="card-header">
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{m.question || m.slug}</div>
                    <div style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 2 }}>{m.slug} | {m.conditionId.slice(0, 12)}...</div>
                  </div>
                  <div className="btn-group">
                    {!m.active && <span className="badge badge-stopped">CLOSED</span>}
                    {s.status !== 'active' && (
                      <button className="btn btn-sm btn-danger" onClick={() => handleRemove(m.conditionId)}>Remove</button>
                    )}
                  </div>
                </div>

                {/* Price data */}
                <div className="metrics" style={{ marginTop: 8 }}>
                  <div className="metric">
                    <div className="metric-label">YES Price</div>
                    <div className="metric-value" style={{ color: 'var(--green)' }}>
                      {m.yesPrice != null ? `${(m.yesPrice * 100).toFixed(1)}c` : '—'}
                    </div>
                  </div>
                  <div className="metric">
                    <div className="metric-label">NO Price</div>
                    <div className="metric-value" style={{ color: 'var(--red)' }}>
                      {m.noPrice != null ? `${(m.noPrice * 100).toFixed(1)}c` : '—'}
                    </div>
                  </div>
                  <div className="metric">
                    <div className="metric-label">Spread</div>
                    <div className={`metric-value ${m.spread > 0.05 ? 'warn' : ''}`}>
                      {m.spread != null ? `${(m.spread * 100).toFixed(1)}c` : '—'}
                    </div>
                  </div>
                  <div className="metric">
                    <div className="metric-label">YES Depth</div>
                    <div className="metric-value">
                      {m.yesDepthUsdc != null ? `$${m.yesDepthUsdc.toFixed(0)}` : '—'}
                    </div>
                  </div>
                  <div className="metric">
                    <div className="metric-label">NO Depth</div>
                    <div className="metric-value">
                      {m.noDepthUsdc != null ? `$${m.noDepthUsdc.toFixed(0)}` : '—'}
                    </div>
                  </div>
                  <div className="metric">
                    <div className="metric-label">Updated</div>
                    <div className="metric-value" style={{ fontSize: 11 }}>
                      {m.lastUpdatedAt ? timeAgo(m.lastUpdatedAt) : 'not yet'}
                    </div>
                  </div>
                </div>

                {/* Mini price chart */}
                {m.priceHistory && m.priceHistory.length > 1 && (
                  <div style={{ marginTop: 4 }}>
                    <MiniEquityCurve data={m.priceHistory.map((p: any) => ({ t: p.t, v: p.p }))} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Search + Add Markets */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Search & Add Markets</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input className="input" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            placeholder={`Search Polymarket... (e.g. "bitcoin price", "election")`}
            style={{ flex: 1 }}
            onKeyDown={e => e.key === 'Enter' && handleDiscover(searchQuery || undefined)} />
          <button className="btn btn-primary btn-sm" onClick={() => handleDiscover(searchQuery || undefined)} disabled={discovering}>
            {discovering ? 'Searching...' : 'Search'}
          </button>
        </div>

        {discovered.length > 0 && (
          <div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 8 }}>
              Found {discovered.length} new markets — click Add to include in strategy
            </div>
            {discovered.map((m: any) => (
              <div key={m.conditionId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ flex: 1, marginRight: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{m.question || m.slug}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{m.slug}</div>
                </div>
                <button className="btn btn-sm btn-primary" onClick={() => handleAdd(m)}>Add</button>
              </div>
            ))}
          </div>
        )}

        {discovered.length === 0 && !discovering && (
          <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            Search to find more Polymarket markets to add to this strategy.
          </div>
        )}
      </div>
    </div>
  );
}

function EventsTab({ events }: { events: { compound: CompoundEvent[]; raw: any[] } }) {
  return (
    <div>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Compound Events</div>
        <table className="table">
          <thead><tr><th>Time</th><th>Type</th><th>Title</th><th>Dir</th><th>Strength</th><th>Sources</th></tr></thead>
          <tbody>
            {(events.compound || []).map(e => (
              <tr key={e.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{e.timestamp.slice(11, 19)}</td>
                <td><span className="badge" style={{ background: 'rgba(99,102,241,0.1)', color: 'var(--accent)' }}>{e.type.replace(/_/g, ' ')}</span></td>
                <td>{e.title}</td>
                <td><span style={directionBadge(e.direction)}>{e.direction}</span></td>
                <td>{(e.strength * 100).toFixed(0)}%</td>
                <td>{e.sourceIds.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!events.compound || events.compound.length === 0) && <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 12 }}>No compound events detected yet</div>}
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Raw Events (latest 50)</div>
        <table className="table">
          <thead><tr><th>Time</th><th>Source</th><th>Value</th><th>Direction</th></tr></thead>
          <tbody>
            {(events.raw || []).map((e: any) => (
              <tr key={e.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{e.timestamp.slice(11, 19)}</td>
                <td style={{ fontSize: 10 }}>{e.sourceId.slice(0, 8)}</td>
                <td>{typeof e.numericValue === 'number' ? e.numericValue.toFixed(4) : String(e.value).slice(0, 30)}</td>
                <td><span style={directionBadge(e.direction)}>{e.direction}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SignalsTab({ signals }: { signals: Signal[] }) {
  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 8 }}>All Signals</div>
      <table className="table">
        <thead><tr><th>Time</th><th>Market</th><th>Action</th><th>Est. Prob</th><th>Mkt Price</th><th>Edge</th><th>Conf</th><th>Outcome</th></tr></thead>
        <tbody>
          {signals.map(sig => (
            <tr key={sig.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{sig.createdAt.slice(11, 19)}</td>
              <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{sig.marketSlug}</td>
              <td><span className={`badge ${sig.action === 'BUY_YES' ? 'badge-go' : sig.action === 'BUY_NO' ? 'badge-kill' : 'badge-stopped'}`}>{sig.action}</span></td>
              <td>{(sig.estimatedProbability * 100).toFixed(0)}%</td>
              <td>{(sig.marketPrice * 100).toFixed(0)}%</td>
              <td style={{ color: sig.edge > 0 ? 'var(--green)' : 'var(--red)' }}>{(sig.edge * 100).toFixed(1)}%</td>
              <td>{(sig.confidence * 100).toFixed(0)}%</td>
              <td><span className={`badge ${sig.outcome === 'win' ? 'badge-go' : sig.outcome === 'loss' ? 'badge-kill' : 'badge-stopped'}`}>{sig.outcome}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      {signals.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 12 }}>No signals generated yet</div>}
    </div>
  );
}

function TradesTab({ trades }: { trades: Trade[] }) {
  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 8 }}>Trade History</div>
      <table className="table">
        <thead><tr><th>Time</th><th>Market</th><th>Side</th><th>Price</th><th>Size</th><th>Shares</th><th>Fees</th><th>Mode</th><th>Status</th><th>P&L</th></tr></thead>
        <tbody>
          {trades.map(t => (
            <tr key={t.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{t.createdAt.slice(11, 19)}</td>
              <td style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.marketSlug}</td>
              <td><span className={`badge ${t.side === 'YES' ? 'badge-go' : 'badge-kill'}`}>{t.side}</span></td>
              <td>{(t.price * 100).toFixed(1)}c</td>
              <td>${t.size.toFixed(2)}</td>
              <td>{t.shares.toFixed(2)}</td>
              <td>${t.fees.toFixed(4)}</td>
              <td>{t.demo ? 'Paper' : 'Live'}</td>
              <td><span className={`badge ${t.resolution === 'won' ? 'badge-go' : t.resolution === 'lost' ? 'badge-kill' : 'badge-stopped'}`}>{t.resolution || t.status}</span></td>
              <td style={{ color: (t.realizedPnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {t.realizedPnl != null ? `${t.realizedPnl >= 0 ? '+' : ''}$${t.realizedPnl.toFixed(2)}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {trades.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 12 }}>No trades executed yet</div>}
    </div>
  );
}

function LogsTab({ logs }: { logs: LogEntry[] }) {
  return (
    <div className="card" style={{ fontFamily: 'monospace' }}>
      <div className="card-title" style={{ marginBottom: 8 }}>Strategy Logs</div>
      <div className="scroll-y" style={{ maxHeight: 600 }}>
        {logs.map(log => (
          <div key={log.id} style={{ padding: '3px 0', borderBottom: '1px solid rgba(42,42,62,0.3)', fontSize: 11 }}>
            <span style={{ color: 'var(--text-dim)' }}>{log.timestamp.slice(11, 23)}</span>
            {' '}
            <span style={{ color: logColor(log.level), fontWeight: 600 }}>[{log.level.toUpperCase()}]</span>
            {' '}
            <span style={{ color: 'var(--accent)' }}>{log.module}</span>
            {' '}
            <span>{log.message}</span>
          </div>
        ))}
        {logs.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 12 }}>No logs yet</div>}
      </div>
    </div>
  );
}

function ConfigTab({ strategy: s, onRefresh }: { strategy: Strategy; onRefresh: () => void }) {
  const handleKillSwitch = async () => {
    await fetch(`/api/niche/strategies/${s.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ riskConfig: { ...s.riskConfig, killSwitch: !s.riskConfig.killSwitch } }),
    });
    onRefresh();
  };

  return (
    <div>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 12 }}>Session Config</div>
        <div className="metrics">
          <div className="metric"><div className="metric-label">Max Duration</div><div className="metric-value">{s.sessionConfig.maxDurationMs / 60000}min</div></div>
          <div className="metric"><div className="metric-label">Budget</div><div className="metric-value">${s.sessionConfig.budgetUsdc}</div></div>
          <div className="metric"><div className="metric-label">Max Trades</div><div className="metric-value">{s.sessionConfig.maxTotalTrades}</div></div>
          <div className="metric"><div className="metric-label">Daily Loss Limit</div><div className="metric-value">${s.sessionConfig.dailyLossLimitUsdc}</div></div>
          <div className="metric"><div className="metric-label">Max Consec. Losses</div><div className="metric-value">{s.sessionConfig.maxConsecutiveLosses}</div></div>
          <div className="metric"><div className="metric-label">Trailing Stop</div><div className="metric-value">{s.sessionConfig.trailingStopPct}%</div></div>
          <div className="metric"><div className="metric-label">Min Bankroll</div><div className="metric-value">${s.sessionConfig.minBankrollUsdc}</div></div>
          <div className="metric"><div className="metric-label">Warmup</div><div className="metric-value">{s.sessionConfig.warmupCycles} cycles</div></div>
        </div>
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 12 }}>Risk Config</div>
        <div className="metrics">
          <div className="metric"><div className="metric-label">Max Position</div><div className="metric-value">${s.riskConfig.maxPositionUsdc}</div></div>
          <div className="metric"><div className="metric-label">Max Exposure</div><div className="metric-value">${s.riskConfig.maxExposureUsdc}</div></div>
          <div className="metric"><div className="metric-label">Max Drawdown</div><div className="metric-value">{s.riskConfig.maxDrawdownPct}%</div></div>
          <div className="metric"><div className="metric-label">Stop Loss</div><div className="metric-value">{s.riskConfig.stopLossPct}%</div></div>
          <div className="metric"><div className="metric-label">Max Open Positions</div><div className="metric-value">{s.riskConfig.maxOpenPositions}</div></div>
          <div className="metric"><div className="metric-label">Cooldown</div><div className="metric-value">{s.riskConfig.cooldownMs / 1000}s</div></div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button className={`btn ${s.riskConfig.killSwitch ? 'btn-danger' : ''}`} onClick={handleKillSwitch} style={{ width: '100%' }}>
            {s.riskConfig.killSwitch ? 'KILL SWITCH ON — Click to Disable' : 'Activate Kill Switch'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 12 }}>Decision Parameters</div>
        <div className="metrics">
          <div className="metric"><div className="metric-label">Interval</div><div className="metric-value">{s.decisionIntervalMs / 1000}s</div></div>
          <div className="metric"><div className="metric-label">Min Edge</div><div className="metric-value">{(s.edgeThresholdPct * 100).toFixed(0)}%</div></div>
          <div className="metric"><div className="metric-label">Min Confidence</div><div className="metric-value">{(s.confidenceMinimum * 100).toFixed(0)}%</div></div>
        </div>
      </div>

      {s.stopReason && (
        <div className="card" style={{ borderColor: 'var(--red)' }}>
          <div className="card-title" style={{ color: 'var(--red)' }}>Stop Reason</div>
          <div style={{ marginTop: 4 }}>{s.stopReason}</div>
        </div>
      )}
    </div>
  );
}

// ── Shared Components ──

function SourceCard({ source: src, onUpdate, onRemove, onDuplicate }: {
  source: any; onUpdate: (s: any) => void; onRemove: () => void; onDuplicate: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    // Collapsed view — show summary + Edit button
    const configSummary = src.type === 'api'
      ? src.config?.url || 'No URL'
      : src.type === 'polymarket'
        ? `${src.config?.marketSlug || 'No slug'} / ${src.config?.metric || 'price'}`
        : `${src.config?.provider || 'anthropic'} — ${(src.config?.prompt || '').slice(0, 50)}${(src.config?.prompt || '').length > 50 ? '...' : ''}`;

    return (
      <div className="card" style={{ background: 'var(--bg)' }}>
        <div className="card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="card-title">{src.name}</span>
            <span className="badge" style={{ background: 'rgba(99,102,241,0.1)', color: 'var(--accent)' }}>{src.type}</span>
            {!src.enabled && <span className="badge badge-stopped">DISABLED</span>}
          </div>
          <div className="btn-group">
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-sm" onClick={onDuplicate}>Dup</button>
            <button className="btn btn-sm btn-danger" onClick={onRemove}>Remove</button>
          </div>
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
          {configSummary}
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 2 }}>
          Poll: {src.pollIntervalMs / 1000}s | Priority: {src.priority}
        </div>
      </div>
    );
  }

  // Expanded edit view
  return (
    <SourceEditor
      initial={src}
      onSave={(updated) => { onUpdate(updated); setEditing(false); }}
      onCancel={() => setEditing(false)}
      saveLabel="Save"
    />
  );
}

function SourceEditor({ initial, onSave, onCancel, saveLabel = 'Add' }: {
  initial?: any; onSave: (src: any) => void; onCancel: () => void; saveLabel?: string;
}) {
  const [type, setType] = useState<string>(initial?.type || 'api');
  const [name, setName] = useState(initial?.name || '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [pollInterval, setPollInterval] = useState((initial?.pollIntervalMs || 10000) / 1000);
  const [priority, setPriority] = useState(initial?.priority || 1);

  // API fields
  const [url, setUrl] = useState(initial?.config?.url || '');
  const [method, setMethod] = useState(initial?.config?.method || 'GET');
  const [path, setPath] = useState(initial?.config?.responsePath || '');
  const [valueType, setValueType] = useState(initial?.config?.valueType || 'number');
  const [bullishWhen, setBullishWhen] = useState(initial?.config?.directionLogic?.bullishWhen || '> 0');
  const [headersJson, setHeadersJson] = useState(JSON.stringify(initial?.config?.headers || {}, null, 2));

  // Polymarket fields
  const [marketSlug, setMarketSlug] = useState(initial?.config?.marketSlug || '');
  const [metric, setMetric] = useState(initial?.config?.metric || 'price');
  const [tokenId, setTokenId] = useState(initial?.config?.tokenId || '');

  // LLM fields
  const [provider, setProvider] = useState(initial?.config?.provider || 'anthropic');
  const [model, setModel] = useState(initial?.config?.model || '');
  const [prompt, setPrompt] = useState(initial?.config?.prompt || '');
  const [queryTemplate, setQueryTemplate] = useState(initial?.config?.queryTemplate || '');
  const [responseFormat, setResponseFormat] = useState(initial?.config?.responseFormat || 'direction');
  const [temperature, setTemperature] = useState(initial?.config?.temperature ?? 0.3);
  const [maxTokens, setMaxTokens] = useState(initial?.config?.maxTokens || 512);

  // Test state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  const buildConfig = () => {
    if (type === 'api') {
      let parsedHeaders = {};
      try { parsedHeaders = JSON.parse(headersJson); } catch {}
      return { url, method, headers: parsedHeaders, responsePath: path, valueType, directionLogic: { bullishWhen } };
    }
    if (type === 'polymarket') return { marketSlug, metric, ...(tokenId ? { tokenId } : {}) };
    return { provider, ...(model ? { model } : {}), prompt, queryTemplate, responseFormat, temperature, maxTokens };
  };

  const handleSave = () => {
    onSave({ name, type, config: buildConfig(), pollIntervalMs: pollInterval * 1000, enabled, priority });
  };

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch('/api/niche/sources/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, config: buildConfig() }),
      });
      setTestResult(await res.json());
    } catch (e: any) {
      setTestResult({ valid: false, error: e.message });
    } finally { setTesting(false); }
  };

  return (
    <div className="card" style={{ background: 'var(--bg)', marginTop: 8, borderColor: 'var(--accent)' }}>
      <div className="card-title" style={{ marginBottom: 8 }}>{initial ? 'Edit Source' : 'Add Source'}</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div className="form-row">
          <label className="form-label">Type</label>
          <select className="input" value={type} onChange={e => setType(e.target.value)} style={{ flex: 1 }}>
            <option value="api">API</option>
            <option value="polymarket">Polymarket</option>
            <option value="llm">LLM / AI</option>
          </select>
        </div>
        <div className="form-row">
          <label className="form-label">Name</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Source name" style={{ flex: 1 }} />
        </div>
      </div>

      {type === 'api' && (
        <>
          <div className="form-row">
            <label className="form-label">URL</label>
            <input className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://api.example.com/data" style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="form-row">
              <label className="form-label">Method</label>
              <select className="input" value={method} onChange={e => setMethod(e.target.value)} style={{ flex: 1 }}>
                <option value="GET">GET</option><option value="POST">POST</option>
              </select>
            </div>
            <div className="form-row">
              <label className="form-label">Response Path</label>
              <input className="input" value={path} onChange={e => setPath(e.target.value)} placeholder="data.price" style={{ flex: 1 }} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="form-row">
              <label className="form-label">Value Type</label>
              <select className="input" value={valueType} onChange={e => setValueType(e.target.value)} style={{ flex: 1 }}>
                <option value="number">Number</option><option value="string">String</option><option value="boolean">Boolean</option>
              </select>
            </div>
            <div className="form-row">
              <label className="form-label">Bullish When</label>
              <input className="input" value={bullishWhen} onChange={e => setBullishWhen(e.target.value)} placeholder="> 0" style={{ flex: 1 }} />
            </div>
          </div>
          <div className="form-row">
            <label className="form-label">Headers JSON</label>
            <textarea className="input" value={headersJson} onChange={e => setHeadersJson(e.target.value)} rows={2} style={{ flex: 1, fontFamily: 'monospace', fontSize: 11 }} />
          </div>
        </>
      )}

      {type === 'polymarket' && (
        <>
          <div className="form-row">
            <label className="form-label">Market Slug</label>
            <input className="input" value={marketSlug} onChange={e => setMarketSlug(e.target.value)} placeholder="bitcoin-15-minute-up" style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="form-row">
              <label className="form-label">Metric</label>
              <select className="input" value={metric} onChange={e => setMetric(e.target.value)} style={{ flex: 1 }}>
                <option value="price">Price</option><option value="spread">Spread</option><option value="depth">Depth</option><option value="imbalance">Imbalance</option>
              </select>
            </div>
            <div className="form-row">
              <label className="form-label">Token ID</label>
              <input className="input" value={tokenId} onChange={e => setTokenId(e.target.value)} placeholder="Optional — auto-resolved from slug" style={{ flex: 1 }} />
            </div>
          </div>
        </>
      )}

      {type === 'llm' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="form-row">
              <label className="form-label">Provider</label>
              <select className="input" value={provider} onChange={e => setProvider(e.target.value)} style={{ flex: 1 }}>
                <option value="anthropic">Anthropic (Claude)</option><option value="openai">OpenAI</option><option value="xai">xAI (Grok)</option>
              </select>
            </div>
            <div className="form-row">
              <label className="form-label">Model</label>
              <input className="input" value={model} onChange={e => setModel(e.target.value)} placeholder="Default for provider" style={{ flex: 1 }} />
            </div>
          </div>
          <div className="form-row">
            <label className="form-label">System Prompt</label>
            <textarea className="input" value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} placeholder="You are a market analyst..." style={{ flex: 1 }} />
          </div>
          <div className="form-row">
            <label className="form-label">Query Template</label>
            <textarea className="input" value={queryTemplate} onChange={e => setQueryTemplate(e.target.value)} rows={2} placeholder="Use {{topic}} and {{markets}} as placeholders" style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <div className="form-row">
              <label className="form-label">Format</label>
              <select className="input" value={responseFormat} onChange={e => setResponseFormat(e.target.value)} style={{ flex: 1 }}>
                <option value="direction">Direction</option><option value="probability">Probability</option><option value="sentiment_score">Sentiment Score</option><option value="json">JSON</option>
              </select>
            </div>
            <div className="form-row">
              <label className="form-label">Temp</label>
              <input className="input" type="number" step="0.1" min="0" max="2" value={temperature} onChange={e => setTemperature(Number(e.target.value))} style={{ flex: 1 }} />
            </div>
            <div className="form-row">
              <label className="form-label">Max Tokens</label>
              <input className="input" type="number" value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))} style={{ flex: 1 }} />
            </div>
          </div>
        </>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
        <div className="form-row">
          <label className="form-label">Poll (sec)</label>
          <input className="input" type="number" value={pollInterval} onChange={e => setPollInterval(Number(e.target.value))} style={{ flex: 1 }} />
        </div>
        <div className="form-row">
          <label className="form-label">Priority</label>
          <input className="input" type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} style={{ flex: 1 }} min={1} max={10} />
        </div>
        <div className="toggle-row" style={{ padding: '4px 0', border: 'none' }}>
          <span className="form-label">Enabled</span>
          <div className={`toggle ${enabled ? 'on' : ''}`} onClick={() => setEnabled(!enabled)} />
        </div>
      </div>

      {/* Test result */}
      {testResult && (
        <div style={{ marginTop: 8, padding: 8, borderRadius: 4, background: testResult.valid ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', fontSize: 11 }}>
          {testResult.valid ? (
            <div>
              <span style={{ color: 'var(--green)', fontWeight: 600 }}>OK</span> — {testResult.latencyMs}ms — Value: {JSON.stringify(testResult.sample?.value)?.slice(0, 80)} — Direction: {testResult.sample?.direction}
            </div>
          ) : (
            <div style={{ color: 'var(--red)' }}>Failed: {testResult.error}</div>
          )}
        </div>
      )}

      <div className="btn-group" style={{ marginTop: 10 }}>
        <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={!name}>{saveLabel}</button>
        <button className="btn btn-sm" onClick={handleTest} disabled={testing}>{testing ? 'Testing...' : 'Test'}</button>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function AddSourceForm({ onAdd }: { onAdd: (src: any) => void }) {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return <button className="btn btn-sm" onClick={() => setExpanded(true)} style={{ marginTop: 8 }}>+ Add Data Source</button>;
  }

  return (
    <SourceEditor
      onSave={(src) => { onAdd(src); setExpanded(false); }}
      onCancel={() => setExpanded(false)}
      saveLabel="Add"
    />
  );
}

function ConfigField({ label, value, onChange, unit }: { label: string; value: number; onChange: (v: number) => void; unit?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <label style={{ fontSize: 11, color: 'var(--text-dim)', minWidth: 130 }}>{label}</label>
      <input className="input" type="number" value={value} onChange={e => onChange(Number(e.target.value))} style={{ width: 80 }} />
      {unit && <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{unit}</span>}
    </div>
  );
}

// ── Equity Curve (SVG) ──
function EquityCurve({ data, initial }: { data: { t: string; v: number }[]; initial: number }) {
  if (data.length < 2) return null;
  const W = 600, H = 120, PAD = 20;
  const values = data.map(d => d.v);
  const min = Math.min(...values, initial) * 0.98;
  const max = Math.max(...values, initial) * 1.02;
  const range = max - min || 1;

  const points = data.map((d, i) => {
    const x = PAD + (i / (data.length - 1)) * (W - 2 * PAD);
    const y = H - PAD - ((d.v - min) / range) * (H - 2 * PAD);
    return `${x},${y}`;
  }).join(' ');

  const initialY = H - PAD - ((initial - min) / range) * (H - 2 * PAD);
  const lastValue = values[values.length - 1];
  const color = lastValue >= initial ? 'var(--green)' : 'var(--red)';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 120 }}>
      <line x1={PAD} y1={initialY} x2={W - PAD} y2={initialY} stroke="var(--border)" strokeDasharray="4,4" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" />
      <text x={W - PAD + 4} y={initialY + 3} fill="var(--text-dim)" fontSize="9">${initial}</text>
    </svg>
  );
}

function MiniEquityCurve({ data }: { data: { t: string; v: number }[] }) {
  if (data.length < 2) return null;
  const W = 200, H = 30;
  const values = data.map(d => d.v);
  const min = Math.min(...values); const max = Math.max(...values);
  const range = max - min || 1;
  const points = data.map((d, i) => `${(i / (data.length - 1)) * W},${H - ((d.v - min) / range) * H}`).join(' ');
  const color = values[values.length - 1] >= values[0] ? 'var(--green)' : 'var(--red)';
  return <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 30, marginTop: 4 }}><polyline points={points} fill="none" stroke={color} strokeWidth="1.5" /></svg>;
}

// ── Helpers ──
function badgeClass(status: string): string {
  switch (status) {
    case 'active': return 'badge-running';
    case 'draft': case 'paused': case 'stopped': return 'badge-stopped';
    case 'error': return 'badge-error';
    case 'validating': return 'badge-conditional';
    default: return '';
  }
}

function directionBadge(dir: string): React.CSSProperties {
  if (dir === 'bullish') return { color: 'var(--green)', fontWeight: 600 };
  if (dir === 'bearish') return { color: 'var(--red)', fontWeight: 600 };
  return { color: 'var(--text-dim)' };
}

function logColor(level: string): string {
  switch (level) {
    case 'error': return 'var(--red)';
    case 'warn': return 'var(--yellow)';
    case 'decision': return 'var(--accent)';
    case 'trade': return 'var(--green)';
    default: return 'var(--text-dim)';
  }
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return `in ${formatDuration(-diff)}`;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  return `${Math.round(diff / 3600000)}h ago`;
}

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
}
