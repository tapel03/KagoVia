# KagoVia

**Design and budget your home with AI.**

KagoBuild helps anyone planning to build or extend a home describe what they want in plain language and get, within about a minute, a floor plan, a complete material list and a priced budget they can trust, before paying an architect or quantity surveyor.

Built for South Africa at launch: prices in ZAR, metric units, and layouts checked against SANS 10400.

> **Status:** early development. The frontend UI is built with demo data. The target backend is designed (System design v4) but **not yet in this repository**: the files in `backend/` are empty placeholders. Nothing is load-tested or production-ready. See [Project status](#project-status).

---

## The problem

- Plans can cost R15,000 to R60,000 before an owner knows whether the dream is affordable.
- Quantity take-offs are manual and slow.
- Material prices move weekly and vary by region.
- Budgets overrun because wastage, labour and VAT get forgotten.

## What KagoBuild does

1. **Describe your home.** A guided 3-step wizard captures plot size, floor area, bedrooms, style, finish level, location and budget.
2. **Get 3 floor-plan options.** The AI proposes layouts as structured geometry (rooms, walls, openings), not just a picture.
3. **Refine by chatting.** Ask for changes like "move the kitchen next to the dining area" or "make the garage fit 3 cars".
4. **See every material needed.** A deterministic take-off engine calculates quantities from the plan. The AI never does the arithmetic.
5. **See real prices by region.** Each line shows supplier, unit price and a "prices as of" time.
6. **Know if you are on budget.** Totals with a realistic range, contingency, 15% VAT, a budget-health gauge and risk level.
7. **Export and share.** PDF and CSV for everyone, Excel BOQ on paid plans.

### Core principle

**The AI proposes; deterministic code verifies.** The language model suggests a layout. Code then solves the geometry, checks building rules, draws the plan and counts the materials. This keeps plans valid, quantities reproducible and estimates auditable.

## Who it is for

| User | Need |
|------|------|
| First-time homeowners | Plain language and a number they can show the bank |
| Small builders | Fast quotes, editable quantities, supplier comparison |
| Architects and draughtspeople | Quick concept options with rule checks |
| Platform admins | Control over prices, rules, AI jobs and suppliers |

## Architecture

KagoBuild is a **modular monolith**: one codebase with separate modules inside (auth check, projects, materials, billing, admin). We do **not** start with microservices; a module is split out only when measurements show it is a bottleneck ([Decision A-04](docs/sys_doc/00-overview/02-decision-register.md)).

To stay up when something fails, the design runs **many copies** of the same app behind a load balancer, gives **every data store a backup**, and runs heavy jobs (AI, exports, supplier sync, payment checks) in **separate workers**, so if AI breaks, login and payments keep working.

![KagoBuild high-availability design](docs/sys_doc/02-architecture/images/07-high-availability.png)

Read more: [System design v4](docs/sys_doc/02-architecture/01-system-design-v4.md) · [High availability](docs/sys_doc/02-architecture/07-high-availability.md) · [Scalability](docs/sys_doc/02-architecture/05-scalability.md)

## Tech stack

Target stack from [System design v4](docs/sys_doc/02-architecture/01-system-design-v4.md). These are the **working assumptions** in the [Decision register](docs/sys_doc/00-overview/02-decision-register.md); each still needs the owner's confirmation.

| Layer | Target (v4) | Older baseline (Oct 2026) |
|-------|-------------|---------------------------|
| Frontend | Static multi-page HTML, CSS and JavaScript | Same |
| API | Node.js 22 + **Fastify 5**, modular monolith | Express |
| Database | **PostgreSQL** (all operational data) | MongoDB + PostgreSQL |
| Cache and rate limits | Redis (managed, highly available) | Redis |
| Background jobs | Transactional outbox + durable queue + separate workers | BullMQ |
| Authentication | **Supabase Auth** (managed, MFA for admins) | Custom JWT |
| Realtime | **SSE** for AI progress; WebSockets later for chat | Socket.io |
| Payments | Paystack (to confirm, decision B-04) | Not in baseline |
| AI | Provider-agnostic LLM wrapper with structured output | Same |
| Storage | Private S3-compatible object storage and CDN | Same |
| Analytics | Isolated PostgreSQL data warehouse (ETL) | ClickHouse or BigQuery later |

## Documentation

All documentation lives in [`docs/sys_doc`](docs/sys_doc/README.md). Start with **Project status**, then the **Decision register**.

| Folder | Documents |
|--------|-----------|
| [00-overview](docs/sys_doc/00-overview/) | [Project status](docs/sys_doc/00-overview/01-project-status.md) · [Decision register](docs/sys_doc/00-overview/02-decision-register.md) · [Implementation plan](docs/sys_doc/00-overview/03-implementation-plan.md) |
| [01-product](docs/sys_doc/01-product/) | [Product requirements](docs/sys_doc/01-product/01-product-requirements.md) · [App flow](docs/sys_doc/01-product/02-app-flow.md) · [Design brief](docs/sys_doc/01-product/03-design-brief.md) |
| [02-architecture](docs/sys_doc/02-architecture/) | [**System design v4**](docs/sys_doc/02-architecture/01-system-design-v4.md) · [Technical requirements](docs/sys_doc/02-architecture/02-technical-requirements.md) · [API inventory](docs/sys_doc/02-architecture/03-api-inventory.md) · [Database schema](docs/sys_doc/02-architecture/04-database-schema.md) · [Scalability](docs/sys_doc/02-architecture/05-scalability.md) · [Baseline system design](docs/sys_doc/02-architecture/06-system-design-baseline.md) · [High availability](docs/sys_doc/02-architecture/07-high-availability.md) |
| [03-security](docs/sys_doc/03-security/) | [Security audit 2026-11-02](docs/sys_doc/03-security/01-security-audit-2026-11-02.md) |
| [04-payments](docs/sys_doc/04-payments/) | [Payment reliability](docs/sys_doc/04-payments/01-payment-reliability.md) |
| [05-data-warehouse](docs/sys_doc/05-data-warehouse/) | [Warehouse and ETL design](docs/sys_doc/05-data-warehouse/01-warehouse-etl-design.md) |
| [06-operations](docs/sys_doc/06-operations/) | [Deployment](docs/sys_doc/06-operations/01-deployment.md) · [Caching](docs/sys_doc/06-operations/02-caching.md) · [Observability](docs/sys_doc/06-operations/03-observability.md) · [Local development](docs/sys_doc/06-operations/04-local-development.md) |

The original eight files in `docs/` (01 to 08) are kept for history. Their new locations are listed in the [CHANGELOG](docs/sys_doc/CHANGELOG.md).

## Project structure

```
KagoVia/
├── frontend/
│   ├── pages/        # HTML pages (landing, dashboard, planner, estimator, 19 admin pages...)
│   ├── styles/       # Global styles, CSS variables
│   ├── scripts/      # Client logic (planner, floorplan viewer, auth, api)
│   ├── assets/       # Images, video, testimonials
│   └── utils/        # validators, formatters, calculations
├── backend/          # Placeholder files only (empty); v4 Fastify backend not yet added
│   ├── routes/  controllers/  services/  middleware/  jobs/
│   ├── models/
│   │   ├── sql/      # Material.sql, Supplier.sql, Pricing.sql (baseline)
│   │   └── mongo/    # Baseline only; v4 drops MongoDB (decision A-02)
│   └── config/  sockets/  utils/
├── docs/
│   ├── sys_doc/      # Current documentation (start here)
│   └── 01-…08-*.md   # Original docs, kept for history
└── server.py         # Small local server for the frontend (port 3000)
```

## Getting started

### Install

```bash
git clone https://github.com/tapel03/KagoVia.git
cd KagoVia
```

### Run the frontend

The frontend is static and uses demo data. Serve it locally:

```bash
python server.py
```

Then open http://localhost:3000/pages/index.html. You can also run `npx serve frontend`.

### Run the backend

Not runnable yet: the files in `backend/` are empty placeholders. When the v4 Fastify backend is added, follow [Local development](docs/sys_doc/06-operations/04-local-development.md). In short it needs:

- Node.js 22
- PostgreSQL (managed, with backups and point-in-time restore)
- Redis
- Your own Supabase Auth project (asymmetric JWT signing keys)
- Test-mode Paystack keys

### Environment variables

Copy `.env.example` to `.env` when the backend is added. **Never commit `.env`**. Keep it in `.gitignore`, and keep secrets in a server-side secret manager, never in JavaScript, git or logs ([Deployment](docs/sys_doc/06-operations/01-deployment.md)).

## Project status

From [Project status](docs/sys_doc/00-overview/01-project-status.md):

| Area | Status |
|------|--------|
| Frontend pages | Built with demo data (40 pages: landing, auth, dashboard, projects, AI design, materials, estimator, reports, suppliers, teams, settings, 19 admin pages) |
| Frontend API client | `frontend/scripts/api.js` is empty; pages are not yet wired to an API |
| Backend in this repo | Empty placeholder files |
| v4 Fastify backend | Written in the v4 package, not yet in this repo; not connected to real services |
| Database schema | Designed (v4 operational SQL with outbox table) |
| AI generation, SSE, outbox worker, payment reconciliation | Designed, not built |
| Data warehouse ETL | Runs on synthetic data |
| Load testing | Not done; all scale figures are planning assumptions |
| Documentation | Restructured into `docs/sys_doc` (2 Nov 2026); high-availability design added (5 Nov 2026) |

## Roadmap

From [System design v4 §8.1](docs/sys_doc/02-architecture/01-system-design-v4.md):

- **Phase A, secure foundation:** auth and PostgreSQL, schema, wire the frontend to the API, security tests.
- **Phase B, billing:** Paystack sandbox, webhooks, reconciliation, refunds.
- **Phase C, AI pipeline:** workers, geometry and quantity checks, SSE progress, AI quotas.
- **Phase D, marketplace and warehouse:** supplier imports, price provenance, analytics.
- **Phase E, scale evidence:** load tests at 100 / 1,000 / 10,000 users, failover drills, auto-scaling; split into services only when metrics support it.

**Product scope:**

- **MVP:** auth, design wizard, 3 AI layouts with rule validation, chat refinement, material take-off, regional prices from 3 or more suppliers, cost breakdown, budget gauge, PDF and CSV export.
- **Next:** supplier comparison, estimate history, teams, notifications, Excel BOQ.
- **Later:** site-photo upload, quote requests, price alerts, 3D view, more regions and countries.

## Important disclaimer

KagoBuild produces **concept designs and planning estimates only**. They are not engineer-certified drawings, quotations or contracts. Always verify dimensions and consult registered professionals before building.

## Contributing

1. Fork the repo and create a feature branch.
2. Keep to the design tokens in `frontend/styles/variables.css`. Do not add new hex colours.
3. Escape all dynamic HTML and never store secrets in `localStorage`.
4. If you change an architecture decision, update the [Decision register](docs/sys_doc/00-overview/02-decision-register.md) and the [CHANGELOG](docs/sys_doc/CHANGELOG.md).
5. Open a pull request with a clear description.

## License

Add your license here (for example MIT), or state that the project is proprietary.

## Contact

Maintained by [@tapel03](https://github.com/tapel03).
