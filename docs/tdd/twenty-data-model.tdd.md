# TDD — Twenty CRM Data Model

Maps to: `docs-specs/07-twenty-data-model.md`
Process landscape ref: Process 4 (Customer Identity & CRM Sync)

---

## Unit under test: Person upsert and dedupe

**Test cases**

1. `Given` no existing Person with a given email
   `When` an order payload arrives for that email
   `Then` exactly one Person record is created

2. `Given` an existing Person with email `jane@example.com` (created from a Brand A order)
   `When` a Brand B order arrives for the same email
   `Then` no new Person is created; the existing Person is updated (e.g., "brands
   purchased from" now includes both) and the new order links to the same Person

3. `Given` two orders arrive concurrently for the same new email (race condition)
   `Then` exactly one Person is created, not two — dedupe logic must handle concurrent
   upserts, not just sequential ones

**Fixtures needed:** Twenty test workspace or mocked Twenty API; ability to fire
concurrent upsert calls

---

## Unit under test: Shipment/Task creation

**Test cases**

4. `Given` an order payload with a valid `idempotency_key`
   `When` received for the first time
   `Then` exactly one Shipment/Task record is created, linked to the correct Person

5. `Given` the same order payload delivered twice (simulated webhook redelivery)
   `Then` no second Task is created — the existing Task is left as-is or updated
   in-place, never duplicated

6. `Given` a Task is created for an order
   `Then` its `sales_channel` field matches the order's originating brand, so staff can
   filter their queue correctly

**Fixtures needed:** duplicate-delivery test harness (send the same payload twice in
sequence and assert on Task count)

---

## Unit under test: Person ↔ Task relation integrity

**Test cases**

7. `Given` a Person with orders from both brands
   `Then` querying that Person returns Tasks from both brands, not just one

8. `Given` a Task exists
   `Then` its linked Person can always be resolved back to a valid record (no orphaned
   Tasks pointing at a deleted/missing Person)

**Fixtures needed:** seeded Person with multi-brand Task history

---

## Out of scope for this TDD spec
- The webhook delivery/retry mechanics themselves (see `integration-webhooks.tdd.md`) —
  this spec assumes the payload arrives and tests only what Twenty does with it
- Staff-facing workflow UI within Twenty (not something we're building custom UI for)
