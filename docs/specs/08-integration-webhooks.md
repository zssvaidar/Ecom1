# 08 — Integration & Webhooks Spec

## Purpose
Define the exact event contract between Medusa and Twenty in both directions, and the
resilience rules (retry, idempotency, auth) that make the sync safe under failure.

## Outbound: Medusa → Twenty

**Trigger:** `order.placed` event on Medusa's internal event bus.

**Endpoint:** Twenty webhook receiver (custom endpoint or Twenty workflow trigger).

**Payload**
```json
{
  "event": "order.placed",
  "idempotency_key": "order_<medusa_order_id>",
  "order": {
    "id": "order_01ABC...",
    "sales_channel": "brand-a",
    "customer": { "email": "jane@example.com", "name": "Jane Doe" },
    "line_items": [{ "title": "...", "quantity": 1 }],
    "shipping_address": { "line1": "...", "city": "...", "country": "US" },
    "currency": "usd",
    "total": 4200
  }
}
```

**Receiver actions (Twenty side)**
1. Upsert Person by `order.customer.email` (per `07-twenty-data-model.md`)
2. Create Shipment/Task record if one doesn't already exist for `idempotency_key`
3. Link the Task to the resolved Person
4. Return `200` on success; any non-2xx response is treated as a delivery failure

## Inbound: Twenty → Medusa

**Trigger:** Staff updates fulfillment status or enters tracking on a Task.

**Endpoint:** Medusa custom API route, e.g. `POST /webhooks/twenty/fulfillment`.

**Payload**
```json
{
  "event": "fulfillment.updated",
  "medusa_order_id": "order_01ABC...",
  "fulfillment_status": "shipped",
  "tracking_number": "1Z999AA10123456784",
  "carrier": "UPS"
}
```

**Receiver actions (Medusa side)**
1. Verify webhook signature (see Auth below)
2. Validate payload only contains allowed fields — reject/ignore anything attempting to
   set order totals, payment status, or order status directly (write-back scope guard,
   `00-architecture.md` decision #3)
3. Update the order's fulfillment record
4. Return `200` on success

## Retry & queueing

- All outbound Medusa → Twenty calls are dispatched through a Redis-backed queue, not
  called synchronously inline with order placement
- On delivery failure (non-2xx or timeout), the event is retried with exponential backoff
  (e.g., 1m, 5m, 30m, 2h, then hourly up to 24h)
- After 24h of failed retries, the event is marked `dead` and an alert is raised for manual
  reconciliation — the original Medusa order is never affected by this outcome
- Inbound (Twenty → Medusa) calls do not need a retry queue on Medusa's side — if Medusa's
  endpoint is briefly unavailable, Twenty's own retry (or manual staff re-save) re-triggers
  the call

## Idempotency

- Outbound: `idempotency_key = "order_<medusa_order_id>"` — Twenty receiver checks for an
  existing Task with this key before creating a new one; redelivery updates, never
  duplicates
- Inbound: Medusa receiver treats fulfillment updates as **upserts** keyed on
  `medusa_order_id` — reapplying the same status/tracking is a no-op, not an error

## Auth

- Both directions use HMAC-signed payloads: a shared secret (per direction, stored in
  Vault) signs the request body; receiver verifies the signature before processing
- Unsigned or invalid-signature requests are rejected with `401` and never processed

## Open questions
See `07-twenty-data-model.md`'s Open Questions — how Twenty actually turns an
inbound webhook call into Person/Task upserts (a webhook-triggered Workflow vs.
calling Twenty's own API directly) is still unverified against a real instance.
Everything in this doc about the Medusa side of the contract (payload shape,
retry/backoff, idempotency, signing) is implemented and tested regardless of how
that question resolves.

## Implementation status
Built and tested in `apps/backend/`:
- `src/subscribers/twenty-order-sync.ts` — builds the outbound payload on
  `order.placed` and hands it to the sync queue.
- `src/modules/twenty-sync/` — the Redis+BullMQ retry queue (`queue.ts`, including
  the 1m/5m/30m/2h-then-hourly backoff and 24h dead-lettering) and a Postgres
  `twenty_sync_event` audit/idempotency log (`models/twenty-sync-event.ts`) that
  survives a Redis flush — Redis owns retry *timing*, Postgres owns the
  idempotency/audit source of truth.
- `signature.ts` — the shared HMAC sign/verify used by both directions.
- `src/api/webhooks/twenty/fulfillment/route.ts` +
  `src/workflows/apply-twenty-fulfillment-update.ts` — the inbound receiver:
  signature verification, the write-back field allowlist, idempotent upsert into
  order metadata.
- `integration-tests/http/twenty-webhooks.spec.ts` (10 tests) — a local mock HTTP
  server standing in for Twenty (this doc's own fixture list calls for exactly
  that, not a real Twenty workspace) verifies: the outbound payload shape and
  successful delivery; an order still completes normally when the mock is set to
  fail (Twenty-down guarantee); the 24h dead-letter transition (driven directly
  with a manipulated `first_attempted_at` rather than actually waiting 24h — the
  backoff schedule's *values* are separately unit-tested in
  `src/modules/twenty-sync/__tests__/queue.unit.spec.ts`); and all of the inbound
  signature/allowlist/idempotency/not-found cases. Also verified against a real
  `medusa develop` server, a real Redis, and a real standalone Node HTTP mock
  (not just the Jest harness): a real checkout's payload arrived at the mock
  correctly signed and the audit row reached `delivered`, and a real signed
  curl request to the inbound route updated order metadata while leaving an
  injected `total` field untouched.

## Done means
- [x] Order placement reliably creates exactly one Twenty Task, verified under simulated
      webhook redelivery — verified as far as the Medusa side goes: exactly one
      `twenty_sync_event` row and one delivery per order, enforced by the
      `idempotency_key` unique constraint plus a BullMQ job id keyed the same way.
      Whether Twenty's own receiver is idempotent on redelivery is
      `07-twenty-data-model.md`'s concern, not this repo's to verify (out of scope
      per this doc's own "Out of scope" section).
- [x] Killing the Twenty service mid-checkout does not block or fail the Medusa order —
      verified: a failing/unreachable mock still lets checkout complete normally,
      and the outbound sync failure is recorded (pending, with attempts and
      last_error set) rather than surfacing to the customer.
- [x] Queued events retry on schedule and reach `dead` status with an alert after 24h of
      continued failure — schedule values unit-tested directly; the dead-letter
      transition and `twenty-sync.dead` alert event verified by driving
      `processJob` with a manipulated `first_attempted_at` rather than waiting out
      the real 24h.
- [x] Inbound fulfillment update rejects any payload attempting to set order
      total/payment/status fields — verified: those fields are simply never read
      by the route (an allowlist, not a blocklist), so there's no path for them to
      reach an order's real fields.
- [x] Both endpoints reject unsigned requests — verified for the inbound route
      (missing signature, wrong secret, and tampered body all rejected with 401).
      The outbound direction signs every request it sends but has no "endpoint to
      reject unsigned requests" of its own to test — that's Twenty's receiver,
      which doesn't exist in this environment (see Open Questions).
