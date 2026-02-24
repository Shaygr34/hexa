# Upgrade Plan — Next.js 16 + nodemailer 8

> Target: after Day-7 roadmap stabilises. Not urgent — see SECURITY.md for current mitigations.

---

## 1. Next.js 14 → 16

### Expected breaking changes
- [ ] App Router API changes — review Next.js 15 + 16 migration guides
- [ ] `next.config.js` → `next.config.ts` (optional but recommended)
- [ ] React 18 → React 19 required (peer dependency)
- [ ] `next/image` default behaviour changes (we don't use it, but verify)
- [ ] Middleware API changes (we don't use middleware, but verify)
- [ ] `headers()`, `cookies()`, `params` become async in Next 15+
- [ ] Turbopack becomes default bundler — verify `better-sqlite3` externals still work
- [ ] Check if any API route signatures changed

### Steps
1. Create a branch: `git checkout -b upgrade/next-16`
2. `npm install next@16 react@19 react-dom@19`
3. `npm install -D @types/react@19 @types/react-dom@19`
4. Fix any TypeScript errors
5. Run `npm run build` — fix all build errors
6. Run `npm run dev` — verify dashboard loads on localhost:3000
7. Run `npm run test:all` — all 3 test suites pass
8. Test each tab: Opportunities, Pinned Markets, Signals, Control Panel
9. Test API routes: `/api/health`, `/api/opportunities`, `/api/control`
10. Run agents (`npm run agents`) — verify they connect and scan

### Verification checklist
- [ ] `npm run build` succeeds
- [ ] `npm run dev` starts without errors
- [ ] Dashboard renders all 4 tabs
- [ ] Approve / Simulate / Reject buttons work
- [ ] Kill switch toggles correctly
- [ ] `npm run test:all` passes
- [ ] `npm audit` shows 0 high-severity issues for next

---

## 2. nodemailer 6 → 8

### Expected breaking changes
- [ ] Constructor API changes — verify `createTransport()` options
- [ ] Possible ESM-only distribution — verify import syntax
- [ ] Auth config format may change
- [ ] Minimum Node.js version bump (likely >=18, we're on 20+)

### Steps
1. `npm install nodemailer@8`
2. `npm install -D @types/nodemailer@6` (check if @types package updated)
3. Verify `src/adapters/alerts/email.ts` compiles
4. Test with `ENABLE_EMAIL_ALERTS=true` and a test SMTP server (e.g., Mailtrap)
5. Confirm alert dispatch sends test email successfully

### Verification checklist
- [ ] `npm run build` succeeds
- [ ] Email sends with test SMTP credentials
- [ ] `npm audit` shows 0 high-severity issues for nodemailer

---

## 3. Post-upgrade

- [ ] Remove `images: { unoptimized: true }` from next.config if no longer needed (or keep — we don't use images)
- [ ] Remove `ENABLE_EMAIL_ALERTS` gate if nodemailer 8 resolves the advisory
- [ ] Update SECURITY.md to reflect resolved state
- [ ] Delete this file
