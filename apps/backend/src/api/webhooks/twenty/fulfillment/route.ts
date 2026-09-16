import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { verifySignature } from "../../../../modules/twenty-sync/signature"
import { applyTwentyFulfillmentUpdateWorkflow } from "../../../../workflows/apply-twenty-fulfillment-update"

// Inbound half of docs/specs/08-integration-webhooks.md: staff update
// fulfillment status or tracking on a Twenty Task, Twenty calls this route.
//
// Write-back scope guard (00-architecture.md decision #3): only
// fulfillment_status, tracking_number, and carrier are ever read from the
// body. Anything else Twenty sends — order totals, payment status, order
// status — is simply never looked at, so there's no way for it to reach an
// order's real fields through this route.
const ALLOWED_FIELDS = ["fulfillment_status", "tracking_number", "carrier"] as const

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody.toString("utf8")
    : String(req.rawBody ?? "")
  const signature = req.headers["x-twenty-signature"]
  const secret = process.env.TWENTY_INBOUND_WEBHOOK_SECRET

  // No configured secret means signatures can never be verified — fail
  // closed (reject) rather than silently accepting unsigned requests.
  if (
    !secret ||
    !verifySignature(
      rawBody,
      typeof signature === "string" ? signature : undefined,
      secret
    )
  ) {
    res.status(401).json({ message: "Invalid or missing webhook signature" })
    return
  }

  const body = req.body as Record<string, unknown>
  const medusaOrderId = body.medusa_order_id
  if (typeof medusaOrderId !== "string" || medusaOrderId.length === 0) {
    res.status(400).json({ message: "medusa_order_id is required" })
    return
  }

  const update: Record<string, string> = {}
  for (const field of ALLOWED_FIELDS) {
    if (typeof body[field] === "string") {
      update[field] = body[field] as string
    }
  }

  try {
    // Idempotent by construction: reapplying the same status/tracking just
    // overwrites the same values under the same metadata key, never a
    // duplicate record and never an error.
    await applyTwentyFulfillmentUpdateWorkflow(req.scope).run({
      input: { order_id: medusaOrderId, ...update },
    })
  } catch (err) {
    if (err instanceof MedusaError && err.type === MedusaError.Types.NOT_FOUND) {
      res.status(404).json({ message: `Order ${medusaOrderId} was not found` })
      return
    }
    throw err
  }

  res.status(200).json({ success: true })
}
