# ZVI v1 Truth Layer Context Snapshot

*Generated 2026-02-24 — For Grok research grounding. NOT a strategy evaluation.*

---

## 1. Runtime Entrypoint

- **Single file:** `standalone.mjs` (~347 KB, zero-dep Node.js ES module)
- **Start:** `node standalone.mjs` — serves HTTP on `PORT` env (default 3000)
- **Boot sequence** (line 5176-5188): `autoBootstrap()` → `startAgentScheduler()` → `startResolutionWatcher()` → diagnostics (3s) → `runAllAgents()` (5s) → Phase 1 acceptance tests (8s)
- **State file:** `zvi_state.json` in repo root; loaded on start (line 665), auto-saved on dirty flag with 5s debounce (line 556), and on SIGINT/SIGTERM (line 5208)

## 2. Data Sources Actually Used

- **Gamma API** (`gamma-api.polymarket.com`): `/markets` (paginated, lines 767/2532), `/markets/{id}` (resolution polling, line 317), `/activity` (whale wallets, line 1644), `/profiles`, `/trades`
- **CLOB API** (`clob.polymarket.com`): `/book` (orderbook for NegRisk arb), `/order` (gated live execution), `/time` (server sync)
- **LLM providers**: Anthropic (`claude-sonnet-4-5-20250929`), OpenAI (`gpt-4o` / `gpt-4o-mini`), xAI (`grok-3-mini-beta`) — used for probability estimation and sentiment analysis
- **Polygon RPC**: `eth_blockNumber` (connectivity), NegRisk Adapter `feeRate()` contract call

## 3. Market Universe

- **Fetch function:** `fetchMarkets()` at line 752 — paginated batches of 100 from Gamma `/markets?active=true&closed=false`
- **~500 cap:** `maxBatches = 5` (line 764) × `batchSize = 100` (line 763) = 500 markets per scan cycle
- **To change:** edit `maxBatches` at line 764, or POST `/api/settings` with `marketLimit` (range 10-5000, validated at line 4836)
- **Tiering** (lines 788-796): A (vol>100K or liq>50K), B (vol>10K or liq>5K), C (rest) — each tier capped at 200 markets
- **Rotation:** `scanWindow` offset advances each cycle; known-market dedup caps at 10K IDs (line 785)

## 4. Agent Loop Timings & Outputs

| Agent | Strategy Type | Refresh (s) | Outputs |
|---|---|---|---|
| NegRisk Scanner | `negrisk_arb` | 60 | Arb opps where outcome-price sum != 1.0; pushes to approvals queue |
| LLM Probability | `llm_probability` | 120 | LLM fair-value estimates vs market price; opps with edge > `minEdgePct` (2%) |
| Sentiment Analyzer | `sentiment` | 90 | Headline/keyword sentiment signals → approval proposals |
| Whale Watcher | `whale_watch` | 60 | Monitors wallet activity; convergence alerts from real (non-stub) events |

- **Scheduler** (line 2308): starts per-agent runtimes via `setInterval(tick, interval)` (min 10s floor, line 2268)
- **Each tick:** refresh market cache if stale → `runAgent()` → `recordRunTrace()` → log activity
- **Demo auto-approve loop:** 15s interval (line 416) — auto-approves pending items with positive edge, executes `executeDemoTrade()`

## 5. Execution Mode Truth

- **Demo mode is the default.** All trades call `executeDemoTrade()` (line 366) which simulates fill with slippage model (`fillPrice = price +/- slippage`, line 373), records to `store.ledger`, and opens a demo position. No CLOB orders placed.
- **Live execution gate** (`canExecuteTrades()`, line 2403): requires `POLYMARKET_API_KEY` + `POLYMARKET_API_SECRET` + `POLYMARKET_PRIVATE_KEY` + `OBSERVATION_ONLY !== 'true'` + kill switch off. Also requires `_confirmed: true` param (line 2419).
- **What is real in demo:** Gamma market data fetches, CLOB orderbook reads, LLM API calls (real tokens consumed), Polygon RPC calls. **What is simulated:** order placement, fills, slippage, fees (2% default + 0.5% slippage assumption).

## 6. Truth Layer Artifacts

- **Position lifecycle** (lines 151-296): keyed `marketId:strategy`; `openDemoPositionFromApproval()` → entries array → `closeDemoPosition()` with realized P&L calc; `markToMarket()` updates unrealized P&L every tick
- **Close-on-resolution** (lines 304-363): `pollForResolutions()` every 60s; checks Gamma for `closed/resolved/!active`; settles at 1.0/0.0 binary or MTM fallback; 7-day stale-position safety timeout
- **P&L formula** (line 92, 225): `Net P&L = totalRealized + totalUnrealized - totalFees`; realized = payout - costBasis - closeFee
- **Dedup/cooldown** (lines 272-296): `shouldSkipDueToPositionOrCooldown()` — rejects if open position exists on same `marketId:strategy`; 30-min default cooldown after close (configurable via `store.cooldownMs`); also cross-strategy cooldown check on same market
- **Whale stub filtering** (lines 1656-1763): activity API empties produce `isStub: true` events; stubs excluded from convergence counting (`source !== 'stub'`); stub-only convergence cannot create approvals; `stubRatio` tracked in diagnostics

## 7. Telemetry

- **Run traces** (`store.runTraces`, line 94): capped at 500 records (line 300); fields per trace: `tickId, agentId, agentName, strategyType, tickNumber, startedAt, endedAt, durationMs, marketsScanned, candidatesConsidered, oppsFound, approvalsCreated, tradesExecuted, cacheHits, errors` (lines 2233-2249)
- **Opportunity provenance** (line 378-388): each demo trade records `provenance: { gateResults, edgeBreakdown: {grossEdge, feesAssump, slippageAssump, netEdge}, inputSnapshotHash }`
- **Persisted in `zvi_state.json`** (lines 561-585): agents, approvalsQueue, auditLog (last 500), ledger (last 2000), positions, demoPnl, runTraces (last 200), frictionConfig, cooldownMs, findingsRing (last 50 per strategy), apiUsageEvents (last 1000), costBudgets, strategyParams
- **API endpoint:** `GET /api/run-traces?agentId=&limit=` (line 4968)

## 8. Key Limitations (Top 5)

1. **Demo-only execution** — no live CLOB order path has been battle-tested; the `createClobOrder` function exists but requires manual `_confirmed` flag and has no retry/partial-fill logic
2. **No real orderbook depth analysis** — NegRisk arb reads `/book` but the demo fill model uses a flat slippage assumption (0.5%) rather than walking the actual book
3. **LLM cost control is soft** — budget caps exist (`costBudgets`) but a burst of ticks can overshoot before the next check; no pre-call budget reservation
4. **Single-process, in-memory state** — all state lives in a JS object; `zvi_state.json` is the only persistence; crash between dirty-flag and 5s save window loses data
5. **Whale activity depends on Gamma `/activity` endpoint** — frequently returns empty, producing stub events; real whale signal coverage is low (tracked via `stubRatio` diagnostic)
