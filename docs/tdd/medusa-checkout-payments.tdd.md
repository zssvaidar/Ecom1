# TDD — Medusa Checkout & Payments

Maps to: `docs-specs/04-payments.md`, `docs-specs/01-medusa-config.md` (regions/currency)
Process landscape ref: Process 1 (Order-to-Cash)

---

## Mocking Stripe: what actually works in this environment

This whole spec's fixture list calls for "mocked Stripe client" throughout — the right
call, since there's no real Stripe test-mode key available in Vault yet (`docs/specs/
14-env-secrets.md`). Two mocking approaches were tried and both failed for reasons
specific to this Medusa version, not to the test code:

- **`jest.mock("stripe")`** — has no effect. Medusa loads payment providers through its
  own dynamic-import loader (`@medusajs/utils/dist/common/dynamic-import.js`), which
  does not go through Jest's require-based module registry. Confirmed empirically: with
  a fake `STRIPE_SECRET_KEY` and this mock in place, the *real* Stripe SDK still ran and
  got a real 401 from `api.stripe.com`.
- **`nock` intercepting `https://api.stripe.com`** — nock patches Node's http/https
  layer directly, underneath the loader, so in principle it should work regardless of
  how the SDK got loaded. In practice, both test cases (and the suite's own shutdown)
  hung to a 60s+ timeout instead of hitting the interceptor or failing fast. Not
  chased further than confirming it wasn't a quick fix — an actively-hanging test is
  worse than no test, so it was removed rather than landed half-working.

Net effect: **currency-correct payment session creation (cases 1-2 below) is not
covered by an automated test yet.** The conditional Stripe provider registration in
`medusa-config.ts` (only registers `@medusajs/payment-stripe` when `STRIPE_SECRET_KEY`
is set, so `medusa develop`/`build`/tests don't break without one) is written and
confirmed not to regress anything when the key is absent — that part is verified. The
currency-conversion logic itself (`getSmallestUnit` in `@medusajs/payment-stripe`,
confirmed to multiply by 100 for USD and by 1 for JPY) is vendor code, not something
this repo owns, so the honest path forward is real Stripe test-mode credentials in a
real (non-sandboxed) environment, not more mocking attempts here.

---

## Unit under test: Currency-correct payment session creation

**Test cases**

1. `Given` a cart in the Brand A (USD) region
   `When` a Stripe payment session is created
   `Then` the session currency is `usd` and the amount matches the cart total in cents

2. `Given` a cart in the Brand B (JPY) region
   `When` a Stripe payment session is created
   `Then` the session currency is `jpy` and the amount matches the cart total in the
   correct JPY unit (no decimal subunits, per Stripe's zero-decimal currency handling)

**Fixtures needed:** mocked Stripe client; seeded carts in each region

---

## Unit under test: Payment success flow

**Test cases**

3. `Given` a completed cart with a successful `payment_intent.succeeded` webhook
   `Then` the order is marked paid and proceeds into the order-placed flow (which in turn
   triggers the Twenty sync — covered in `integration-webhooks.tdd.md`, not re-tested here)

4. `Given` a Stripe webhook with a valid signature
   `Then` it is processed
   `Given` a Stripe webhook with an invalid/missing signature
   `Then` it is rejected with no order state change

**Fixtures needed:** mocked Stripe webhook payloads (valid and tampered), mocked
signature verification

---

## Unit under test: Payment failure flow

**Test cases**

5. `Given` a `payment_intent.payment_failed` webhook for an in-progress checkout
   `Then` the cart is preserved (not deleted or emptied) and the customer-facing error
   state is set so the storefront can show a retry path

6. `Given` a customer retries payment after a failure
   `When` the retry succeeds
   `Then` exactly one order is created (no duplicate order from the failed attempt)

**Fixtures needed:** mocked failed-then-succeeded Stripe payment intent sequence

---

## Unit under test: Refunds

**Test cases**

7. `Given` an order originally charged in JPY
   `When` a full refund is issued
   `Then` the Stripe refund request uses the original charge's currency and amount

8. `Given` a partial return (see `medusa-customer-returns.tdd.md` for the return-side
   logic)
   `When` the associated refund is issued
   `Then` only the returned line items' value is refunded, not the full order total

**Fixtures needed:** mocked Stripe refund API; seeded order with multiple line items

---

## Out of scope for this TDD spec
- Return/restock logic itself (see `medusa-customer-returns.tdd.md`)
- Twenty sync triggered by order placement (see `integration-webhooks.tdd.md`)
- Discount/gift-card amount calculation (separate TDD coverage if this spec set is
  extended — flag if you want `medusa-discounts-giftcards.tdd.md` added)
