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
None — this spec fully implements the resilience requirements from the process landscape
(Process 6: Sync Resilience) and the write-back scope guard from the architecture spec.

## Done means
- [ ] Order placement reliably creates exactly one Twenty Task, verified under simulated
      webhook redelivery
- [ ] Killing the Twenty service mid-checkout does not block or fail the Medusa order
- [ ] Queued events retry on schedule and reach `dead` status with an alert after 24h of
      continued failure
- [ ] Inbound fulfillment update rejects any payload attempting to set order
      total/payment/status fields
- [ ] Both endpoints reject unsigned requests
