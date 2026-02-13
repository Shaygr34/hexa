# ZVI v1 — Polymarket Fund Operating System

> Turns the founder into a one-click decision maker. Agents do continuous scanning, math, reporting, and (optionally) execution.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    FOUNDER DASHBOARD                        │
│  [Opportunities]  [Pinned Markets]  [Signals]  [Control]   │
│                                                             │
│  Approve ──→ Simulate ──→ Execute     [KILL SWITCH]        │
└───────────────────────┬─────────────────────────────────────┘
                        │ API
┌───────────────────────┴─────────────────────────────────────┐
│                    NEXT.JS API ROUTES                        │
│  /api/opportunities  /api/signals  /api/control  /api/...   │
└───────────┬──────────────┬──────────────┬───────────────────┘
            │              │              │
    ┌───────┴───┐  ┌───────┴───┐  ┌──────┴────┐
    │  MODULE 1 │  │  MODULE 2 │  │  MODULE 3 │
    │  NegRisk  │  │  LLM Prob │  │  Signal   │
    │Observatory│  │  Engine   │  │  Watcher  │
    └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
          │              │              │
    ┌─────┴─────┐  ┌─────┴─────┐  ┌────┴──────┐
    │MATH ENGINE│  │LLM ADAPTER│  │  OPTICAL  │
    │(determin.)│  │(interpret)│  │  REPORT   │
    └─────┬─────┘  └───────────┘  │ GENERATOR │
          │                       └───────────┘
    ┌─────┴──────────────────┐
    │   POLYMARKET ADAPTERS  │
    │ Gamma │ CLOB │ feeRate │
    └────────────────────────┘
```

**Separation of concerns (Dodeca style):**
- `src/engine/math-engine.ts` = **TRUTH**. Pure deterministic computation.
- LLM adapters = **INTERPRETATION ONLY**. Never computes edge/fees.
- Every decision is audit-logged: `inputs → metrics → narrative → action`.

---

## Repository Structure

```
hexa/
├── package.json
├── tsconfig.json
├── next.config.js
├── docker-compose.yml
├── Dockerfile
├── .env.example           # Copy to .env.local
├── .gitignore
│
├── src/
│   ├── app/               # Next.js App Router
│   │   ├── layout.tsx
│   │   ├── page.tsx       # Dashboard (4 tabs)
│   │   ├── globals.css
│   │   └── api/
│   │       ├── opportunities/route.ts
│   │       ├── pinned-markets/route.ts
│   │       ├── signals/route.ts
│   │       ├── signals/thresholds/route.ts
│   │       ├── price-update/route.ts
│   │       ├── approve/route.ts
│   │       ├── control/route.ts
│   │       └── health/route.ts
│   │
│   ├── engine/
│   │   └── math-engine.ts          # Deterministic math (THE source of truth)
│   │
│   ├── agents/
│   │   ├── runner.ts               # Multi-agent runner
│   │   ├── negrisk-agent.ts        # MODULE 1: NegRisk Observatory
│   │   ├── signal-watcher-agent.ts # MODULE 3: RP Optical signal watcher
│   │   └── llm-probability-agent.ts# MODULE 2: LLM probability engine
│   │
│   ├── adapters/
│   │   ├── polymarket/
│   │   │   ├── gamma-api.ts        # Market discovery
│   │   │   ├── clob-api.ts         # Orderbook + trading
│   │   │   ├── fee-rate-fetcher.ts # On-chain feeRate (CRITICAL)
│   │   │   └── types.ts
│   │   ├── llm/
│   │   │   ├── base.ts             # LLM adapter interface
│   │   │   ├── anthropic.ts        # Claude adapter
│   │   │   ├── openai.ts           # OpenAI / xAI adapter
│   │   │   └── factory.ts          # Auto-select adapter
│   │   └── alerts/
│   │       ├── dispatcher.ts       # Multi-channel dispatch
│   │       ├── telegram.ts
│   │       ├── email.ts
│   │       └── webhook.ts
│   │
│   ├── reports/
│   │   └── optical-style.ts        # RP Optical report generator
│   │
│   ├── audit/
│   │   └── logger.ts               # Immutable audit trail
│   │
│   └── lib/
│       ├── types.ts                # All TypeScript types
│       ├── config.ts               # Env config loader
│       ├── db.ts                   # SQLite database layer
│       └── db-init.ts              # DB initialization script
│
└── scripts/
    ├── test-negrisk.ts             # NegRisk acceptance test
    ├── test-feerate.ts             # feeRate fetcher test
    └── test-rpol.ts                # RPOL signal watcher test
```

---

## RUN LOCAL

### Prerequisites
- Node.js 20+ (or Bun)
- npm

### 1. Install dependencies

```bash
cd hexa
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` — for **observation-only mode**, you only need:
```
POLYGON_RPC_URL=https://polygon-rpc.com    # Or your Alchemy/Infura Polygon RPC
```

Everything else is optional for v1 observation mode.

### 3. Initialize database

```bash
npm run db:init
```

### 4. Start the dashboard

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### 5. Start agents (separate terminal)

```bash
# All agents
npm run agents

# Or individually
npm run agents:negrisk    # NegRisk Observatory
npm run agents:signals    # Signal Watcher
npm run agents:llm        # LLM Probability Engine (needs API key)
```

### 6. Test the signal watcher (manual price update)

```bash
# Add a threshold
curl -X POST http://localhost:3000/api/signals/thresholds \
  -H "Content-Type: application/json" \
  -d '{"symbol":"RPOL","exchange":"TASE","currency":"ILS","thresholdPrice":33,"direction":"below"}'

