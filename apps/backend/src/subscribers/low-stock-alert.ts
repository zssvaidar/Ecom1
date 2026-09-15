import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import {
  ContainerRegistrationKeys,
  InventoryLevelWorkflowEvents,
  Modules,
  ReservationItemWorkflowEvents,
} from "@medusajs/framework/utils"

// Covers docs/tdd/medusa-catalog.tdd.md TDD case 9: an inventory item
// crossing below its configured low-stock threshold fires an alert exactly
// once per crossing, not once per brand — the shared inventory item isn't
// scoped to a sales channel, so a sale from either brand reaches this same
// subscriber and must not double-fire.
//
// Two separate events feed this, because a real sale and a real restock go
// through entirely different code paths in Medusa v2:
// - A sale (cart complete) only *reserves* stock. reserveInventoryStep calls
//   InventoryModuleService.createReservationItems_(), which updates the
//   inventory_level row's reserved_quantity through the repository directly
//   rather than through the module's own decorated updateInventoryLevels()
//   method, so no inventory-level-updated event fires at order-placement
//   time at all — only ReservationItemWorkflowEvents.CREATED does (emitted
//   explicitly by core-flows' complete-cart workflow for exactly this
//   reason). That's the hook for detecting a crossing.
// - A restock (Admin location-level update) goes through
//   updateInventoryLevelsWorkflow, which *does* emit
//   InventoryLevelWorkflowEvents.UPDATED. That's the hook for clearing the
//   alerted flag once stock recovers above the threshold.
//
// Opt-in only: an item is watched only once its inventory_item.metadata
// carries a `low_stock_threshold` (there's no such concept in Medusa v2's
// inventory module itself, so this is entirely custom). The "already
// alerted" state also lives in that same metadata (`low_stock_alerted`) —
// inventory_level has no metadata field of its own (only inventory_item
// does; confirmed against AdminUpdateInventoryLocationLevel, which only
// accepts stocked_quantity/incoming_quantity), so the flag has to live on
// the item even though the crossing is evaluated per location.
export default async function lowStockAlertHandler({
  event,
  container,
}: SubscriberArgs<{ id: string; order_id?: string }>) {
  const inventoryModuleService = container.resolve(Modules.INVENTORY)
  const eventBusModuleService = container.resolve(Modules.EVENT_BUS)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  let inventoryItemId: string
  let locationId: string
  if (event.name === ReservationItemWorkflowEvents.CREATED) {
    const reservation = await inventoryModuleService.retrieveReservationItem(
      event.data.id
    )
    inventoryItemId = reservation.inventory_item_id
    locationId = reservation.location_id
  } else {
    const level = await inventoryModuleService.retrieveInventoryLevel(
      event.data.id
    )
    inventoryItemId = level.inventory_item_id
    locationId = level.location_id
  }

  const item = await inventoryModuleService.retrieveInventoryItem(
    inventoryItemId
  )
  const threshold = item.metadata?.low_stock_threshold as number | undefined
  if (threshold == null) {
    return
  }

  const level = await inventoryModuleService.retrieveInventoryLevelByItemAndLocation(
    inventoryItemId,
    locationId
  )
  const alreadyAlerted = item.metadata?.low_stock_alerted === true
  // available_quantity is a BigNumber instance, not a plain number — coerce
  // it before comparing/emitting so consumers get a plain number back.
  const availableQuantity = Number(level.available_quantity)

  if (availableQuantity <= threshold && !alreadyAlerted) {
    logger.warn(
      `Low stock: inventory item ${item.id} at location ${locationId} has ${availableQuantity} available (threshold ${threshold}).`
    )
    await eventBusModuleService.emit({
      name: "inventory-item.low-stock",
      data: {
        inventory_item_id: item.id,
        location_id: locationId,
        available_quantity: availableQuantity,
        threshold,
      },
    })
    await inventoryModuleService.updateInventoryItems({
      id: item.id,
      metadata: { ...item.metadata, low_stock_alerted: true },
    })
  } else if (availableQuantity > threshold && alreadyAlerted) {
    // Restocked back above the threshold — clear the flag so the next
    // crossing fires again instead of staying permanently silenced.
    await inventoryModuleService.updateInventoryItems({
      id: item.id,
      metadata: { ...item.metadata, low_stock_alerted: false },
    })
  }
}

export const config: SubscriberConfig = {
  event: [
    ReservationItemWorkflowEvents.CREATED,
    InventoryLevelWorkflowEvents.UPDATED,
  ],
}
