# 04 — Payments Spec

## Purpose
Define how Stripe is integrated for both currencies, and the payment lifecycle for
one-off orders and subscriptions.

## Provider setup

- Single Stripe account, both JPY and USD enabled (Stripe supports both natively — no
  separate account per brand needed).
- Medusa's Stripe plugin handles payment sessions; one plugin instance configured, region
  determines which currency a given payment session is created in.
- API keys (publishable + secret) stored in Vault, injected at runtime — never committed.

## Payment flow (one-off order)

1. Checkout creates a Stripe payment session in the cart's region currency
2. Customer completes payment via Stripe Elements (embedded in each storefront)
3. Stripe webhook (`payment_intent.succeeded`) confirms capture
4. Medusa marks the order as paid, proceeds to Order-to-Cash process (see process landscape)
5. Failed/declined payment surfaces inline at checkout; cart is preserved for retry

## Currency handling

- Currency is fixed by region/channel (per `01-medusa-config.md`) — Stripe payment session
  is always created in the correct currency automatically, no runtime currency selection
  logic needed.
- Refunds (see `06-returns-subscriptions.md`) are issued in the same currency as the
  original charge — Stripe handles this natively.

## Webhooks required from Stripe

| Event | Handler action |
|---|---|
| `payment_intent.succeeded` | Mark order paid |
| `payment_intent.payment_failed` | Surface failure at checkout, cart preserved for retry |
| `charge.refunded` | Confirm refund completion, sync to order + CRM record |

## Security

- Stripe webhook signature verification required on the receiving endpoint (see
  `11-auth-security.md`)
- No card data ever touches Medusa or the storefronts directly — Stripe Elements handles
  PCI scope

## Open questions
None — Stripe's native multi-currency support removes the need for any custom
currency-conversion logic.

## Done means
- [ ] Test payment succeeds end-to-end in both USD (Brand A) and JPY (Brand B)
- [ ] Failed payment leaves cart intact and shows a retry path
- [ ] Stripe webhook signature verification rejects unsigned/forged requests
- [ ] Refund on a returned order correctly issues in the original charge currency
