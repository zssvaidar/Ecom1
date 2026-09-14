# TDD — Customer Identity & Returns

Maps to: `docs-specs/03-customer-model.md`, `docs-specs/06-returns.md`
Process landscape ref: Process 4 (Customer Identity & CRM Sync), Process 5 (Returns & Refunds)

---

## Unit under test: Shared customer identity

**Test cases**

1. `Given` a customer registers on Brand A with email `jane@example.com`
   `When` she logs in on Brand B with the same credentials
   `Then` authentication succeeds against the same customer record (no duplicate
   customer created)

2. `Given` a logged-in customer with orders on both Brand A and Brand B
   `When` she views order history on either storefront
   `Then` both brands' orders appear, each tagged with its originating `sales_channel_id`

3. `Given` a customer who has never ordered from Brand B
   `When` she logs into Brand B for the first time
   `Then` her account is recognized (not treated as a new signup) and her Brand A order
   history is visible there too

**Fixtures needed:** seeded customer with orders on both channels; JWT issuance/validation
mocked or run against a real short-lived token

---

## Unit under test: Auth token portability across domains

**Test cases**

4. `Given` a JWT issued by Brand A's storefront
   `When` presented to Brand B's storefront (different origin)
   `Then` it is accepted, since both call the same Medusa backend and identity is not
   domain-scoped

5. `Given` an expired JWT
   `When` a request is made with it
   `Then` it is rejected and the refresh flow is triggered (not a silent failure)

**Fixtures needed:** token with configurable expiry for test speed

---

## Unit under test: Return request and restock

**Test cases**

6. `Given` an order with 3 line items, one returned
   `When` the return is approved and received
   `Then` only that one line item's inventory is restocked to the shared pool, and it
   becomes available on both brands immediately (cross-check against
   `medusa-catalog.tdd.md` case 4's assertion style)

7. `Given` a return outside the configured return window
   `When` a customer attempts to initiate it
   `Then` the request is rejected with a clear reason, no refund/restock occurs

8. `Given` a full-order return
   `When` approved and received
   `Then` all line items restock and the full order amount is refunded (delegates to
   `medusa-checkout-payments.tdd.md` case 7 for the refund-currency assertion)

**Fixtures needed:** seeded order with return-window boundary cases (just inside, just
outside); mocked Stripe refund

---

## Unit under test: Return status sync to Twenty

**Test cases**

9. `Given` a return is marked received and refunded in Medusa
   `Then` the linked Twenty Person/order record reflects the return (exact mechanism
   covered in `integration-webhooks.tdd.md`; this test only asserts that Medusa emits the
   event that triggers it)

**Fixtures needed:** spy/mock on the outbound event emitter, not a real Twenty call

---

## Out of scope for this TDD spec
- The Twenty-side receiver logic for return sync (see `integration-webhooks.tdd.md`)
- Shipping/label generation for return shipments (see `shipping-workflow.e2e.tdd.md`)
