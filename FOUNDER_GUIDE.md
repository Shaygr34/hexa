# ZVI v1 — Founder Operating Guide

## What's Working Now

ZVI v1 is a single-file Fund Operating System for Polymarket on Polygon. Run `node standalone.mjs` and open `http://localhost:3000`.

### Core Systems
- **Market Scanner**: Fetches live markets from Polymarket Gamma API, computes edge/confidence
- **4 Strategy Agents**: NegRisk Arb, LLM Probability, Sentiment/Headlines, Whale Watch
- **Founder Action Queue**: 5-step onboarding wizard with API test buttons
- **Approval Queue**: All trades require your explicit approval before execution
- **Risk Engine**: Position limits, kill switch, per-market/daily caps
- **Persistence**: State saved to `zvi_state.json`, API keys to `.env.local`
- **Founder Console**: Chat-like interface for system queries, grounded in runtime state
- **Hexa Light Theme**: Clean founder-friendly theme (toggle in top-right)

## How to Demo Each Strategy

### 1. NegRisk Arbitrage
**Keys needed**: None (uses public Gamma API)
**Demo steps**:
1. Go to Agents tab → Create Agent → Strategy: NegRisk Arbitrage
2. Agent auto-runs, scans NegRisk-tagged and multi-outcome markets
3. View results in the NegRisk Arb tab
4. Opportunities with edge > threshold appear in Approval Queue

**What it does**: Identifies markets where outcome prices don't sum to 1.0 — an arbitrage signal.

### 2. LLM Probability Mispricing
**Keys needed**: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
**Demo steps**:
1. Add an LLM API key in Settings → Save API Keys
2. Create an LLM Probability agent
3. Agent asks the LLM to estimate true probabilities for top markets
4. Compares LLM estimate vs market price → finds mispricings

**What it does**: Uses calibrated LLM reasoning to find markets where the crowd may be wrong.

### 3. Sentiment / Headlines
**Keys needed**: `XAI_API_KEY` (best), or `ANTHROPIC_API_KEY`, or none (keyword fallback)
**Demo steps**:
1. Go to Sentiment tab
2. Paste real headlines (one per line)
3. Click "Analyze Headlines"
4. See which markets are impacted and in what direction

**What it does**: Maps breaking news to prediction market positions.

### 4. Whale Pocket-Watching
**Keys needed**: None
**Demo steps**:
1. Go to Whale Watch tab
2. Add wallet addresses of known traders
3. Agent polls for activity and detects convergence (multiple whales on same side)
4. Convergence alerts appear in Approval Queue

**What it does**: Tracks smart money and follows informed traders.

## Which Keys Are Required for What

| Key | Required For | Where to Get |
|-----|-------------|-------------|
| `POLYMARKET_API_KEY` + `SECRET` + `PASSPHRASE` | Live CLOB trading | polymarket.com → Settings → API Keys |
| `POLYMARKET_PRIVATE_KEY` | Signing transactions | Export from your wallet (MetaMask) |
| `POLYGON_RPC_URL` | On-chain queries (balance, blocks) | Alchemy, Infura, or QuickNode |
| `ANTHROPIC_API_KEY` | LLM Probability, Founder Console chat | console.anthropic.com |
| `OPENAI_API_KEY` | LLM Probability (alternative) | platform.openai.com |
| `XAI_API_KEY` | Sentiment analysis (best option) | x.ai |

**Minimum to start scanning**: No keys needed — public Gamma API works for market data.
**Minimum for LLM strategies**: One of Anthropic/OpenAI keys.
**Minimum for live trading**: CLOB keys + wallet key + LIVE mode enabled.

## How Approvals Work

1. Agents scan markets and produce **Opportunities**
2. Qualifying opportunities (edge >= threshold) create **Approval requests**
3. You review each in the **Approvals tab** with full explainability:
   - Math (how edge was computed)
   - Assumptions
   - Failure modes
   - Inputs
4. **Approve** → simulates trade (in OBSERVE mode) or executes (in LIVE mode)
5. **Reject** → logged and skipped

No trade ever executes without your approval in this phase.

## Where to Look When Something Fails

| Symptom | Check |
|---------|-------|
| Dashboard won't load | Terminal for Node.js errors, browser console for JS errors |
| "Demo data" showing | Health tab → Run Diagnostics → Check Polymarket API status |
| LLM agent says "Disabled" | Settings → verify ANTHROPIC_API_KEY or OPENAI_API_KEY is saved |
| No opportunities | Founder Console → ask "Why are no opportunities showing?" |
| Agent stuck on "never" | Check agent is "running" not "paused", verify refresh interval |
| Keys not persisting | Check `.env.local` file exists and is writable |

**Founder Console**: Ask the system directly — "What's missing?", "NegRisk status", "System status"

## Safety Model

### Three Layers of Safety

1. **OBSERVE mode** (default): No trades execute. Agents scan and report only.
2. **Approval Queue**: Every trade requires explicit founder approval.
3. **Kill Switch**: Instantly halts all agents and blocks all trading.

### How to Enable Live Trading (when ready)

1. Complete all 5 Action Queue steps
2. Switch mode to LIVE in Settings
3. Set agent's `allowLive: true` in agent config
4. Approve individual trades in the Approval Queue
5. Kill Switch is always available in the top-right

### Key Safety Rules
- Kill Switch overrides everything — even LIVE mode
- Private keys are redacted in UI (first/last 4 chars only)
- Keys are never logged to console
- `.env.local` is in `.gitignore`
- Risk limits cap per-market and daily exposure
- Budget per agent prevents over-allocation

## Next Upgrade Steps

1. **Real CLOB integration**: Connect authenticated CLOB endpoints for order placement
2. **On-chain balance checking**: Use Polygon RPC to verify USDC balances
3. **Multi-leg execution**: Implement simultaneous multi-outcome orders for NegRisk arb
4. **Telegram notifications**: Alert on new opportunities and approval requests
5. **Historical tracking**: Log all decisions and PnL for performance review
6. **Advanced position management**: Track open positions, compute unrealized PnL
