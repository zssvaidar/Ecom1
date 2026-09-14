# 06 — Returns Spec

## Purpose
Define the return/refund workflow, and how it re-enters the shared processes (inventory,
shipping, payments) already specified.

*(Subscriptions were dropped from scope — this spec now covers returns only.)*

## Returns & refunds

**Flow**
1. Customer or staff initiates a return against an existing order (Medusa Returns module)
2. Staff approves; return shipping is arranged through Twenty, mirroring the outbound
   shipping workflow in `09-shipping-workflow.md` (Twenty owns the return label/tracking)
3. Item received and inspected by staff
4. Inventory restocked to the shared pool (`02-catalog-inventory.md`) — a returned unit
   becomes available to *both* brands immediately, same as any other stock change
5. Refund issued via Stripe in the original charge currency (`04-payments.md`)
6. Order status updated in Medusa; Twenty's linked Person/order record reflects the return

**Partial returns**: supported at line-item level — refund and restock only the returned
items, not the whole order.

**Return window**: business rule (e.g., 30 days) enforced at the Medusa Returns module
level; exact window to be set in Admin config, not hardcoded.

## Cross-brand behavior
- Returns/refunds work identically regardless of which brand the original order came from

## Open questions
- Confirm return window length (30 days used as a placeholder above)

## Done means
- [ ] Partial return correctly refunds and restocks only the returned line items
- [ ] Restocked inventory is immediately visible/sellable on both brands
- [ ] Refund posts in the original charge currency
- [ ] Return status updates propagate correctly to the linked Twenty record
