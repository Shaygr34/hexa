#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# ZVI v1 — Bootstrap Script
# One command to go from fresh clone to running dashboard.
# Usage:  bash scripts/bootstrap.sh
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}[ZVI] Starting bootstrap...${NC}"

# 1. Install dependencies
echo -e "${BLUE}[1/4] Installing dependencies...${NC}"
npm install 2>&1 | tail -5
echo ""

# 2. Check for audit warnings (informational only)
AUDIT_EXIT=0
npm audit --audit-level=critical 2>/dev/null || AUDIT_EXIT=$?
if [ "$AUDIT_EXIT" -ne 0 ]; then
  echo -e "${YELLOW}[ZVI] npm audit warnings present — see SECURITY.md for details.${NC}"
  echo -e "${YELLOW}      Do NOT run 'npm audit fix --force'. The app is safe to run.${NC}"
else
  echo -e "${GREEN}[ZVI] No critical audit issues.${NC}"
fi
echo ""

# 3. Set up .env.local if missing
if [ ! -f .env.local ]; then
  echo -e "${BLUE}[2/4] Creating .env.local from .env.example...${NC}"
  cp .env.example .env.local
  echo -e "${YELLOW}      Edit .env.local to add your API keys (optional for observation mode).${NC}"
else
  echo -e "${GREEN}[2/4] .env.local already exists — skipping.${NC}"
fi
echo ""

# 4. Initialize database
echo -e "${BLUE}[3/4] Initializing database...${NC}"
npm run db:init
echo ""

# 5. Start dev server
echo -e "${GREEN}[4/4] Starting dashboard on http://localhost:3000 ...${NC}"
echo -e "${GREEN}       Press Ctrl+C to stop.${NC}"
echo -e "${BLUE}       To start agents, open a new terminal and run: npm run agents${NC}"
echo ""
npm run dev
