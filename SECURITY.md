# Security — Audit Warnings & Mitigations

> Last reviewed: 2026-02-24

## Current status

`npm install` reports **2 high-severity advisories**. Both require major-version upgrades that would break the app. We have assessed exposure and applied mitigations instead.

## The two advisories

| # | Package | Advisory | Severity | Fix version |
|---|---------|----------|----------|-------------|
| 1 | **next** 10.0.0 – 15.5.9 | DoS via Image Optimizer `remotePatterns`; DoS via insecure RSC deserialization | High | next@16.1.6 (breaking) |
| 2 | **nodemailer** <=7.0.10 | Address-parser ReDoS + interpretation conflict | High | nodemailer@8.0.1 (breaking) |

## Exposure assessment

### Next.js image optimizer / RSC

- **`next/image` is not used anywhere** in the codebase (zero imports).
- **`remotePatterns` is not configured** in `next.config.js`.
- We added `images: { unoptimized: true }` to disable the image optimizer entirely.
- **No `"use server"` directives** exist — the app has no Server Actions or server-side RSC entry points. The RSC deserialization vector does not apply.
- The app runs on `localhost:3000` (not public-facing).

**Verdict: not exposed.** The vulnerable code paths are never reached.

### nodemailer address-parser

- `nodemailer` is used in exactly one file: `src/adapters/alerts/email.ts`.
- It is only called when **both** `SMTP_HOST` and `ALERT_EMAIL_TO` env vars are set (blank by default).
- The `to` and `from` fields come from env vars, **not user input** — an attacker cannot inject a crafted email address.
- We added a **kill gate**: `ENABLE_EMAIL_ALERTS=true` must be explicitly set in `.env.local` to activate the code path. It defaults to OFF.

**Verdict: not exposed.** Even if enabled, addresses are operator-controlled, not attacker-controlled.

## What we changed (mitigations)

1. `next.config.js` — added `images: { unoptimized: true }` to disable image optimizer.
2. `src/adapters/alerts/email.ts` — added `ENABLE_EMAIL_ALERTS` env gate (defaults OFF).
3. `.env.example` — added `ENABLE_EMAIL_ALERTS=false`.

## Safe commands

```bash
# View current advisories
npm audit

# Attempt safe (non-breaking) fixes
npm audit fix
```

**Do NOT run `npm audit fix --force`** — it will upgrade Next.js from 14 to 16 and nodemailer from 6 to 8, which are major breaking changes. See `UPGRADE_PLAN.md` for the planned upgrade path.

## When we will upgrade

See `UPGRADE_PLAN.md` for the full checklist. Target: after core features stabilize (post Day-7 roadmap).
