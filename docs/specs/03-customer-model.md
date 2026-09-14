# 03 — Customer Model Spec

## Purpose
Define how a single customer identity works across two storefronts, and how that identity
maps into Twenty CRM.

## Identity model

- One Medusa customer record per person, keyed by email, not scoped to a sales channel.
- A customer who signs up on Brand A can log into Brand B with the same credentials and
  sees their combined order history from both brands in one account view.
- No separate "brand A customer" vs "brand B customer" concept — a single `customer_id`
  is associated with orders tagged to whichever channel they were placed on.

## Auth strategy

- Standard Medusa customer auth (email/password) issued from the backend, shared across
  both Next.js apps since they hit the same Medusa instance.
- Session/token handling: each storefront calls the same Medusa Store API with its own
  publishable key, but authenticates the *customer* against the same customer record —
  the publishable key scopes the channel context (pricing, catalog), not the identity.
- Decision needed before build: cookie-based session per app domain (would require a
  shared parent domain or token relay) vs. JWT stored client-side and reusable across both
  app origins. **Recommendation: JWT-based**, since Brand A and Brand B are likely on
  fully separate domains with no shared parent — cookies won't travel between them cleanly.

## Cross-brand order history

- Account/order-history page on either storefront queries orders by `customer_id`, not by
  sales channel, so both brands' purchases show up together.
- Each order retains its `sales_channel_id` so the UI can still show "Ordered from Brand A"
  as metadata even in the (rare) case a customer viewing Brand B's account page sees a
  Brand A order.

## Mapping to Twenty CRM

- On first order (from either brand), Medusa upserts a Twenty Person keyed by the same
  email used for the Medusa customer record — see `07-twenty-data-model.md` and
  `08-integration-webhooks.md` for the sync mechanics.
- This spec only asserts the invariant: **one email → one Medusa customer → one Twenty
  Person**, regardless of which brand the customer first purchased from.

## Open questions
- Confirm JWT vs. shared-domain-cookie approach before frontend build starts (see
  Recommendation above) — flag if you want cookies and a shared parent domain instead.

## Done means
- [ ] Signing up on Brand A allows login on Brand B with the same credentials
- [ ] Order history page on either app shows orders from both brands
- [ ] Only one Twenty Person is created regardless of which brand a customer orders from
      first or subsequently
- [ ] Auth token/session approach is implemented and documented in `11-auth-security.md`
