import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

// Business logic belongs in a workflow, not the route handler (AGENTS.md) —
// this is the write side of the inbound half of docs/specs/
// 08-integration-webhooks.md: the route just verifies the signature and
// allowlists fields, this workflow applies them. Compensatable so a failed
// downstream step (there isn't one today, but the shape is here if this
// workflow grows) rolls the order's metadata back to what it was.
export type ApplyTwentyFulfillmentUpdateInput = {
  order_id: string
  fulfillment_status?: string
  tracking_number?: string
  carrier?: string
}

type StepCompensationData = {
  order_id: string
  previous_metadata: Record<string, unknown> | null
}

const applyTwentyFulfillmentUpdateStep = createStep(
  "apply-twenty-fulfillment-update",
  async (input: ApplyTwentyFulfillmentUpdateInput, { container }) => {
    const orderModuleService = container.resolve(Modules.ORDER)
    const { order_id, ...fields } = input

    // Throws MedusaError NOT_FOUND if the order doesn't exist — the route
    // relies on that to return a 404 rather than silently dropping or
    // crashing on an unrecognized medusa_order_id (docs/tdd/
    // integration-webhooks.tdd.md case 9).
    const order = await orderModuleService.retrieveOrder(order_id, {
      select: ["id", "metadata"],
    })
    const previousMetadata = order.metadata ?? null

    const updated = await orderModuleService.updateOrders(order_id, {
      metadata: {
        ...previousMetadata,
        twenty_fulfillment: {
          ...fields,
          updated_at: new Date().toISOString(),
        },
      },
    })

    return new StepResponse<unknown, StepCompensationData>(updated, {
      order_id,
      previous_metadata: previousMetadata,
    })
  },
  async (compensationData, { container }) => {
    if (!compensationData) {
      return
    }
    const orderModuleService = container.resolve(Modules.ORDER)
    await orderModuleService.updateOrders(compensationData.order_id, {
      metadata: compensationData.previous_metadata,
    })
  }
)

export const applyTwentyFulfillmentUpdateWorkflow = createWorkflow(
  "apply-twenty-fulfillment-update",
  (input: ApplyTwentyFulfillmentUpdateInput) => {
    const result = applyTwentyFulfillmentUpdateStep(input)
    return new WorkflowResponse(result)
  }
)
