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
- [x] Seed script (`apps/backend/src/migration-scripts/initial-data-seed.ts`), run
      automatically and exactly once by `medusa db:migrate`: two sales channels (Brand
      A, Brand B) with a publishable key each, two regions (US/USD, JP/JPY), US+JP tax
      regions, one shared `Main Warehouse` stock location linked to both channels, and a
      cross-listed demo product priced in both currencies. **Verified against a real
      local Postgres** — ran clean end to end. There is no separate `seed` command; see
      `AGENTS.md`'s Database section for why one must not be added back.
- [x] Integration test (`apps/backend/integration-tests/http/catalog-channels.spec.ts`)
      covering TDD cases 1–2 from `docs/tdd/medusa-catalog.tdd.md`: a single-channel
      product doesn't leak into the other brand's `/store/products`, a cross-listed
      product appears under both. **Passing against a real local Postgres.** Caught a
      real gap along the way: the test runner's ephemeral database only runs schema
      migrations, not `src/migration-scripts/` — so unlike a real dev DB, no default
      shipping profile exists yet; the test creates one directly instead of assuming it.
      TDD case 3 (price-by-region/currency) and the concurrency/oversell cases (7–8) are
      not covered yet.
- [ ] Product/variant catalog beyond the one demo product
- [ ] Admin roles scoped by sales channel — Medusa v2 doesn't have a built-in per-channel
      admin role; revisit whether this needs a custom module or is just an Admin UI
      convention (filtering, not enforcement)

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
