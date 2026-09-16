import { model } from "@medusajs/framework/utils"

// Durable audit log + idempotency guard for outbound Medusa -> Twenty sync
// (docs/specs/08-integration-webhooks.md). BullMQ+Redis owns the *timing* of
// retries (delayed jobs), but Redis is not where you want the source of
// truth for "has this order already been synced" or "which events are
// dead" to live — a Redis flush or eviction would silently reopen every
// idempotency guarantee this table exists to provide. Postgres is that
// source of truth; the queue is just the scheduler.
const TwentySyncEvent = model.define("twenty_sync_event", {
  id: model.id({ prefix: "tse" }).primaryKey(),
  // "order_<medusa_order_id>" per 08-integration-webhooks.md — unique so a
  // second enqueue attempt for the same order (e.g. a retried subscriber
  // call) updates the existing row instead of creating a duplicate delivery
  // record.
  idempotency_key: model.text().unique(),
  event_name: model.text(),
  payload: model.json(),
  status: model.enum(["pending", "delivered", "dead"]).default("pending"),
  attempts: model.number().default(0),
  last_error: model.text().nullable(),
  delivered_at: model.dateTime().nullable(),
  first_attempted_at: model.dateTime().nullable(),
})

export default TwentySyncEvent
