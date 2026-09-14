# 05 — Discounts & Gift Cards Spec

## Purpose
Define discount and gift-card behavior across two brands sharing one backend.

## Discounts

- Standard Medusa discount module: percentage or fixed-amount, applied via code at
  checkout or automatically to qualifying carts.
- Scope per discount:
  - **Channel-scoped** — valid on one brand only (e.g., a Brand A launch promo)
  - **Global** — valid on both brands (e.g., a company-wide sale)
- Discount scope is set at creation time via sales-channel association, using Medusa's
  existing channel-restriction capability — no custom logic required.
- Currency-aware: a fixed-amount discount must be defined per currency (USD amount for
  Brand A, JPY amount for Brand B) since the two brands' regions use different currencies;
  percentage discounts apply uniformly regardless of currency.

## Gift cards

**Not implementable as written on this Medusa version.** Medusa v2 (2.21.0, what this
repo runs) has no gift-card module — no `@medusajs/gift-card` package, no gift-card
entry in the module registry, no gift-card API routes. The only remnant is a vestigial
`is_giftcard` boolean on the product model with no balance, redemption, or
currency-locking logic behind it. Everything below describes Medusa v1 gift-card
behavior that does not exist in this stack; see `docs/tdd/medusa-discounts-
giftcards.tdd.md` for the decision this blocks on (scope gift cards out, or design a
custom module) before writing any gift-card code against this section.

- Issued in a single currency at creation (matching the region/brand they were purchased
  on), redeemable only within that currency's region — a USD gift card can't be redeemed
  on the JPY-priced Brand B storefront and vice versa, since Medusa gift card balances are
  currency-specific.
- Balance tracking, partial redemption, and expiry follow Medusa's built-in gift card
  behavior.
- If cross-brand gift cards become a requirement later, that would need a custom
  currency-conversion layer — explicitly out of scope for now.

## Admin

- Staff can create/void discounts and gift cards scoped to their brand (per the
  `brand-a-staff` / `brand-b-staff` roles from `01-medusa-config.md`); global discounts
  require `admin` role.

## Open questions
- **Gift cards have no module to build on in Medusa v2** (see above) — decide whether
  to (a) drop gift cards from project scope, or (b) treat them as a custom module with
  its own spec (data model, redemption workflow, storefront UI). Nothing gift-card-
  related should be built until this is decided; the cross-brand-redemption question
  originally asked here is moot until then.

## Done means
- [x] A channel-scoped discount applies only on its brand's storefront — verified in
      `apps/backend/integration-tests/http/discounts.spec.ts`
- [x] A global discount applies correctly on both storefronts, in each one's currency —
      verified in the same test file
- [ ] Gift card purchased on Brand A cannot be redeemed on Brand B — blocked on the open
      question above, not attempted
- [ ] Staff role restrictions enforced for discount/gift-card creation — blocked on the
      same per-channel-admin-role gap noted in `01-medusa-config.md`
