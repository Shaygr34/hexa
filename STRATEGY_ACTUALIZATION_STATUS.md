# ZVI v1 Strategy Actualization Status

## What Was Implemented (V1)

### Architecture Layers

1. **StrategySpec Registry** (`STRATEGY_SPECS`)
   - First-class spec per strategy: `id`, `label`, `goal`, `data_requirements`, `compute_steps`, `scoring`, `risk_gates`, `outputs`, `explain_contract`, `missing_detector`, `questions_for_founders`
   - Runtime consumes specs to produce diagnostics, blockers, and fallback mode indicators

2. **AgentRuntime** (enhanced)
   - Per-agent tick timers with heartbeat tracking (`agentTimers` map)
   - `startAgentRuntime`, `stopAgentRuntime`, `pauseAgentRuntime`, `resumeAgentRuntime`
   - Each tick: fetches market data, runs strategy, emits findings/proposals, updates heartbeat
   - Auto-pause after 5 consecutive errors

3. **Signal Bus** (`signalBus`)
   - Shared in-memory channel for cross-strategy communication
   - Channels: `watchlists`, `marketCandidates`, `entities`, `whaleMarkets`
   - Sentiment emits watchlists/entities, LLM Prob consumes them for candidate prioritization
   - Whale Watch emits whale-touched markets

4. **Data Adapters**
   - Polymarket Gamma API (markets, profiles, activity, trades)
   - LLM adapters: Anthropic, OpenAI, xAI (choose best available)
   - Manual input mode for LLM Probability (manual p-hat)
   - Keyword matching fallback for Sentiment

5. **Explainability Pipeline**
   - Every finding has a full `explain` contract: raw inputs, computation, score breakdown, risk gates passed/failed, recommended action
   - Explain Hub in Founder Console shows recent reasoning across all strategies
   - Click any finding to open full explain modal

---

### Strategy 1: NegRisk Arbitrage

**What's Implemented:**
- Market grouping by event (slug prefix, negRisk flag, question similarity clustering)
- Multi-outcome arb detection: sum of YES prices across grouped outcomes
- Configurable friction assumptions (fees % + slippage from liquidity)
- Liquidity, volume, and depth gates
- Full diagnostics: groups found, groups analyzed, gate failure distribution
- Ranked candidates with outcomes detail, edge breakdown, net edge after friction
- Explain payloads with full math and risk gate status

**Data Sources:**
- Polymarket Gamma API (markets, negRisk flag, outcomePrices)
- CLOB orderbook depth (if API key configured)

**What Remains for Execution:**
- CLOB API integration for actual orderbook depth queries
- Multi-leg order placement (simultaneous execution of all outcomes)
- Real-time price monitoring between order legs
- Actual fee structure validation from Polymarket

**3 Crucial Questions if Blocked:**
1. What fee structure should we assume? (Default: 2% round-trip)
2. Should we include markets with < $1,000 liquidity per outcome?
3. When an arb is found, should ZVI auto-propose or wait for manual review?

---

### Strategy 2: LLM Probability Mispricing

**What's Implemented:**
- Candidate selection priority: Sentiment watchlist > Pinned > Whale-touched > Top volume
- Deterministic LLM prompt schema: `{prob_yes, confidence, key_factors, disqualifiers, time_sensitivity}`
- Confidence-weighted edge computation: `weightedEdge = |llmProb - marketPrice| * confidence`
- LLM caching with configurable TTL
- **Manual Probability Mode**: if no LLM key, founders can input p-hat for any market
- Gate checks: minimum edge, minimum confidence, minimum liquidity
- Full diagnostics: candidate source, LLM calls, cache hits, manual inputs

**Data Sources:**
- Polymarket Gamma API (markets, prices)
- LLM: Anthropic Claude / OpenAI GPT-4o-mini / xAI Grok (priority order)
- Signal Bus: Sentiment watchlists, Whale-touched markets
- Manual founder estimates

**What Remains for Execution:**
- Calibration tracking (compare LLM estimates to resolution outcomes over time)
- Multi-model ensemble (query multiple LLMs, take median/weighted average)
- Kelly Criterion position sizing integrated with edge + confidence
- Automatic re-evaluation on market price changes

