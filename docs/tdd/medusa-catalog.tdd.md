# TDD — Medusa Catalog & Shared Inventory

Maps to: `docs-specs/02-catalog-inventory.md`, `docs-specs/01-medusa-config.md`
Process landscape ref: Process 2 (Shared Inventory Management)

Write these tests first, watch them fail, then implement against `02-catalog-inventory.md`
until they pass.

---

## Unit under test: Product/variant channel assignment

**Test cases**

1. `Given` a product assigned only to `brand-a`
   `When` querying the catalog via Brand B's publishable key
   `Then` the product does not appear in results

2. `Given` a product assigned to both `brand-a` and `brand-b`
   `When` querying the catalog via either brand's publishable key
   `Then` the product appears in both, with each brand's own regional price

3. `Given` a cross-listed variant with a USD price and a JPY price
   `When` fetched via Brand A's key vs. Brand B's key
   `Then` the returned price matches the correct currency/region for each

**Fixtures needed:** seeded products in both single-channel and cross-listed
configurations; two publishable API keys (Brand A, Brand B)

---

## Unit under test: Shared inventory linkage

**Test cases**

4. `Given` a cross-listed variant backed by one inventory item with stock = 5
   `When` an order for 2 units is placed via Brand A
   `Then` the inventory item's available stock is 3, and Brand B's product page for the
   same variant reflects 3 available

5. `Given` an inventory item at stock = 0
   `When` either storefront attempts to add it to cart
   `Then` the add-to-cart request is rejected with an out-of-stock error

6. `Given` a restock event (manual Admin adjustment) on a shared inventory item
   `Then` both brands' product pages reflect the new stock level without any
   brand-specific step

**Fixtures needed:** shared inventory location with a known starting stock level

---

## Unit under test: Concurrency / oversell prevention

**Test cases**

7. `Given` a shared inventory item with stock = 1
   `When` two simultaneous checkout requests are submitted — one via Brand A, one via
   Brand B, both for that item
   `Then` exactly one order succeeds and the other receives an out-of-stock rejection,
   with no negative stock value ever persisted

8. `Given` two simultaneous carts reserving the same last unit
   `When` one cart's reservation expires without completing checkout
   `Then` the reserved unit becomes available again for the other cart within the
   reservation-expiry window

**Fixtures needed:** ability to fire concurrent requests in the test harness (e.g.,
`Promise.all` against two cart-complete calls); a short reservation TTL configured for
test speed

---

## Unit under test: Low-stock alerting

**Test cases**

9. `Given` an inventory item crosses below its configured low-stock threshold from a sale
   on either brand
   `Then` an Admin alert/notification fires exactly once per threshold crossing (not
   once per brand)

**Fixtures needed:** configurable low-stock threshold, a way to assert on
notification/event emission in tests (e.g., spy on the event bus)

---

## Out of scope for this TDD spec
- Category structure differences between brands (no shared-state risk, covered by basic
  CRUD tests, not called out individually here)
- Pricing calculation edge cases beyond currency selection (taxes are covered in the
  payments/tax TDD spec)
