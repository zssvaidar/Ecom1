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
- Confirm gift cards should NOT be cross-brand redeemable (assumed above) — flag if you
  want a shared gift-card balance across both brands, which would need custom work.

## Done means
- [ ] A channel-scoped discount applies only on its brand's storefront
- [ ] A global discount applies correctly on both storefronts, in each one's currency
- [ ] Gift card purchased on Brand A cannot be redeemed on Brand B (unless overridden per
      the open question above)
- [ ] Staff role restrictions enforced for discount/gift-card creation
