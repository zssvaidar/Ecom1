# TDD — Medusa Discounts & Gift Cards

Maps to: `docs/specs/05-discounts-giftcards.md`, `docs/specs/01-medusa-config.md`
(regions/currency)

Write these tests first, watch them fail, then implement against
`05-discounts-giftcards.md` until they pass.

---

## Gift cards: scope note before writing tests

`docs/specs/05-discounts-giftcards.md` describes gift cards with a redeemable balance,
partial redemption, and currency-locked redemption — that's Medusa v1's gift card
system. **Medusa v2 (2.21.0, what this repo runs) has no gift-card module.** There is
only a vestigial `is_giftcard` boolean on the product model with no balance, redemption,
or currency-locking logic behind it (confirmed: no `@medusajs/gift-card` package, no
gift-card entry in `Modules`, no gift-card API routes under `/store` or `/admin`).

This means the gift-card half of `05-discounts-giftcards.md` cannot be implemented as
written without building a custom module (its own data model, redemption workflow, and
storefront UI) — a materially larger unit of work than "configure Medusa's existing
gift card behavior." Flagging as an open question rather than silently skipping: either
(a) scope gift cards out of this project, or (b) treat them as a custom module to design
separately, with its own spec. No test cases are written below for gift cards until
that's decided.

---

## Unit under test: Discount scope (channel-scoped vs global)

**Test cases**

1. `Given` a percentage discount promotion with a rule restricting it to Brand A's sales
   channel
   `When` the code is applied to a cart on Brand A
   `Then` the discount is applied and the cart total reflects the percentage off

2. `Given` the same Brand-A-scoped promotion
   `When` the code is applied to a cart on Brand B
   `Then` the discount is not applied (rule doesn't match) — the code is either rejected
   or applied with zero effect, but the cart total must be unchanged

3. `Given` a percentage discount promotion with no sales-channel rule (global)
   `When` the code is applied to a cart on Brand A (USD) and separately to a cart on
   Brand B (JPY)
   `Then` it applies on both, each computing its percentage against that cart's own
   currency total — no cross-currency conversion involved since percentage discounts
   are currency-agnostic by construction

**Fixtures needed:** two sales channels, two regions/carts (one per brand), a
channel-scoped promotion, a global promotion

---

## Unit under test: Currency-locked fixed-amount discounts

**Test cases**

4. `Given` a fixed-amount discount promotion created with `currency_code: "usd"`
   `When` applied to a Brand A (USD) cart
   `Then` the cart total drops by exactly that fixed amount

5. `Given` the same USD fixed-amount promotion
   `When` applied to a Brand B (JPY) cart
   `Then` the discount does not apply — a fixed amount in one currency cannot be
   applied to a cart in a different currency (this is also why `05-discounts-
   giftcards.md`'s "global fixed-amount discount" scenario doesn't hold for the `fixed`
   application-method type: a single `CreateApplicationMethodDTO` has exactly one
   `currency_code`, so a truly global fixed discount needs one promotion per currency,
   not one promotion valid everywhere)

**Fixtures needed:** a fixed-amount promotion in one currency, carts in both regions

---

## Out of scope for this TDD spec
- Gift cards (see scope note above — blocked on a decision, not on test-writing)
- Staff role restrictions on discount/gift-card creation (`05-discounts-giftcards.md`'s
  Admin section) — Medusa v2 doesn't have built-in per-sales-channel admin roles either
  (noted already in `docs/specs/01-medusa-config.md`); same open question applies here
- Discount usage limits, expiry dates, and campaign grouping — standard Medusa
  behavior, not brand/currency-specific, so not singled out for this project's TDD
  coverage
