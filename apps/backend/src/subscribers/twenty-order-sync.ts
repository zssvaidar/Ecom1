import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import {
  ContainerRegistrationKeys,
  OrderWorkflowEvents,
} from "@medusajs/framework/utils"
import { enqueueOrderPlaced } from "../modules/twenty-sync/queue"

// Outbound half of docs/specs/08-integration-webhooks.md: on order.placed,
// build the documented payload shape and hand it to the Twenty sync queue.
// Per "Async, resilient sync" in docs/specs/00-architecture.md, a problem
// here must never affect the order itself — the try/catch below makes that
// guarantee explicit (Medusa's local event bus already catches+logs a
// throwing subscriber on its own, but relying on that alone would make the
// guarantee implicit rather than something this file visibly upholds and a
// test can exercise directly).
export default async function twentyOrderSyncHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  try {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "currency_code",
        "total",
        "email",
        "customer.first_name",
        "customer.last_name",
        "sales_channel.name",
        "items.title",
        "items.quantity",
        "shipping_address.address_1",
        "shipping_address.city",
        "shipping_address.country_code",
      ],
      filters: { id: data.id },
    })
    const order = orders[0]
    if (!order) {
      logger.warn(`Twenty sync: order ${data.id} not found, skipping.`)
      return
    }

    const customerName = [order.customer?.first_name, order.customer?.last_name]
      .filter(Boolean)
      .join(" ")

    const payload = {
      event: "order.placed",
      idempotency_key: `order_${order.id}`,
      order: {
        id: order.id,
        sales_channel: order.sales_channel?.name ?? null,
        customer: {
          email: order.email,
          name: customerName || null,
        },
        line_items: (order.items ?? [])
          .filter((item): item is NonNullable<typeof item> => item != null)
          .map((item) => ({
            title: item.title,
            quantity: item.quantity,
          })),
        shipping_address: order.shipping_address
          ? {
              line1: order.shipping_address.address_1,
              city: order.shipping_address.city,
              country: order.shipping_address.country_code,
            }
          : null,
        currency: order.currency_code,
        total: order.total,
      },
    }

    await enqueueOrderPlaced(
      container,
      `order_${order.id}`,
      "order.placed",
      payload
    )
  } catch (err) {
    logger.error(
      `Twenty sync: failed to enqueue order.placed for ${data.id}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

export const config: SubscriberConfig = {
  event: OrderWorkflowEvents.PLACED,
}
