import { Queue, Worker, type Job } from "bullmq"
import IORedis from "ioredis"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import { TWENTY_SYNC_MODULE } from "."
import type TwentySyncModuleService from "./service"
import { signPayload } from "./signature"

// docs/specs/08-integration-webhooks.md, "Retry & queueing": outbound
// Medusa -> Twenty calls go through a Redis-backed queue, never inline with
// order placement, and retry on a fixed schedule (1m, 5m, 30m, 2h, then
// hourly) until 24h of continued failure, at which point the event is
// marked dead and an alert is raised — the original order is never
// affected either way.
export const TWENTY_SYNC_QUEUE_NAME = "twenty-order-sync"

const RETRY_SCHEDULE_MS = [
  60_000, // 1m
  5 * 60_000, // 5m
  30 * 60_000, // 30m
  2 * 3600_000, // 2h
]
const HOURLY_MS = 3600_000
export const MAX_RETRY_WINDOW_MS = 24 * 3600_000
// A generous upper bound on BullMQ's own attempt counter. The worker's own
// elapsed-time check (against MAX_RETRY_WINDOW_MS) is what actually decides
// when an event goes dead, not this count — it exists only so BullMQ has
// *some* ceiling rather than retrying forever if the elapsed-time check
// were ever bypassed.
const BULLMQ_MAX_ATTEMPTS = 40

export function computeBackoffDelayMs(attemptsMade: number): number {
  if (attemptsMade <= RETRY_SCHEDULE_MS.length) {
    return RETRY_SCHEDULE_MS[attemptsMade - 1]
  }
  return HOURLY_MS
}

export type TwentyOrderPlacedJobData = {
  idempotencyKey: string
  payload: Record<string, unknown>
}

let connection: IORedis | undefined
let queue: Queue<TwentyOrderPlacedJobData> | undefined
let worker: Worker<TwentyOrderPlacedJobData> | undefined

function getRedisConnection(): IORedis | null {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) {
    return null
  }
  if (!connection) {
    connection = new IORedis(redisUrl, { maxRetriesPerRequest: null })
  }
  return connection
}

export function getTwentySyncQueue(): Queue<TwentyOrderPlacedJobData> | null {
  const conn = getRedisConnection()
  if (!conn) {
    return null
  }
  if (!queue) {
    queue = new Queue(TWENTY_SYNC_QUEUE_NAME, { connection: conn })
  }
  return queue
}

// Test-only cleanup: closes the worker/queue/connection and clears the
// module-level singletons so a spec file doesn't leak open Redis handles
// (or a stale worker bound to a now-torn-down test container) into
// whatever Jest runs next in the same process.
export async function shutdownTwentySync(): Promise<void> {
  await worker?.close()
  await queue?.close()
  await connection?.quit()
  worker = undefined
  queue = undefined
  connection = undefined
}

// Exported (not just internal) so tests can drive the dead-letter path
// directly with a manipulated first_attempted_at, rather than actually
// waiting out the real 24h window — the equivalent of the "fake clock to
// fast-forward through the backoff schedule" fixture called for in
// docs/tdd/integration-webhooks.tdd.md.
export async function processJob(
  job: Job<TwentyOrderPlacedJobData>,
  container: MedusaContainer
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const twentySyncModuleService = container.resolve<TwentySyncModuleService>(
    TWENTY_SYNC_MODULE
  )
  const eventBusModuleService = container.resolve(Modules.EVENT_BUS)

  const [event] = await twentySyncModuleService.listTwentySyncEvents({
    idempotency_key: job.data.idempotencyKey,
  })
  if (!event) {
    // The audit row is always created before the job is enqueued (see
    // enqueueOrderPlaced) — if it's missing, there's nothing safe to act
    // on, so log and stop rather than guessing at recreating it.
    logger.error(
      `Twenty sync job ${job.id}: no twenty_sync_event row for ${job.data.idempotencyKey}, skipping.`
    )
    return
  }
  if (event.status === "delivered") {
    // A previous attempt already succeeded (e.g. this retry was queued
    // just before that attempt's success was recorded) — nothing to do.
    return
  }

  const webhookUrl = process.env.TWENTY_WEBHOOK_URL
  if (!webhookUrl) {
    // Enqueueing only happens when a URL is configured (see
    // enqueueOrderPlaced), so reaching here means it was unset *after* the
    // job was queued — defensive, not the expected path.
    logger.warn(
      `Twenty sync job ${job.id}: TWENTY_WEBHOOK_URL not configured, leaving pending.`
    )
    return
  }

  const now = new Date()
  const firstAttemptedAt = event.first_attempted_at ?? now
  const attempts = event.attempts + 1
  const secret = process.env.TWENTY_OUTBOUND_WEBHOOK_SECRET ?? ""
  const rawBody = JSON.stringify(job.data.payload)

  let deliveryError: string | undefined
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twenty-Signature": signPayload(rawBody, secret),
      },
      body: rawBody,
    })
    if (response.ok) {
      await twentySyncModuleService.updateTwentySyncEvents({
        id: event.id,
        status: "delivered",
        attempts,
        delivered_at: now,
        first_attempted_at: firstAttemptedAt,
        last_error: null,
      })
      return
    }
    deliveryError = `Twenty responded with status ${response.status}`
  } catch (err) {
    deliveryError = err instanceof Error ? err.message : String(err)
  }

  const elapsedMs = now.getTime() - firstAttemptedAt.getTime()
  if (elapsedMs >= MAX_RETRY_WINDOW_MS) {
    await twentySyncModuleService.updateTwentySyncEvents({
      id: event.id,
      status: "dead",
      attempts,
      first_attempted_at: firstAttemptedAt,
      last_error: deliveryError ?? null,
    })
    logger.error(
      `Twenty sync ALERT: event ${event.idempotency_key} marked dead after ` +
        `${attempts} attempts over ${Math.round(elapsedMs / 3600_000)}h of ` +
        `retries — manual reconciliation needed. Last error: ${deliveryError}`
    )
    await eventBusModuleService.emit({
      name: "twenty-sync.dead",
      data: {
        idempotency_key: event.idempotency_key,
        attempts,
        last_error: deliveryError,
      },
    })
    // Returning (not throwing) tells BullMQ this job is done — our own
    // "dead" status is authoritative, not BullMQ's attempt counter.
    return
  }

  await twentySyncModuleService.updateTwentySyncEvents({
    id: event.id,
    attempts,
    first_attempted_at: firstAttemptedAt,
    last_error: deliveryError ?? null,
  })
  // Throwing is what makes BullMQ schedule a retry, using the backoff
  // strategy registered on the worker below.
  throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, deliveryError!)
}