# Post a price update → triggers alert
curl -X POST http://localhost:3000/api/price-update \
  -H "Content-Type: application/json" \
  -d '{"symbol":"RPOL","price":33}'
```

### Docker Compose (multi-agent on Mac minis)

```bash
cp .env.example .env.local  # Configure
docker compose up -d
```

This starts:
- Dashboard on port 3000
- NegRisk scanner agent
- Signal watcher agent
- LLM probability engine

---

## CONFIG

### Required for observation mode
| Variable | Description | Default |
|----------|-------------|---------|
| `POLYGON_RPC_URL` | Polygon RPC for feeRate | `https://polygon-rpc.com` |

### Required for execution mode
| Variable | Description |
|----------|-------------|
| `POLYMARKET_PRIVATE_KEY` | Wallet private key |
| `POLYMARKET_API_KEY` | CLOB API key |
| `POLYMARKET_API_SECRET` | CLOB API secret |
| `POLYMARKET_API_PASSPHRASE` | CLOB API passphrase |

### LLM (for Module 2)
| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key (preferred) |
| `OPENAI_API_KEY` | OpenAI API key (fallback) |
| `XAI_API_KEY` | xAI / Grok API key (fallback) |

### Alerts
| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Chat ID for alerts |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP settings |
| `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` | Email addresses |
| `WEBHOOK_URL` | Generic webhook endpoint |

### Risk limits
| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_EXPOSURE_PER_MARKET` | `500` | Max USDC per market |
| `DAILY_MAX_EXPOSURE` | `2000` | Max USDC per day |
| `MIN_EDGE_THRESHOLD` | `0.02` | 2% minimum net edge |
| `MIN_DEPTH_USDC` | `100` | Min depth per leg |
| `OBSERVATION_ONLY` | `true` | No trading |
| `MANUAL_APPROVAL_REQUIRED` | `true` | Founder must click |
| `AUTO_EXEC` | `false` | Auto-execute approved |
| `KILL_SWITCH` | `false` | Emergency halt |

---

## TEST PLAN

### Run all tests
```bash
npm run test:all
```

### Test 1: NegRisk Observatory
```bash
npm run test:negrisk
```
**What it verifies:**
- Math engine correctly computes Σ(YES), gross edge, net edge
- Type 1A (buy-all-YES, Σ < 1) detected and scored
- Type 1B (buy-all-NO + convert, Σ > 1) detected and scored
- No-opportunity case (Σ ≈ 1) returns KILL
- Unknown feeRate reduces confidence score
- Stale orderbook reduces confidence score
- RP Optical-style mini-brief is generated with all sections
- Opportunity ranking by net edge works

### Test 2: feeRate Fetcher
```bash
npm run test:feerate
```
**What it verifies:**
- Connects to Polygon RPC and calls NegRiskAdapter.feeRate()
- Returns structured result (feeRate decimal, raw bigint, denominator)
- OR hard-fails with explicit error message (never silent)
- Invalid RPC returns descriptive error
- Invalid contract address returns descriptive error

### Test 3: RPOL Signal Watcher
```bash
npm run test:rpol
```
**What it verifies:**
- Creates threshold (RPOL at ₪33, direction: below)
- Price ₪36 → no alert (above threshold)
- Price ₪33 → alert fires with RP Optical-style report
- Report has all sections: executive summary, special bullets, timeframe actions, risk rules, assumptions, verdict changers
- Report uses equity timeframes (1m/3m/12m)
- Deduplication works (same trigger doesn't fire twice in 1 hour)
- Report is renderable as formatted text

---

## NEXT 7 DAYS — Roadmap

### Day 1-2: Stabilize v1
- [ ] Deploy to Mac mini with Docker Compose
- [ ] Verify NegRisk scanner finds real opportunities on Polymarket
- [ ] Confirm feeRate fetcher with a proper Polygon RPC (Alchemy/Infura)
- [ ] Set up Telegram alerts for RPOL

### Day 3: Execution plumbing
- [ ] Wire up CLOB order execution (dry-run mode first)
- [ ] Implement basket execution: buy all legs in sequence with slippage checks
- [ ] Add "Simulate" button: shows expected fills without placing orders

### Day 4: LLM Engine v2
- [ ] Connect Anthropic API key, run first calibrated probability estimates
- [ ] Build market price feed (auto-fetch from Gamma API) for pinned markets
- [ ] Add mispricing alerts when gap > 10%

### Day 5: Market data provider
- [ ] Integrate real market data API for TASE equities (Provider B)
- [ ] Auto-feed RPOL price instead of manual POST
- [ ] Add more asset thresholds

### Day 6: Risk & Monitoring
- [ ] Daily P&L tracking for executed trades
- [ ] Risk exposure dashboard (current positions, unrealized P&L)
- [ ] Alert if any agent goes down for > 5 minutes
- [ ] Implement position-aware risk checks before new trades

### Day 7: Polish & Scale
- [ ] Add market end-date parsing for capital lock duration estimates
- [ ] Historical opportunity tracker (which arbs appeared, duration, outcome)
- [ ] Multi-user support (if adding team members)
- [ ] Postgres/Supabase migration path

### V2+ Horizon
- On-chain NegRisk convert execution (calling NegRiskAdapter directly)
- Multi-exchange arbitrage (Polymarket ↔ Kalshi ↔ Metaculus)
- Portfolio optimization across opportunities
- Automated rebalancing based on edge decay
- Mobile alerts app
