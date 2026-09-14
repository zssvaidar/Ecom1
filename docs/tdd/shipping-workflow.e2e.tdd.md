# TDD — Shipping Workflow (End-to-End)

Maps to: `docs-specs/09-shipping-workflow.md`
Process landscape ref: Process 3 (Shipping & Fulfillment)

These are end-to-end tests spanning both systems — slower and fewer than the unit-level
TDD specs, run against a real (or fully-featured local) Twenty instance rather than mocks
where practical, since the whole point is verifying the two systems agree with each other.

---

## Scenario: Full happy path

**Test case**

1. `Given` a customer places an order on Brand A
   `When` the full sequence runs: order placed → Twenty Task created → staff sets
   address/method/cost → staff creates shipment → staff enters tracking and marks
   shipped → webhook fires back to Medusa
   `Then` the Medusa order shows `fulfillment_status: shipped` with the correct tracking
   number, visible in both Admin and the customer's account, and the sequence completes
   within a reasonable time bound (flag your expected SLA — used as a smoke-test ceiling,
   not a hard product requirement)

**Fixtures needed:** full local stack running (Medusa + Twenty + Redis), or a staging
environment; ability to script the "staff" steps via Twenty's API rather than clicking
through UI

---

## Scenario: Twenty unavailable at order placement

**Test case**

2. `Given` Twenty is stopped/unreachable
   `When` a customer completes checkout
   `Then` the order completes normally (per `integration-webhooks.tdd.md` case 14)
   `And` once Twenty comes back online, the queued Task-creation event is delivered and a
   Task appears without any customer-visible side effects

**Fixtures needed:** ability to stop/start the Twenty service (or mock endpoint) mid-test

---

## Scenario: Medusa unavailable when staff marks shipped

**Test case**

3. `Given` Medusa's fulfillment webhook endpoint is unreachable
   `When` staff marks a Task as shipped in Twenty
   `Then` Twenty holds/retries the update (per Twenty's own retry behavior) and,
   `When` Medusa comes back online
   `Then` the fulfillment update is eventually delivered and applied, without staff
   needing to redo the action manually (or, if Twenty doesn't auto-retry, confirm that a
   manual re-save by staff successfully re-triggers it — pin down which behavior Twenty
   actually provides during implementation and adjust this test accordingly)

**Fixtures needed:** ability to stop/start the Medusa service mid-test

---

## Scenario: Exception state does not falsely mark fulfilled

**Test case**

4. `Given` a Task moves into an `exception` state (e.g., address issue)
   `Then` the Medusa order remains in "awaiting fulfillment" — no fulfillment webhook is
   sent for an exception state, and the customer/Admin do not see a false "shipped" status

**Fixtures needed:** ability to set a Task to `exception` via Twenty's API in the test
harness

---

## Scenario: Return shipping mirrors outbound shipping

**Test case**

5. `Given` an approved return (from `medusa-customer-returns.tdd.md`)
   `When` return shipping is arranged through Twenty
   `Then` the same Task/status/tracking mechanics apply as outbound shipping — no
   separate code path needed, verified here as a full-stack check rather than assumed
   from the unit-level tests alone

**Fixtures needed:** seeded approved return, same stack as scenario 1

---

## Out of scope for this TDD spec
- Individual field-level validation on the Twenty Task (covered in
  `twenty-data-model.tdd.md`)
- Retry backoff timing precision (covered with a fake clock in
  `integration-webhooks.tdd.md`; here we only care that it *eventually* converges)
