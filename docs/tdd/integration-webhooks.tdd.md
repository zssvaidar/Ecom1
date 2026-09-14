# TDD — Integration & Webhooks

Maps to: `docs-specs/08-integration-webhooks.md`
Process landscape ref: Process 6 (Sync Resilience)

This is the highest-risk module — most of the "does the two-store setup actually work"
question lives here. Test the failure paths as thoroughly as the happy path.

---

## Unit under test: Outbound order sync (Medusa → Twenty)

**Test cases**

1. `Given` an order is placed
   `Then` an `order.placed` event is enqueued with an `idempotency_key` of
   `order_<id>` and the full expected payload shape (customer, line items, address,
   currency, total)

2. `Given` the queued event is delivered to a reachable Twenty endpoint
   `Then` it returns 200 and the event is marked delivered (not retried again)

3. `Given` Twenty responds with a non-2xx status
   `Then` the event is retried per the documented backoff schedule (1m, 5m, 30m, 2h,
   hourly to 24h)

4. `Given` an event has been retrying for 24h with no success
   `Then` it is marked `dead` and an alert is raised, and — critically — the original
   Medusa order remains completely unaffected (still paid, still valid, customer still
   sees confirmation)

**Fixtures needed:** mocked Twenty endpoint that can be toggled reachable/unreachable/
slow/erroring; fake clock to fast-forward through the backoff schedule in tests

---

## Unit under test: Idempotency (outbound)

**Test cases**

5. `Given` the same `order.placed` event is delivered twice (simulated redelivery, e.g.
   from a retry racing a slow-but-successful first attempt)
   `Then` Twenty's receiver creates exactly one Task (already covered from Twenty's side
   in `twenty-data-model.tdd.md`; this test asserts Medusa's queue doesn't itself produce
   duplicate deliveries under normal retry operation)

**Fixtures needed:** queue inspection utility to assert on delivery count per
idempotency key

---

## Unit under test: Inbound fulfillment updates (Twenty → Medusa)

**Test cases**

6. `Given` a validly signed fulfillment-update payload with `fulfillment_status: shipped`
   and a tracking number
   `Then` the Medusa order's fulfillment record is updated, order totals/payment/status
   are untouched

7. `Given` a payload attempting to also set order total or payment status
   `Then` those fields are ignored/rejected — only `fulfillment_status` and
   `tracking_number` are ever applied (the write-back scope guard)

8. `Given` the same fulfillment update delivered twice
   `Then` the second delivery is a no-op — no error, no duplicate state change

9. `Given` a payload referencing a `medusa_order_id` that doesn't exist
   `Then` it's rejected with a clear error, not silently dropped or crashing

**Fixtures needed:** signed and unsigned payload builders; seeded order to update against

---

## Unit under test: Signature verification (both directions)

**Test cases**

10. `Given` a correctly HMAC-signed request
    `Then` it is processed

11. `Given` a request with a missing signature header
    `Then` it is rejected with 401, and no downstream processing occurs

12. `Given` a request with a valid signature format but wrong secret
    `Then` it is rejected with 401

13. `Given` a request with a tampered body but a signature computed over the original body
    `Then` it is rejected (signature mismatch), proving the check covers body integrity,
    not just presence of a header

**Fixtures needed:** valid/invalid HMAC signer utility for test payload construction

---

## Unit under test: Twenty-down at order-placement time (end-to-end within this module)

**Test cases**

14. `Given` Twenty is completely unreachable
    `When` a customer completes checkout
    `Then` the order still completes successfully and the customer sees a normal
    confirmation — the sync failure is invisible to the customer and only visible in the
    retry queue/ops alerting

**Fixtures needed:** full checkout flow available in the test harness with Twenty mocked
as down; this is close to an integration test rather than a pure unit test — acceptable
here given how central this guarantee is

---

## Out of scope for this TDD spec
- What Twenty does with a valid payload once received (see `twenty-data-model.tdd.md`)
- The staff-facing sequence in Twenty (see `shipping-workflow.e2e.tdd.md`)
