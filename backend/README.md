# KagoBuild backend

Fastify 5 **modular monolith** (API) plus a separate **worker** process, on PostgreSQL and Redis.
Design: [docs/sys_doc/02-architecture/08-backend-design.md](../docs/sys_doc/02-architecture/08-backend-design.md).

> **Status:** written and tested against real PostgreSQL 16 and Redis 7 (56 automated tests, plus an independent review whose findings are fixed). **Not production certified.** Supabase, Paystack and an AI provider still need real accounts and sandbox testing; building-rule, take-off and plan-price values are **sample data** awaiting sign-off.

## What runs

| Process | Command | Scale on |
|---------|---------|----------|
| API (REST, SSE, WebSocket chat) | `npm start` | CPU, latency, requests in flight |
| Worker (outbox relay, AI plans, events, payment reconciliation) | `npm run worker` | Queue age and depth |
| Migrations (once per deploy) | `npm run migrate` | – |

## Quick start (Docker)

```bash
cd backend
npm install            # creates node_modules for local tools and tests
docker compose up --build
```

Open http://localhost:3000/pages/index.html. This starts PostgreSQL, Redis, migrations, **2 API copies** behind nginx, and 1 worker. Without Supabase keys, sign-in returns `503 auth_not_configured`. Everything else that needs no login (health, materials) works.

## Quick start (without Docker)

Needs Node.js 22, PostgreSQL 15+ and Redis 7.

```bash
cd backend
cp .env.example .env      # fill in DATABASE_URL, REDIS_URL, Supabase keys
npm install
npm run migrate
npm start                 # terminal 1
npm run worker            # terminal 2
```

`.env` is loaded by your process manager or shell (`node --env-file=.env src/server.js` also works on Node 22).

## Tests

```bash
# Uses TEST_DATABASE_URL and TEST_REDIS_URL. The test database is wiped on every run: never point it at real data.
export TEST_DATABASE_URL=postgres://kagobuild:kagobuild@localhost:5432/kagobuild_test
export TEST_REDIS_URL=redis://localhost:6379/1
npm run check   # syntax of every file
npm test        # unit + integration tests on real PostgreSQL and Redis
```

| File | Covers |
|------|--------|
| `domain.test.js` | Money, geometry, building rules, template layouts, take-off, pricing, HMAC, AI repair and fallback, config |
| `api.test.js` | Health, JWT checks, cookies, CSRF, throwaway emails, projects, BOLA, members, catalogue cache, admin and MFA, price approval, route inventory |
| `billing.test.js` | Idempotency, provider outage, webhook signature, duplicates, amount mismatch, no downgrade, webhook vs reconcile race, renewals |
| `generations.test.js` | Outbox → queue → worker → plans, SSE and replay, quota (incl. parallel), unfit brief, duplicate delivery, estimates, CSV safety |
| `chat.test.js` | Two API copies, WebSocket fan-out, outsiders, duplicates, REST fallback, origin, rate and socket limits, token expiry |
| `resilience.test.js` | Redis down: readiness fails, reads still work, sign-in and payments fail closed |

CI runs all of this on every push: [`.github/workflows/backend-ci.yml`](../.github/workflows/backend-ci.yml).

## Before going live

1. Supabase project with **asymmetric JWT keys**, email confirmation, password-reset redirect, MFA for admins.
2. Paystack **test mode** end to end, then live keys; keep `BILLING_ENABLED=false` until signed off. Activate plans in `plan_catalog` only after prices are decided (B-01).
3. Run `migrations/900_runtime_role.sql.example` so the app connects with least privilege.
4. Set `TRUSTED_PROXY_CIDRS`, HTTPS `ALLOWED_ORIGINS`, `ADMIN_REQUIRE_MFA=true` (default in production).
5. Quantity surveyor sign-off on `src/domain/takeoff.js` coefficients and `src/domain/plan.js` rules (SANS 10400).
6. Load tests (100 / 1,000 / 10,000 users), failover and restore drills, external security review.
7. Replace `picsum.photos` and `randomuser.me` images in the frontend: the API's Content-Security-Policy blocks external images.
8. Move the inline `<script>` blocks of the 32 pages that still have them into files under `frontend/scripts/`: the same policy blocks inline scripts when the API serves the pages (`SERVE_FRONTEND=true`). The Docker setup serves pages through nginx and is not affected.
9. Refresh the throwaway-email list regularly: `npm update disposable-email-domains-js`.
