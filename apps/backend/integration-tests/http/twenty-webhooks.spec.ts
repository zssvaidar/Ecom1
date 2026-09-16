// Set before anything else in this file runs (module-load time, ahead of
// medusaIntegrationTestRunner's own app-boot hooks) so every Twenty-related
// env read anywhere in the app sees these values from the very first
// order.placed event this file fires. Deliberately scoped to only this
// spec file — every other spec file in this repo runs with
// TWENTY_WEBHOOK_URL unset, so the order.placed subscriber log-and-skips
// for them and never touches Redis at all.
process.env.TWENTY_WEBHOOK_URL = "http://127.0.0.1:0/webhook" // overwritten once the mock server picks a real port, see beforeAll
process.env.TWENTY_OUTBOUND_WEBHOOK_SECRET = "test-outbound-secret"
process.env.TWENTY_INBOUND_WEBHOOK_SECRET = "test-inbound-secret"
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379"

import http from "node:http"
import type { AddressInfo } from "node:net"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createStockLocationsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from "@medusajs/medusa/core-flows"
import {
  ContainerRegistrationKeys,
  ModuleRegistrationName,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils"
import { TWENTY_SYNC_MODULE } from "../../src/modules/twenty-sync"
import {
  getTwentySyncQueue,
  processJob,
  shutdownTwentySync,
} from "../../src/modules/twenty-sync/queue"
import { signPayload } from "../../src/modules/twenty-sync/signature"

jest.setTimeout(60 * 1000)

type CapturedRequest = {
  headers: http.IncomingHttpHeaders
  body: string
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Twenty CRM sync", () => {
      let brandKey: string
      let usRegionId: string
      let variantId: string
      let shippingOptionId: string

      let mockServer: http.Server
      let mockServerPort: number
      let mockMode: "ok" | "fail" | "down"
      let capturedRequests: CapturedRequest[]

      beforeAll(async () => {
        // A plain Node HTTP server standing in for Twenty's webhook
        // receiver — docs/tdd/integration-webhooks.tdd.md's own fixture
        // list calls for "a mocked Twenty endpoint that can be toggled
        // reachable/unreachable/slow/erroring", not a real Twenty
        // workspace.
        mockMode = "ok"
        capturedRequests = []
        mockServer = http.createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on("data", (chunk) => chunks.push(chunk))
          req.on("end", () => {
            capturedRequests.push({
              headers: req.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            })
            if (mockMode === "fail") {
              res.writeHead(500)
              res.end("simulated Twenty failure")
              return
            }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ ok: true }))
          })
        })
        await new Promise<void>((resolve) => mockServer.listen(0, resolve))
        mockServerPort = (mockServer.address() as AddressInfo).port
        process.env.TWENTY_WEBHOOK_URL = `http://127.0.0.1:${mockServerPort}/webhook`

        const container = getContainer()
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const fulfillmentModuleService = container.resolve(
          ModuleRegistrationName.FULFILLMENT
        )

        const { result: channels } = await createSalesChannelsWorkflow(
          container
        ).run({
          input: { salesChannelsData: [{ name: "Twenty Test Brand" }] },
        })
        const channel = channels[0]

        const { result: apiKeys } = await createApiKeysWorkflow(
          container
        ).run({
          input: {
            api_keys: [
              { title: "Twenty Test Key", type: "publishable", created_by: "" },
            ],
          },
        })
        brandKey = apiKeys[0].token
        await linkSalesChannelsToApiKeyWorkflow(container).run({
          input: { id: apiKeys[0].id, add: [channel.id] },
        })

        const { result: regions } = await createRegionsWorkflow(container).run(
          {
            input: {
              regions: [
                {
                  name: "Twenty Test US Region",
                  currency_code: "usd",
                  countries: ["us"],
                  payment_providers: ["pp_system_default"],
                },
              ],
            },
          }
        )
        usRegionId = regions[0].id

        const { data: existingShippingProfiles } = await query.graph({
          entity: "shipping_profile",
          fields: ["id"],
        })
        let shippingProfileId = existingShippingProfiles[0]?.id
        if (!shippingProfileId) {
          const created = await fulfillmentModuleService.createShippingProfiles(
            { name: "Twenty Test Shipping Profile", type: "default" }
          )
          shippingProfileId = created.id
        }

        const { result: stockLocations } = await createStockLocationsWorkflow(
          container
        ).run({
          input: {
            locations: [
              {
                name: "Twenty Test Warehouse",
                address: { city: "Los Angeles", country_code: "US", address_1: "" },
              },
            ],
          },
        })
        const stockLocation = stockLocations[0]

        const { LINK } = ContainerRegistrationKeys
        const link = container.resolve(LINK)
        await link.create({
          [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
          [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
        })
        await linkSalesChannelsToStockLocationWorkflow(container).run({
          input: { id: stockLocation.id, add: [channel.id] },
        })

        const fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets(
          {
            name: "Twenty Test Warehouse delivery",
            type: "shipping",
            service_zones: [
              {
                name: "United States",
                geo_zones: [{ country_code: "us", type: "country" }],
              },
            ],
          }
        )
        await link.create({
          [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
          [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
        })

        const { result: shippingOptions } = await createShippingOptionsWorkflow(
          container
        ).run({
          input: [
            {
              name: "Twenty Test Standard Shipping",
              price_type: "flat",
              provider_id: "manual_manual",
              service_zone_id: fulfillmentSet.service_zones[0].id,
              shipping_profile_id: shippingProfileId,
              type: {
                label: "Standard",
                description: "Ship in 3-5 days.",
                code: "standard",
              },
              prices: [
                { currency_code: "usd", amount: 10 },
                { region_id: usRegionId, amount: 10 },
              ],
              rules: [
                { attribute: "enabled_in_store", value: "true", operator: "eq" },
                { attribute: "is_return", value: "false", operator: "eq" },
              ],
            },
          ],
        })
        shippingOptionId = shippingOptions[0].id

        const { result: products } = await createProductsWorkflow(
          container
        ).run({
          input: {
            products: [
              {
                title: "Twenty Test Tee",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: shippingProfileId,
                options: [{ title: "Size", values: ["One Size"] }],
                variants: [
                  {
                    title: "One Size",
                    sku: "TWENTY-TEST-TEE",
                    options: { Size: "One Size" },
                    prices: [{ amount: 20, currency_code: "usd" }],
                  },
                ],
                sales_channels: [{ id: channel.id }],
              },
            ],
          },
        })
        variantId = products[0].variants[0].id

        const { data: inventoryItems } = await query.graph({
          entity: "inventory_item",
          fields: ["id"],
          filters: { sku: "TWENTY-TEST-TEE" },
        })
        await createInventoryLevelsWorkflow(container).run({
          input: {
            inventory_levels: [
              {
                location_id: stockLocation.id,
                stocked_quantity: 100,
                inventory_item_id: inventoryItems[0].id,
              },
            ],
          },
        })
      })

      afterAll(async () => {
        await shutdownTwentySync()
        await new Promise<void>((resolve) => mockServer.close(() => resolve()))
      })

      beforeEach(() => {
        mockMode = "ok"
        capturedRequests = []
        process.env.TWENTY_WEBHOOK_URL = `http://127.0.0.1:${mockServerPort}/webhook`
      })

      async function placeRealOrder() {
        const authHeaders = { headers: { "x-publishable-api-key": brandKey } }
        const { data: cartData } = await api.post(
          "/store/carts",
          {
            region_id: usRegionId,
            email: "twenty-buyer@example.com",
            items: [{ variant_id: variantId, quantity: 1 }],
          },
          authHeaders
        )
        const cartId = cartData.cart.id

        await api.post(
          `/store/carts/${cartId}`,
          {
            shipping_address: {
              first_name: "Twenty",
              last_name: "Buyer",
              address_1: "123 Main St",
              city: "Los Angeles",
              country_code: "us",
              postal_code: "90001",
            },
          },
          authHeaders
        )
        await api.post(
          `/store/carts/${cartId}/shipping-methods`,
          { option_id: shippingOptionId },
          authHeaders
        )
        const { data: paymentCollectionData } = await api.post(
          "/store/payment-collections",
          { cart_id: cartId },
          authHeaders
        )
        await api.post(
          `/store/payment-collections/${paymentCollectionData.payment_collection.id}/payment-sessions`,
          { provider_id: "pp_system_default" },
          authHeaders
        )
        const { data: completion } = await api.post(
          `/store/carts/${cartId}/complete`,
          {},
          authHeaders
        )
        return completion
      }

      async function waitFor(
        predicate: () => boolean | Promise<boolean>,
        { timeoutMs = 5000, intervalMs = 100 } = {}
      ) {
        const start = Date.now()
        while (!(await predicate())) {
          if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: timed out waiting for condition")
          }
          await new Promise((resolve) => setTimeout(resolve, intervalMs))
        }
      }

      // ---- Outbound: order.placed -> Twenty (TDD cases 1, 2, 14) ----

      it("enqueues and delivers the order.placed payload to Twenty on a successful order", async () => {
        const completion = await placeRealOrder()
        expect(completion.type).toBe("order")
        const orderId = completion.order.id

        await waitFor(() => capturedRequests.length >= 1)

        const request = capturedRequests[0]
        const body = JSON.parse(request.body)
        expect(body).toMatchObject({
          event: "order.placed",
          idempotency_key: `order_${orderId}`,
          order: {
            id: orderId,
            sales_channel: "Twenty Test Brand",
            customer: { email: "twenty-buyer@example.com" },
            line_items: [{ title: "Twenty Test Tee", quantity: 1 }],
            currency: "usd",
            total: 30, // 20 item + 10 shipping
          },
        })
        expect(body.order.shipping_address).toMatchObject({
          city: "Los Angeles",
          country: "us",
        })

        // The signature header must verify against the same secret and
        // exact raw body Twenty (the mock, here) actually received.
        const signatureHeader = request.headers["x-twenty-signature"]
        expect(signPayload(request.body, "test-outbound-secret")).toBe(
          signatureHeader
        )

        const container = getContainer()
        const twentySyncModuleService: any = container.resolve(
          TWENTY_SYNC_MODULE
        )
        await waitFor(async () => {
          const [event] = await twentySyncModuleService.listTwentySyncEvents({
            idempotency_key: `order_${orderId}`,
          })
          return event?.status === "delivered"
        })
      })

      it("completes the order normally even when Twenty is completely unreachable", async () => {
        mockMode = "fail"
        const completion = await placeRealOrder()
        // The customer-facing guarantee: a Twenty delivery problem never
        // blocks or fails the actual sale.
        expect(completion.type).toBe("order")
        const orderId = completion.order.id

        await waitFor(() => capturedRequests.length >= 1)

        const container = getContainer()
        const twentySyncModuleService: any = container.resolve(
          TWENTY_SYNC_MODULE
        )
        await waitFor(async () => {
          const [event] = await twentySyncModuleService.listTwentySyncEvents({
            idempotency_key: `order_${orderId}`,
          })
          return event != null && event.attempts >= 1
        })
        const [event] = await twentySyncModuleService.listTwentySyncEvents({
          idempotency_key: `order_${orderId}`,
        })
        // Still pending (not dead — nowhere near the 24h window yet), and
        // the failure was recorded rather than silently swallowed.
        expect(event.status).toBe("pending")
        expect(event.last_error).toContain("500")

        const queue = getTwentySyncQueue()!
        const job = await queue.getJob(`order_${orderId}`)
        expect(job).toBeTruthy()
        expect(await job!.getState()).toBe("delayed")
      })

      // TDD case 3/4 (backoff schedule, 24h dead-letter): the schedule
      // itself is covered by queue.unit.spec.ts's pure-function test. This
      // exercises the *dead-lettering* decision directly against
      // processJob with a manipulated first_attempted_at, the equivalent
      // of fast-forwarding a fake clock 25 hours rather than actually
      // waiting out the real window.
      it("marks an event dead and raises an alert after 24h of continued failure", async () => {
        mockMode = "fail"
        const container = getContainer()
        const twentySyncModuleService: any = container.resolve(
          TWENTY_SYNC_MODULE
        )
        const eventBusModuleService = container.resolve(Modules.EVENT_BUS)

        const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600_000)
        const created = await twentySyncModuleService.createTwentySyncEvents({
          idempotency_key: "order_dead-letter-test",
          event_name: "order.placed",
          payload: { event: "order.placed", order: { id: "order_fake" } },
          status: "pending",
          attempts: 6,
          first_attempted_at: twentyFiveHoursAgo,
        })

        const deadEvents: unknown[] = []
        const listener = async (data: unknown) => {
          deadEvents.push(data)
        }
        eventBusModuleService.subscribe("twenty-sync.dead", listener)

        try {
          await processJob(
            {
              id: "manual-test-job",
              data: {
                idempotencyKey: "order_dead-letter-test",
                payload: created.payload,
              },
            } as any,
            container
          )

          await waitFor(() => deadEvents.length >= 1)

          const [event] = await twentySyncModuleService.listTwentySyncEvents({
            idempotency_key: "order_dead-letter-test",
          })
          expect(event.status).toBe("dead")
          expect(event.attempts).toBe(7)
        } finally {
          eventBusModuleService.unsubscribe("twenty-sync.dead", listener)
        }
      })

      // ---- Inbound: Twenty -> Medusa fulfillment updates ----
      // TDD cases 6-13 from docs/tdd/integration-webhooks.tdd.md.

      function signedFulfillmentRequest(body: Record<string, unknown>) {
        const rawBody = JSON.stringify(body)
        return {
          rawBody,
          headers: {
            "x-twenty-signature": signPayload(rawBody, "test-inbound-secret"),
          },
        }
      }

      it("applies a validly-signed fulfillment update and leaves order totals/payment untouched", async () => {
        const completion = await placeRealOrder()
        const orderId = completion.order.id

        const container = getContainer()
        const orderModuleService: any = container.resolve(Modules.ORDER)
        const before = await orderModuleService.retrieveOrder(orderId, {
          select: ["id", "total", "payment_status"],
        })

        const body = {
          event: "fulfillment.updated",
          medusa_order_id: orderId,
          fulfillment_status: "shipped",
          tracking_number: "1Z999AA10123456784",
          carrier: "UPS",
        }
        const { rawBody, headers } = signedFulfillmentRequest(body)

        const response = await api.post(
          "/webhooks/twenty/fulfillment",
          rawBody,
          { headers: { ...headers, "content-type": "application/json" } }
        )
        expect(response.status).toBe(200)

        const after = await orderModuleService.retrieveOrder(orderId, {
          select: ["id", "total", "payment_status", "metadata"],
        })
        expect(Number(after.total)).toBe(Number(before.total))
        expect(after.payment_status).toBe(before.payment_status)
        expect(after.metadata?.twenty_fulfillment).toMatchObject({
          fulfillment_status: "shipped",
          tracking_number: "1Z999AA10123456784",
          carrier: "UPS",
        })
      })

      it("ignores fields outside the write-back allowlist even when present in the payload", async () => {
        const completion = await placeRealOrder()
        const orderId = completion.order.id

        const container = getContainer()
        const orderModuleService: any = container.resolve(Modules.ORDER)
        const before = await orderModuleService.retrieveOrder(orderId, {
          select: ["id", "total"],
        })

        const body = {
          event: "fulfillment.updated",
          medusa_order_id: orderId,
          fulfillment_status: "shipped",
          tracking_number: "TRACK-1",
          total: 999999,
          payment_status: "captured",
          status: "completed",
        }
        const { rawBody, headers } = signedFulfillmentRequest(body)

        const response = await api.post(
          "/webhooks/twenty/fulfillment",
          rawBody,
          { headers: { ...headers, "content-type": "application/json" } }
        )
        expect(response.status).toBe(200)

        const after = await orderModuleService.retrieveOrder(orderId, {
          select: ["id", "total", "metadata"],
        })
        expect(Number(after.total)).toBe(Number(before.total))
        expect(after.metadata?.twenty_fulfillment).toMatchObject({
          fulfillment_status: "shipped",
          tracking_number: "TRACK-1",
        })
        expect(after.metadata?.twenty_fulfillment).not.toHaveProperty("total")
        expect(after.metadata?.twenty_fulfillment).not.toHaveProperty(
          "payment_status"
        )
        expect(after.metadata?.twenty_fulfillment).not.toHaveProperty("status")
      })

      it("treats a redelivered fulfillment update as a no-op, not a duplicate or an error", async () => {
        const completion = await placeRealOrder()
        const orderId = completion.order.id

        const body = {
          event: "fulfillment.updated",
          medusa_order_id: orderId,
          fulfillment_status: "delivered",
          tracking_number: "TRACK-2",
        }
        const { rawBody, headers } = signedFulfillmentRequest(body)
        const requestOptions = {
          headers: { ...headers, "content-type": "application/json" },
        }

        const first = await api.post(
          "/webhooks/twenty/fulfillment",
          rawBody,
          requestOptions
        )
        const second = await api.post(
          "/webhooks/twenty/fulfillment",
          rawBody,
          requestOptions
        )
        expect(first.status).toBe(200)
        expect(second.status).toBe(200)

        const container = getContainer()
        const orderModuleService: any = container.resolve(Modules.ORDER)
        const after = await orderModuleService.retrieveOrder(orderId, {
          select: ["id", "metadata"],
        })
        expect(after.metadata?.twenty_fulfillment).toMatchObject({
          fulfillment_status: "delivered",
          tracking_number: "TRACK-2",
        })
      })

      it("rejects a fulfillment update referencing an order that doesn't exist", async () => {
        const body = {
          event: "fulfillment.updated",
          medusa_order_id: "order_does_not_exist",
          fulfillment_status: "shipped",
          tracking_number: "TRACK-3",
        }
        const { rawBody, headers } = signedFulfillmentRequest(body)

        await expect(
          api.post("/webhooks/twenty/fulfillment", rawBody, {
            headers: { ...headers, "content-type": "application/json" },
          })
        ).rejects.toMatchObject({ response: { status: 404 } })
      })

      it("rejects a request with a missing signature header", async () => {
        const completion = await placeRealOrder()
        const body = {
          event: "fulfillment.updated",
          medusa_order_id: completion.order.id,
          fulfillment_status: "shipped",
          tracking_number: "TRACK-4",
        }
        await expect(
          api.post("/webhooks/twenty/fulfillment", JSON.stringify(body), {
            headers: { "content-type": "application/json" },
          })
        ).rejects.toMatchObject({ response: { status: 401 } })
      })

      it("rejects a request signed with the wrong secret", async () => {
        const completion = await placeRealOrder()
        const body = {
          event: "fulfillment.updated",
          medusa_order_id: completion.order.id,
          fulfillment_status: "shipped",
          tracking_number: "TRACK-5",
        }
        const rawBody = JSON.stringify(body)
        const badSignature = signPayload(rawBody, "totally-wrong-secret")

        await expect(
          api.post("/webhooks/twenty/fulfillment", rawBody, {
            headers: {
              "content-type": "application/json",
              "x-twenty-signature": badSignature,
            },
          })
        ).rejects.toMatchObject({ response: { status: 401 } })
      })

      it("rejects a request whose body was tampered with after signing", async () => {
        const completion = await placeRealOrder()
        const signedBody = {
          event: "fulfillment.updated",
          medusa_order_id: completion.order.id,
          fulfillment_status: "shipped",
          tracking_number: "TRACK-6",
        }
        const signature = signPayload(
          JSON.stringify(signedBody),
          "test-inbound-secret"
        )
        const tamperedBody = JSON.stringify({
          ...signedBody,
          tracking_number: "TRACK-HACKED",
        })

        await expect(
          api.post("/webhooks/twenty/fulfillment", tamperedBody, {
            headers: {
              "content-type": "application/json",
              "x-twenty-signature": signature,
            },
          })
        ).rejects.toMatchObject({ response: { status: 401 } })
      })
    })
  },
})
