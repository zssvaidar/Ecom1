# 02 — Catalog & Inventory Spec

## Purpose
Define how products/variants are modeled across two brands sharing one backend, and how the
shared inventory pool behaves under concurrent sales.

## Product model

- Standard Medusa product/variant structure; no custom fields needed beyond what Medusa
  provides out of the box for this scope.
- Each product is assigned to one or both sales channels (`brand-a`, `brand-b`):
  - **Brand-exclusive**: assigned to a single channel, only sellable there
  - **Cross-listed**: assigned to both channels, same underlying inventory item(s)
- Pricing is set per variant per currency/region (A2 in the master list) — a cross-listed
  product has both a USD price (Brand A) and a JPY price (Brand B) on the same variant.
- Categories are channel-agnostic; both brands can share or diverge on category structure
  as needed — no system constraint either way.

## Inventory model

- One inventory location (`main-warehouse`).
- Every variant's inventory item links to this location, regardless of which channel(s)
  sell it.
- Stock levels are a single number per inventory item — there is no per-channel stock
  split. A cross-listed product genuinely shares the same physical stock.

## Concurrency & reservations

- Cart-level reservations are created when an item is added to cart, released on cart
  expiry or abandonment.
- Reservation converts to a stock decrement on order placement.
- Because both storefronts write to the same inventory item, a race between simultaneous
  checkouts on Brand A and Brand B for the last unit must be handled by Medusa's existing
  reservation/locking behavior — no custom locking logic needed, but this must be verified
  under test (see TDD spec).

## Out-of-stock behavior

- Product page shows out-of-stock state per variant when reserved+sold quantity meets
  available stock, correctly reflecting sales from *either* brand.
- Admin low-stock alert threshold configurable per inventory item (not per channel).

## Open questions
- None currently. If a future SKU needs genuinely separate stock per brand (e.g., a
  brand-specific bundle), that would need a second inventory item and is out of scope for
  this spec as written.

## Done means
- [ ] A cross-listed product's stock decrements on Brand A correctly reduces what Brand B
      shows as available
- [ ] Concurrent checkout test: two simultaneous orders for the last unit of a shared SKU
      result in exactly one success and one out-of-stock rejection
- [ ] Out-of-stock UI state renders correctly on both storefronts
- [ ] Low-stock Admin alert fires correctly regardless of which channel triggered it
