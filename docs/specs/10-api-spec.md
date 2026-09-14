# 10 — API Spec

## Purpose
Enumerate the API surface the frontends, staff, and Twenty integration rely on — standard
Medusa endpoints used as-is, plus the custom endpoints this project adds.

## Medusa Store API (used by both storefronts, standard — not modified)

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /store/products` | Catalog listing, filtered by sales channel via publishable key | Publishable API key (per brand) |
| `GET /store/products/:id` | Product detail | Publishable API key |
| `POST /store/carts` | Create cart | Publishable API key |
| `POST /store/carts/:id/line-items` | Add to cart | Publishable API key |
| `POST /store/carts/:id/complete` | Place order (after payment session) | Publishable API key + customer session |
| `POST /store/customers` | Register | Publishable API key |
| `POST /store/auth` | Login, issues JWT | Publishable API key |
| `GET /store/customers/me/orders` | Cross-brand order history (per `03-customer-model.md`) | Customer JWT |
| `POST /store/returns` | Initiate return | Customer JWT |

## Medusa Admin API (staff, standard — not modified)

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /admin/orders` | Order list, filterable by sales_channel_id | Admin session, role-scoped per `01-medusa-config.md` |
| `POST /admin/discounts` | Create discount | Admin session |
| `POST /admin/gift-cards` | Issue gift card | Admin session |
| `POST /admin/returns/:id/receive` | Mark return received, trigger restock | Admin session |

## Custom endpoints (this project adds)

| Endpoint | Direction | Purpose | Spec reference |
|---|---|---|---|
| `POST /webhooks/twenty/fulfillment` | Twenty → Medusa | Receives fulfillment status + tracking updates | `08-integration-webhooks.md` |
| (Twenty-side) Order webhook receiver | Medusa → Twenty | Receives `order.placed` payload, creates Person + Task | `08-integration-webhooks.md`, `07-twenty-data-model.md` |
| `POST /webhooks/stripe` | Stripe → Medusa | Standard Stripe plugin webhook (payment/refund events) | `04-payments.md` |

## Request/response conventions

- All custom endpoints use JSON, HMAC-signed per `08-integration-webhooks.md`
- Errors follow a consistent shape: `{ "error": { "code": "...", "message": "..." } }`
- Idempotency: custom endpoints accept and honor an `idempotency_key` field where
  applicable (order sync, fulfillment updates)

## Out of scope for a formal OpenAPI doc
Medusa's own Store/Admin APIs are already documented upstream — this spec only formalizes
the *custom* surface (the two webhook endpoints) with a full OpenAPI schema, kept alongside
this file as `10-api-spec.openapi.yaml` once implementation starts.

## Open questions
None.

## Done means
- [ ] `POST /webhooks/twenty/fulfillment` documented with full request/response schema in
      the companion OpenAPI file
- [ ] Twenty-side order receiver documented the same way (even though it lives outside
      this repo, the contract needs to be pinned down for both teams/tools to agree on)
- [ ] Error response shape is consistent across all custom endpoints