**3 Crucial Questions if Blocked:**
1. Which LLM provider do you trust most for probability calibration?
2. Should we prioritize markets from the sentiment watchlist?
3. What confidence threshold should disqualify an LLM estimate?

---

### Strategy 3: Sentiment / Headlines Value

**What's Implemented:**
- Headline ingestion: manual text input + future URL polling support
- LLM analysis: extracts entities, actors, directionality, severity, impact window
- Market mapping: similarity + LLM mapping to Polymarket markets
- **Signal Bus integration**: emits watchlists, entities, and market candidates
- Keyword matching fallback (no LLM needed, lower confidence)
- Full diagnostics: headlines processed, markets matched, watchlist emissions

**Data Sources:**
- Manual headline input (UI textarea)
- LLM: xAI/Grok > Anthropic > OpenAI (for analysis)
- Polymarket markets (for mapping targets)

**What Remains for Execution:**
- URL polling for headline sources (RSS feeds, news APIs)
- File-based headline ingestion
- Historical sentiment tracking and accuracy measurement
- Time-decay weighting for aging headlines
- Automatic re-run when new headlines are pasted

**3 Crucial Questions if Blocked:**
1. What news sources do you monitor most?
2. How quickly do you expect headlines to be priced in?
3. Should sentiment findings auto-feed into LLM Probability?

---

### Strategy 4: Whale Pocket-Watching

**What's Implemented:**
- **Whale Discovery Pipeline**:
  - Attempt A: Polymarket leaderboard/profiles API
  - Attempt B: Large-fill detection from trade feed
  - Attempt C: Manual wallet entry (always available)
- Wallet tracking loop with activity fetching
- Convergence detection: K+ whales on same market/side within T-minute window
- Signal Bus: emits whale-touched markets for other strategies
- Stub event generation when API unavailable (clearly labeled)
- Full diagnostics: wallets tracked, API success/failure rates, stub events

**Data Sources:**
- Polymarket Gamma API (activity, profiles, trades)
- Manual wallet addresses
- Cached market data (for stub events)

**What Remains for Execution:**
- On-chain scanning (Polygon RPC) for contract interactions
- Historical performance tracking per wallet
- PnL estimation for tracked wallets
- Copy-trade sizing based on whale position sizes
- Webhook/alert integration for real-time whale events

**3 Crucial Questions if Blocked:**
1. Do you have specific whale wallets to track?
2. What convergence threshold makes you comfortable?
3. Should whale convergence signals auto-feed into LLM Probability?

---

## Cross-Strategy Features

| Feature | Status |
|---------|--------|
| Signal Bus (cross-strategy) | Implemented |
| StrategySpec Registry | Implemented |
| Per-strategy diagnostics | Implemented |
| Missing prerequisites detector | Implemented |
| Founder questions per strategy | Implemented |
| Explain Hub | Implemented |
| Approval flow (approve/reject) | Implemented |
| Manual probability fallback | Implemented |
| Market cache with TTL + refresh | Implemented |
| Findings ring buffer | Implemented |
| Proposals ring buffer | Implemented |
| Per-agent heartbeat | Implemented |
| Whale discovery pipeline | Implemented |

## Manual Test Checklist

1. **Create 4 agents** (one per strategy): Go to Agents tab, click "+ Create Agent", select each strategy type
2. **Confirm NegRisk produces findings**: Click NegRisk Arb tab, verify findings table + diagnostics panel
3. **Confirm LLM Prob works**: Click LLM Probability tab, if no LLM key, verify manual probability input mode
4. **Confirm Sentiment works**: Paste headlines in Sentiment tab, click Analyze, verify results + watchlist emission
5. **Confirm Whale Watch works**: Add a wallet or verify discovery attempt, check whale events
6. **Confirm tabs populate**: Each strategy tab shows diagnostics (blocking items, data status, gate failures, questions)
7. **Confirm explain modals open**: Click any finding row, verify full explain modal with math/inputs/gates
8. **Confirm approvals flow**: Go to Approvals tab, approve/reject items, verify status changes
9. **Confirm Explain Hub**: Go to Founder Console > Explain Hub, verify recent reasoning across strategies
10. **Confirm cross-strategy signals**: After Sentiment run, verify LLM Prob prioritizes watchlist markets
