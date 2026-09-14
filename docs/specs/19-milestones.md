# 19 — Milestones

Maps to the phases in `medusa-twenty-implementation-plan.md`. Checked items are verified
working in this repo; unchecked items are scoped but not yet built.

## Phase 0 — Foundations
- [x] Monorepo layout: `apps/backend` (Medusa v2), `apps/storefront-brand-a`,
      `apps/storefront-brand-b` (Next.js), npm workspaces + Turborepo
- [x] `docs/` and `infra/` committed
- [x] `.env.example` (non-secret defaults) and per-app `.env.template` files
- [x] Docker Compose skeleton: Postgres, Redis, backend, both storefronts
- [x] CI pipeline skeleton (GitHub Actions: lint all apps, backend unit tests, backend
      build) — see `18-folder-structure.md` for why this differs from `15-cicd.md`'s
      GitLab/Jenkins. Storefronts are linted but not production-built in CI yet: their
      `next build` statically renders pages that fetch from a live Medusa backend, so a
      real build needs a running, seeded backend — revisit once Phase 1 gives CI one.
- [ ] Vault wiring (no Vault instance available in this environment; secret inventory in
      `14-env-secrets.md` is the contract to wire up against a real Vault later)

## Phase 1 — Medusa core commerce
- [ ] Two sales channels (`brand-a`, `brand-b`) + two regions (US/USD, JP/JPY)
- [ ] Product/variant catalog per brand, shared inventory location
- [ ] Admin roles scoped by sales channel

## Phase 2 — Payments & checkout
- [ ] Stripe integration for both currencies
- [ ] Discounts and gift cards

## Phase 3 — Customer & post-purchase
- [ ] Shared customer accounts across both storefronts
- [ ] Returns/refunds workflow
- [ ] Tax configuration (JP consumption tax, US sales tax)

## Phase 4 — Twenty CRM data model
- [ ] Twenty added to the stack (self-hosted service or Cloud reference)
- [ ] Person/Company objects, Shipment/Fulfillment custom object

## Phase 5 — Medusa ↔ Twenty integration
- [ ] Outbound `order.placed` webhook + customer upsert
- [ ] Inbound fulfillment/tracking webhook
- [ ] Redis-backed retry queue, idempotency keys

## Phase 6 — Frontend
- [x] Two Next.js apps scaffolded, each on its own port, own `.env.template`
- [ ] Storefronts wired to real sales-channel publishable keys once Phase 1 creates them
- [ ] Shared account/session across both apps

## Phase 7 — Hardening & launch
- [ ] Logging/monitoring
- [ ] CI/CD to staging/prod
- [ ] Secrets rotation via Vault
