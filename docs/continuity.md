# Continuity — FiMs Wallet V3

This document lets another maintainer take over the project without depending
on its original author. It covers architecture, hosting, required secrets and
day-to-day operations.

## Overview

FiMs Wallet V3 is a Solana wallet + community dashboard built on the
[Samui Wallet](https://github.com/samui-build/samui-wallet) architecture
(remote `upstream` kept for future cherry-picks).

| Component        | Stack                                 | Location                         |
| ---------------- | ------------------------------------- | -------------------------------- |
| Wallet / web app | React + Vite + Tailwind (SPA)         | `apps/web`                       |
| API              | Effect `HttpApi` + `@effect/platform` | `apps/api`                       |
| Landing page     | Static HTML                           | `apps/landing`                   |
| Database         | Neon (Postgres) + Drizzle             | `packages/db`, `apps/api/src/db` |
| Translations     | i18next (fr/en/es)                    | `packages/i18n`                  |

## Production (Vercel)

Two Vercel projects, both connected to `flodef/FiMs-Wallet-V3` — **pushing to
`main` deploys automatically**.

| Project          | Domain                   | Content                        |
| ---------------- | ------------------------ | ------------------------------ |
| `fims-wallet-v3` | `wallet-v3.fims.fi`      | SPA (root) + API (`/api/*`)    |
| `fims-landing`   | `fims.fi`, `www.fims.fi` | `apps/landing` (rootDirectory) |

The API runs in a Vercel Function (`api/[...path].ts`) that adapts Node's
`IncomingMessage` to a Web `Request` and delegates to `handleRequest`
(`apps/api/src/index.ts`), the handler shared with the Cloudflare runtime
(local dev).

Sensitive points:

- The `/api/:path*` catch-all goes through **rewrites** (`vercel.json`) —
  non-Next.js functions do not support `[...path]` natively. The real path is
  rebuilt from the `...path` query parameter inside the adapter.
- Internal imports in `apps/api` use `.js` specifiers (resolved to `.ts` by
  TypeScript) — required by Vercel's Node runtime. Do not convert them back
  to `.ts` (a Biome override is in place).
- The frontend calls the API **same-origin** (`/api`, fallback in
  `apps/web/src/env.ts`) — no CORS needed in normal use.

### Environment variables (`fims-wallet-v3` project)

| Variable          | Purpose                                              |
| ----------------- | ---------------------------------------------------- |
| `DATABASE_URL`    | Neon connection (required for `/api/fims/*`)         |
| `ADMIN_ADDRESSES` | Admin Solana addresses (privileged actions)          |
| `CORS_ORIGINS`    | Allowed origins (landing, wallet domains, localhost) |

Secrets live in the Vercel dashboard (encrypted) or via `vercel env`.
⚠️ An env var change requires a **redeployment** to take effect.

### DNS (OVH)

- `wallet-v3.fims.fi`: CNAME → `cname.vercel-dns.com` ✅
- `fims.fi`: A record → `76.76.21.21` (Vercel anycast) + `www` → CNAME
  `cname.vercel-dns.com` — pending switch from Google Sites

## API authentication

Sensitive requests are signed by the wallet: the signature covers
`fims-wallet-v3`, the `Host` header, method, path, a timestamp and the
SHA-256 of the body. The Vercel adapter preserves all of these — do not
modify it without understanding `apps/api/src/services/auth/service.ts`.

## Database (Neon)

- Schema: `apps/api/src/db/schema.ts` (Drizzle)
- Migrations: `apps/api/scripts/migrate.ts`
- Data migrated from the legacy system (Vercel Postgres / Firebase /
  Google Sheets) — see project history for the migration script.

## Local development

```bash
bun install
bun run build        # full build
bun check-types      # typecheck
bun lint             # biome
bun run test         # tests
```

See `AGENTS.md` for conventions (Biome: single quotes, no semicolons,
120 chars; Vitest ARRANGE/ACT/ASSERT tests).

## Day-to-day operations

| Need              | Action                                                 |
| ----------------- | ------------------------------------------------------ |
| Deploy            | `git push origin main` (auto) or `vercel --prod`       |
| Rollback          | Vercel dashboard → Deployments → Promote previous      |
| API logs          | Vercel dashboard → project → Functions / `vercel logs` |
| Change an env var | Vercel dashboard, then redeploy                        |
| Add a language    | `packages/i18n/locales/<lang>/` + `i18n:extract`       |

## Access required to take over

- GitHub: write access to `flodef/FiMs-Wallet-V3`
- Vercel: team `flojito-stillnets-projects` (or transfer the projects)
- Neon: access to the Postgres project
- OVH: `fims.fi` DNS zone

## Status

- ✅ V3 deployed on Vercel, wallet functional, Neon data live
- ⬜ `wallet.fims.fi` still points to V2 — switch pending decision
- ⬜ 1 %/10 % debt rule: outgoing-action blocking implemented app-side
- ⬜ Business validation pending: 53 "crypto donation" rows + the duplicate
  846,50 € sheet line