// Lazily starts the worker that actually delivers queued events. Idempotent
// — safe to call on every order.placed event; only the first call does
// anything. The worker needs a live Medusa container to resolve the audit
// log service, the logger, and the event bus, and the only place that
// reliably has one on hand is wherever this is called from (the
// order-placed subscriber, which the framework invokes with a container on
// every event) — so the container from the first event to fire is what the
// worker keeps and uses for the lifetime of the process.
export function ensureTwentySyncWorker(container: MedusaContainer): void {
  const conn = getRedisConnection()
  if (!conn || worker) {
    return
  }

  worker = new Worker<TwentyOrderPlacedJobData>(
    TWENTY_SYNC_QUEUE_NAME,
    (job) => processJob(job, container),
    {
      connection: conn,
      settings: {
        backoffStrategy: (attemptsMade: number) =>
          computeBackoffDelayMs(attemptsMade),
      },
    }
  )

  worker.on("failed", (job, err) => {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    logger.warn(
      `Twenty sync job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`
    )
  })
}

export async function enqueueOrderPlaced(
  container: MedusaContainer,
  idempotencyKey: string,
  eventName: string,
  payload: Record<string, unknown>
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  // Nothing configured to sync to — skip rather than queue work that can
  // never be delivered. This is the same graceful-degradation shape as the
  // conditional Stripe registration in medusa-config.ts: no Twenty
  // instance is set up in this repo's CI or local dev today.
  if (!process.env.TWENTY_WEBHOOK_URL) {
    logger.info(
      `Twenty sync: TWENTY_WEBHOOK_URL not configured, skipping sync for ${idempotencyKey}.`
    )
    return
  }

  const q = getTwentySyncQueue()
  if (!q) {
    logger.warn(
      `Twenty sync: REDIS_URL not configured, cannot enqueue ${idempotencyKey}.`
    )
    return
  }

  const twentySyncModuleService = container.resolve<TwentySyncModuleService>(
    TWENTY_SYNC_MODULE
  )
  const [existing] = await twentySyncModuleService.listTwentySyncEvents({
    idempotency_key: idempotencyKey,
  })
  if (existing) {
    // Already recorded — e.g. the subscriber fired twice for the same
    // order. The BullMQ job below is also keyed by idempotencyKey, so this
    // is a belt-and-suspenders check against duplicate delivery, not the
    // only guard.
    return
  }

  await twentySyncModuleService.createTwentySyncEvents({
    idempotency_key: idempotencyKey,
    event_name: eventName,
    payload,
    status: "pending",
    attempts: 0,
  })

  ensureTwentySyncWorker(container)

  await q.add(
    eventName,
    { idempotencyKey, payload },
    {
      jobId: idempotencyKey,
      attempts: BULLMQ_MAX_ATTEMPTS,
      backoff: { type: "twenty-sync-schedule" },
      removeOnComplete: true,
      removeOnFail: false,
    }
  )
}
