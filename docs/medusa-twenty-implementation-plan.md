# Medusa v2 + Twenty CRM — Implementation Plan

All open questions (7–24) are now confirmed based on your answers.

## Confirmed answers

| # | Question | Decision |
|---|----------|-----------------|
| 7 | Architecture | One Medusa backend, two sales channels/stores. |
| 8 | Shared inventory | **Shared stock pool** — both brands draw from the same inventory items; a sale on Brand A decrements stock visible to Brand B. |
| 9 | Orders in one Admin | Yes — one Admin, filtered by sales channel. |
| 10 | Payment provider | Stripe. |
| 11 | Currency selection | Store/domain-determined. |
| 12 | Twenty owns | All six: address, method, cost, fulfillment status, tracking, shipment creation. |
| 13 | Auto shipping task | Yes, via webhook on `order.placed`. |
| 14 | Twenty writes back to Medusa | **Fulfillment/tracking fields only** (recommended) — Twenty can mark shipped, attach tracking, update fulfillment status, but never touches order totals, payment state, or order status directly. Keeps Medusa as the single source of truth for the order lifecycle. |
| 15 | Unified CRM contact | Yes — one Twenty Person per customer, linked to both stores' orders. |
| 16 | Shared login | Shared account across both storefronts. |
| 17 | Sync direction | Bidirectional (Medusa ↔ Twenty), scoped per #14. |
| 18 | Real-time webhooks | **Yes** (recommended) — Medusa v2's event bus makes this natural, and it's the more instructive/demonstrable pattern for a portfolio project vs. polling. |
| 19 | Twenty down | Order completes regardless; sync event queued and retried. |
| 20 | Docker Compose | Yes. |
| 21 | Vault for secrets | Yes, reuse existing Vault. |
| 22 | Frontend | **Separate Next.js app per brand** — independent deploys/domains, brand-specific UX, both hitting the same Medusa backend via different sales-channel API keys. |
| 23 | Project type | **Portfolio/learning project** — architecture and specs stay production-quality (it's the point of the portfolio), but infra rigor (load testing, on-call runbooks, blue-green deploys) is scoped down to what's reasonable to actually build and demo. |
| 24 | Spec coverage | Yes to all 20 items — see spec design below. |

---

## Phases and functionality

**Phase 0 — Foundations**
- Repo/monorepo layout, Docker Compose skeleton (Postgres, Redis, Medusa, Twenty, frontend)
- Vault wiring for secrets, `.env` templates
- CI pipeline skeleton (lint, typecheck, test on PR)

**Phase 1 — Medusa core commerce**
- Two sales channels (Brand A, Brand B), region/currency setup (JPY, USD)
- Product/variant catalog per brand, categories, pricing per currency
- Shared inventory location(s) — single stock pool, both sales channels linked to the same inventory items, reservations tested for double-sell scenarios
- Admin access and roles

**Phase 2 — Payments & checkout**
- Stripe integration for both currencies
- Cart, checkout, order placement flows
- Discounts and gift cards

**Phase 3 — Customer & post-purchase**
- Shared customer accounts across both storefronts
- Returns/refunds workflow
- Tax configuration (JP consumption tax, US sales tax as applicable)

**Phase 4 — Twenty CRM data model**
- Person/Company objects for customers, custom objects for Shipment/Fulfillment task
- Relations: Person ↔ Orders (from both brands), Shipment ↔ Order

**Phase 5 — Medusa ↔ Twenty integration**
- Outbound webhook: `order.placed` → create Twenty shipping task + upsert unified Person by email
- Inbound webhook: Twenty fulfillment/tracking update → Medusa fulfillment update (scope-limited, never touches payment/order totals)
- Retry queue (Redis-backed) for when Twenty is unreachable; order always completes on the Medusa side
- Idempotency keys to prevent duplicate task/order creation on webhook redelivery

**Phase 6 — Frontend**
- Two Next.js apps (one per brand), each pointed at its own sales channel/API key on the shared Medusa backend
- Product listing/detail, cart, checkout, account, order history — account/session shared across both apps (single customer identity)

**Phase 7 — Hardening & launch (portfolio-scoped)**
- Logging/monitoring (structured logs, error tracking, webhook delivery visibility)
- CI/CD to staging/prod (single-environment deploy is fine — skip blue-green/rolling)
- Basic secrets rotation via Vault; skip formal load testing and on-call runbooks unless you want to demo them specifically

---

## Suggested spec document design

A `docs/specs/` folder, one file per concern, so each can evolve independently:

```
docs/specs/
  00-architecture.md          # system diagram, service boundaries, data flow
  01-medusa-config.md         # sales channels, regions, currencies, tax setup
  02-catalog-inventory.md     # products, variants, stock model
  03-customer-model.md        # shared identity, auth across brands
  04-payments.md              # Stripe integration, currency handling
  05-discounts-giftcards.md
  06-returns.md
  07-twenty-data-model.md     # CRM objects, relations
  08-integration-webhooks.md  # event contracts, retry/idempotency rules
  09-shipping-workflow.md     # end-to-end sequence diagram, states
  10-api-spec.md              # REST/webhook payload schemas (OpenAPI where practical)
  11-auth-security.md
  12-database-design.md       # Medusa schema deltas, Twenty custom fields
  13-infra-docker-compose.md
  14-env-secrets.md           # Vault paths, rotation policy
  15-cicd.md
  16-error-handling-retries.md
  17-logging-monitoring.md
  18-folder-structure.md
  19-milestones.md            # maps to phases above, with acceptance criteria
```

Each spec should be short and scannable: purpose, decisions made, open questions, and a
"done means" checklist — not prose essays.

---

## Separate TDD specs

Kept apart from the design specs above, in `docs/tdd/`, one per testable module, mirroring
the phases so tests can be written before the corresponding code:

```
docs/tdd/
  medusa-catalog.tdd.md
  medusa-checkout-payments.tdd.md
  medusa-customer-returns.tdd.md
  twenty-data-model.tdd.md
  integration-webhooks.tdd.md     # includes Twenty-down / retry scenarios
  shipping-workflow.e2e.tdd.md    # full order→ship→fulfilled loop
  frontend-checkout.tdd.md
```

Each TDD spec follows the same template:
- **Unit under test** (function/service/endpoint)
- **Test cases** as Given/When/Then, including edge cases (e.g., Twenty unreachable, duplicate
  webhook delivery, currency mismatch, out-of-stock at checkout)
- **Fixtures/mocks needed** (e.g., mocked Stripe, mocked Twenty webhook receiver)
- Tests are written and committed *before* the implementation for that module, per phase.

---

Want me to draft the actual content of specs `00` and `01` (architecture + Medusa config) next, or the full `docs/tdd/integration-webhooks.tdd.md` first since that's the highest-risk piece?
