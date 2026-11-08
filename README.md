# Multi-tenant E-commerce Platform — Backend

Express 5 · Mongoose 9 · MongoDB 8 · Redis + BullMQ · Zod 4 · TypeScript 6 · Node.js 24/26 LTS

One API serves every store. Each store (tenant) is isolated by a `tenantId` that is added to **every** database query automatically.

## Quick start (local)

```bash
cp .env.example .env              # set secrets (openssl rand -hex 32)
docker compose up -d mongo redis  # MongoDB replica set + Redis
npm install
npm run seed -- --demo            # super-admin + demo store + products
npm run dev                       # API on :4000
npm run dev:worker                # background jobs (notifications, billing, expiries)
```

Demo logins: store owner `demo@store.test` / `DemoStore!123`, super-admin from `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` in `.env`.
The demo store answers on `demo.<PLATFORM_DOMAIN>` and on `localhost` (for the storefront dev server).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `npm run dev:worker` | API / worker with reload |
| `npm test` | Unit tests + tenant-isolation tests (set `MONGO_URL_TEST` to run the DB tests) |
| `npm run typecheck` / `npm run lint` | Type and lint checks |
| `npm run openapi` | Writes `openapi/openapi.json` – the contract the frontend repo generates its client from |
| `npm run build && npm start` | Production build and start (`npm run start:worker` for the worker) |

## Layout

```
src/
  app.ts, server.ts, worker.ts
  config/env.ts            env validation
  db/tenantPlugin.ts       ★ automatic tenant isolation (query without tenant context throws)
  db/tenantContext.ts      AsyncLocalStorage; runAsTenant / runWithoutTenant(reason)
  http/route.ts            Zod-validated routes that also register OpenAPI docs
  middleware/guards.ts     merchant / owner / platform / storefront / customer auth
  models/                  platform (global), catalog, people, orders, billing
  services/                pricing & GST, orders lifecycle, commission, statements, PDF invoices
  modules/                 route modules (auth, admin/*, store, platform, webhooks, feeds, internal)
  integrations/            payments (Cashfree, Razorpay), shipping (Shiprocket; Delhivery stub), notifications, S3, Meta CAPI
  jobs/                    queues + processors (notifications, expiry, monthly billing, dunning, domain health)
deploy/Caddyfile           automatic HTTPS for platform + verified client domains
```

## How the pieces fit

- **Storefront traffic** reaches `/api/v1/store/*` only through the storefront SSR server, which adds `x-internal-secret` and `x-store-host`. The host is mapped to a tenant (cached in Redis).
- **Admin traffic** uses a 15-minute access token (Bearer) + 30-day refresh cookie. Merchant tokens carry `tenantId`; super-admin requests run with an explicit, audited cross-tenant bypass.
- **Payments (Model A)**: each merchant connects their own Cashfree or Razorpay keys (AES-256-GCM encrypted). Money settles directly to them. Webhooks are signature-verified and idempotent. The platform's 3% is accrued per confirmed order and invoiced monthly with 18% GST.
- **Shipping**: each merchant connects their own Shiprocket API user; COD remittance goes to them. Tracking webhooks move orders to shipped / delivered / RTO.
- **Custom domains**: TXT verification → Caddy asks `/internal/caddy/ask` before issuing a certificate.

## Before going live (needs your accounts)

| Item | Where |
|---|---|
| Cashfree / Razorpay merchant accounts (per client) | Admin → Payments & shipping |
| Shiprocket API user (per client) | Admin → Payments & shipping |
| SMS (DLT templates) + WhatsApp Business API provider | `src/integrations/notifications` – currently logs messages |
| SMTP for email | `.env` – currently logs emails |
| S3 / Cloudflare R2 bucket for images | `.env` |
| Auto-debit mandates for commission | record in super-admin; provider integration is a TODO in `jobs/processors.ts` (`dunning`) |
| Delhivery direct | `integrations/shipping/delhivery.ts` (Phase 5) |
| CA sign-off on GST/TCS treatment | — |

Verify Cashfree / Shiprocket field names against their current API docs when you enable live keys; versions are configurable in `.env`.
