# Functional Requirements — Master List

Every functionality the project needs, grouped by module, with what each one requires to
be built. "Requires" includes upstream functionality, external accounts/services, and data
that must exist first — use it to sequence work correctly.

---

## A. Medusa core commerce

| # | Functionality | Description | Requires |
|---|---|---|---|
| A1 | Two sales channels | `brand-a` / `brand-b` channels, each with its own publishable API key | Medusa instance running; Vault entry per key |
| A2 | Regions & currency | US/USD region on `brand-a`, JP/JPY region on `brand-b` | A1 |
| A3 | Product catalog | Products, variants, categories, brand-exclusive vs cross-listed assignment | A1; product data/import source |
| A4 | Shared inventory | Single inventory location, stock linked across both channels' variants where SKUs overlap | A3; inventory counts from client |
| A5 | Cart & checkout | Add to cart, cart totals, address capture, order placement | A2, A3, A4 |
| A6 | Stripe payments | Payment session, capture, JPY + USD support | A5; Stripe account + API keys in Vault |
| A7 | Discounts | Percentage/fixed discounts, per-channel or global | A3 |
| A8 | Gift cards | Issue, redeem, balance tracking | A6 |
| A9 | Customer accounts | Shared login across both storefronts, single customer record | A1; auth strategy decision (email/password vs magic link) |
| A10 | Returns & refunds | Return request, approval, restock to shared pool, Stripe refund | A4, A6, A9 |
| A11 | Tax calculation | US sales tax, JP consumption tax (10%, tax-inclusive) | A2; tax provider or rate table config |
| A12 | Admin roles | `admin`, `brand-a-staff`, `brand-b-staff` scoped views | A1 |

---

## B. Twenty CRM

| # | Functionality | Description | Requires |
|---|---|---|---|
| B1 | Unified Person object | One CRM contact per customer, linked to orders from both brands | Twenty instance running; email as dedupe key |
| B2 | Shipment/task object (custom) | Custom Twenty object holding address, method, cost, status, tracking, shipment record | Twenty admin access to define custom objects |
| B3 | Staff fulfillment workflow | UI/process for staff to move a task from "new" → "shipped," enter tracking | B1, B2 |
| B4 | Person ↔ Order relation | Link each incoming order to the correct Person, across brands | B1; customer upsert logic (see C2) |

---

## C. Medusa ↔ Twenty integration

| # | Functionality | Description | Requires |
|---|---|---|---|
| C1 | Outbound webhook: order placed | Fires on `order.placed`, sends order + customer payload to Twenty | A5, A9, B1, B2; Medusa event subscriber |
| C2 | Customer upsert on order | Twenty-side handler that creates/updates a Person by email, avoiding duplicates | B1, C1 |
| C3 | Shipping task creation | Twenty-side handler that creates a task record from the order payload | B2, C1 |
| C4 | Inbound webhook: fulfillment update | Twenty → Medusa call when staff marks shipped/enters tracking | B3; Medusa endpoint that accepts fulfillment-only fields |
| C5 | Write-back scope guard | Enforce that inbound updates touch only fulfillment/tracking, never order totals/payment/status | C4 |
| C6 | Retry queue | Redis-backed queue that retries failed Medusa → Twenty webhook deliveries | Redis running; C1 |
| C7 | Idempotency keys | Prevent duplicate task/contact creation on webhook redelivery | C1, C3, C6 |
| C8 | Webhook auth | Signed/authenticated webhooks both directions so endpoints can't be spoofed | C1, C4; shared secret in Vault |

---

## D. Frontend

| # | Functionality | Description | Requires |
|---|---|---|---|
| D1 | Brand A storefront (Next.js) | Product browsing, cart, checkout, account, order history | A1–A9 exposed via Medusa Store API |
| D2 | Brand B storefront (Next.js) | Same feature set, separate app/deploy/domain | A1–A9; D1 as reference implementation |
| D3 | Shared auth/session | Customer logs in once, session recognized on both storefronts | A9; shared cookie/session domain or token strategy decision |
| D4 | Order history across brands | Customer sees orders from both brands in one account view | D3, A9 |

---

## E. Infrastructure

| # | Functionality | Description | Requires |
|---|---|---|---|
| E1 | Docker Compose stack | Brings up Medusa, Postgres, Redis, Twenty, both frontends locally | Dockerfiles for each service |
| E2 | Vault secret management | All API keys/tokens (Stripe, Twenty, publishable keys, webhook secrets) stored and injected at runtime | Vault instance/access from prior project |
| E3 | CI pipeline | Lint, typecheck, run unit + TDD suites on PR | Repo structure finalized; E1 for integration tests |
| E4 | CD to staging/prod | Single-environment deploy (portfolio-scoped, no blue-green) | E3 |
| E5 | Logging & monitoring | Structured logs, error tracking, webhook delivery visibility | E1; log aggregation choice (e.g., self-hosted or hosted tier) |
| E6 | Error handling & retry policy | Consistent retry/backoff rules applied across C6 and webhook auth failures | C6 |

---

## Build-order note

Rough dependency chain: **A1–A4 → A5–A9 (+B1–B4 in parallel) → C1–C8 → D1–D4 → E3–E6**,
with E1 (Docker) and E2 (Vault) needed from day one since almost everything else depends on
having a running stack and a place to put secrets.
