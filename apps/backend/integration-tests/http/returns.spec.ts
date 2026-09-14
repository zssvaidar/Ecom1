import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createStockLocationsWorkflow,
  createUserAccountWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from "@medusajs/medusa/core-flows"
import {
  ContainerRegistrationKeys,
  ModuleRegistrationName,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils"

// Covers TDD case 6 from docs/tdd/medusa-customer-returns.tdd.md: a partial
// return restocks only the returned quantity — not the whole order — to the
// shared inventory pool both brands draw from (docs/specs/02-catalog-
// inventory.md, docs/specs/06-returns.md).
//
// Cases 7-8 (return-window rejection, full-order return/refund) and the
// refund-currency assertion (delegated to medusa-checkout-payments.tdd.md
// case 7) aren't covered here: the refund half needs the same Stripe
// credentials/mocking that's already blocked (see that TDD doc's "Mocking
// Stripe" section), and isn't attempted again blind.
jest.setTimeout(60 * 1000)

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Partial return restocks only the returned quantity", () => {
      let brandAKey: string
      let brandBKey: string
      let usRegionId: string
      let variantId: string
      let usShippingOptionId: string
      let stockLocationId: string
      let inventoryItemId: string
      let adminToken: string

      const adminEmail = "returns-admin@example.com"
      const adminPassword = "supersecret123"

      beforeAll(async () => {
        const container = getContainer()
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const link = container.resolve(ContainerRegistrationKeys.LINK)
        const fulfillmentModuleService = container.resolve(
          ModuleRegistrationName.FULFILLMENT
        )

        // Admin users go through an invite-accept flow, not open self-
        // registration (docs/specs/01-medusa-config.md's staff-role gap is
        // the same underlying reason). For a test that only needs *an*
        // admin actor, register the auth identity over HTTP the same way
        // the real invite-accept flow ends up doing, then attach a user to
        // it directly via the workflow the accept-invite route itself
        // calls — see createUserAccountWorkflow's own doc comment, which
        // names this exact HTTP route as the first step.
        const { data: registerData } = await api.post(
          "/auth/user/emailpass/register",
          { email: adminEmail, password: adminPassword }
        )
        const registrationToken: string = registerData.token
        const payload = JSON.parse(
          Buffer.from(registrationToken.split(".")[1], "base64").toString()
        )
        await createUserAccountWorkflow(container).run({
          input: {
            authIdentityId: payload.auth_identity_id,
            userData: {
              email: adminEmail,
              first_name: "Returns",
              last_name: "Admin",
            },
          },
        })
        const { data: loginData } = await api.post("/auth/user/emailpass", {
          email: adminEmail,
          password: adminPassword,
        })
        adminToken = loginData.token

        const { result: channels } = await createSalesChannelsWorkflow(
          container
        ).run({
          input: {
            salesChannelsData: [
              { name: "Returns Test Brand A" },
              { name: "Returns Test Brand B" },
            ],
          },
        })
        const brandA = channels.find((c) => c.name === "Returns Test Brand A")!
        const brandB = channels.find((c) => c.name === "Returns Test Brand B")!

        const { result: apiKeys } = await createApiKeysWorkflow(
          container
        ).run({
          input: {
            api_keys: [
              {
                title: "Returns Test Brand A Key",
                type: "publishable",
                created_by: "",
              },
              {
                title: "Returns Test Brand B Key",
                type: "publishable",
                created_by: "",
              },
            ],
          },
        })
        const brandAApiKey = apiKeys.find(
          (k) => k.title === "Returns Test Brand A Key"
        )!
        const brandBApiKey = apiKeys.find(
          (k) => k.title === "Returns Test Brand B Key"
        )!
        brandAKey = brandAApiKey.token
        brandBKey = brandBApiKey.token
        await linkSalesChannelsToApiKeyWorkflow(container).run({
          input: { id: brandAApiKey.id, add: [brandA.id] },
        })
        await linkSalesChannelsToApiKeyWorkflow(container).run({
          input: { id: brandBApiKey.id, add: [brandB.id] },
        })

        const { result: regions } = await createRegionsWorkflow(container).run(
          {
            input: {
              regions: [
                {
                  name: "Returns Test US Region",
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
            { name: "Returns Test Shipping Profile", type: "default" }
          )
          shippingProfileId = created.id
        }

        const { result: stockLocations } = await createStockLocationsWorkflow(
          container
        ).run({
          input: {
            locations: [
              {
                name: "Returns Test Warehouse",
                address: {
                  city: "Los Angeles",
                  country_code: "US",
                  address_1: "",
                },
              },
            ],
          },
        })
        stockLocationId = stockLocations[0].id

        await link.create({
          [Modules.STOCK_LOCATION]: { stock_location_id: stockLocationId },
          [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
        })

        const fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
          name: "Returns Test Warehouse delivery",
          type: "shipping",
          service_zones: [
            {
              name: "United States",
              geo_zones: [{ country_code: "us", type: "country" }],
            },
          ],
        })

        await link.create({
          [Modules.STOCK_LOCATION]: { stock_location_id: stockLocationId },
          [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
        })

        const { result: shippingOptions } = await createShippingOptionsWorkflow(
          container
        ).run({
          input: [
            {
              name: "Standard Shipping",
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
        usShippingOptionId = shippingOptions[0].id

        // Both brands draw from this one location — the shared pool a
        // restock must become visible on immediately.
        await linkSalesChannelsToStockLocationWorkflow(container).run({
          input: { id: stockLocationId, add: [brandA.id, brandB.id] },
        })

        const { result: products } = await createProductsWorkflow(
          container
        ).run({
          input: {
            products: [
              {
                title: "Returns Test Tee",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: shippingProfileId,
                options: [{ title: "Size", values: ["One Size"] }],
                variants: [
                  {
                    title: "One Size",
                    sku: "RETURNS-TEST-TEE",
                    options: { Size: "One Size" },
                    prices: [{ amount: 20, currency_code: "usd" }],
                  },
                ],
                sales_channels: [{ id: brandA.id }, { id: brandB.id }],
              },
            ],
          },
        })
        variantId = products[0].variants[0].id

        const { data: inventoryItems } = await query.graph({
          entity: "inventory_item",
          fields: ["id"],
          filters: { sku: "RETURNS-TEST-TEE" },
        })
        inventoryItemId = inventoryItems[0].id

        await createInventoryLevelsWorkflow(container).run({
          input: {
            inventory_levels: [
              {
                location_id: stockLocationId,
                stocked_quantity: 10,
                inventory_item_id: inventoryItemId,
              },
            ],
          },
        })
      })

      async function getAvailableQuantity() {
        const { data: levels } = await getContainer()
          .resolve(ContainerRegistrationKeys.QUERY)
          .graph({
            entity: "inventory_level",
            fields: ["stocked_quantity", "reserved_quantity"],
            filters: { inventory_item_id: inventoryItemId },
          })
        const level = levels[0]
        return level.stocked_quantity - level.reserved_quantity
      }

      it("restocks only the returned quantity, not the full order", async () => {
        const storeHeaders = {
          headers: { "x-publishable-api-key": brandAKey },
        }
        const adminHeaders = {
          headers: { authorization: `Bearer ${adminToken}` },
        }

        const availableBeforeOrder = await getAvailableQuantity()

        const { data: cartData } = await api.post(
          "/store/carts",
          {
            region_id: usRegionId,
            email: "returns-customer@example.com",
            items: [{ variant_id: variantId, quantity: 3 }],
          },
          storeHeaders
        )
        const cartId = cartData.cart.id

        await api.post(
          `/store/carts/${cartId}`,
          {
            shipping_address: {
              first_name: "Jane",
              last_name: "Doe",
              address_1: "123 Main St",
              city: "Test City",
              country_code: "us",
              postal_code: "00000",
            },
          },
          storeHeaders
        )
        await api.post(
          `/store/carts/${cartId}/shipping-methods`,
          { option_id: usShippingOptionId },
          storeHeaders
        )
        const { data: paymentCollectionData } = await api.post(
          "/store/payment-collections",
          { cart_id: cartId },
          storeHeaders
        )
        await api.post(
          `/store/payment-collections/${paymentCollectionData.payment_collection.id}/payment-sessions`,
          { provider_id: "pp_system_default" },
          storeHeaders
        )
        const { data: completion } = await api.post(
          `/store/carts/${cartId}/complete`,
          {},
          storeHeaders
        )
        expect(completion.type).toBe("order")
        const orderId = completion.order.id

        const availableAfterOrder = await getAvailableQuantity()
        expect(availableAfterOrder).toBe(availableBeforeOrder - 3)

        const { data: orderData } = await api.get(
          `/admin/orders/${orderId}?fields=id,items.id,items.quantity,items.variant_id`,
          adminHeaders
        )
        const lineItem = orderData.order.items.find(
          (item: { variant_id: string }) => item.variant_id === variantId
        )

        // A return can only cover fulfilled quantity ("Cannot request to
        // return more items than what was fulfilled" — found by running
        // this test without it) — mirrors the real flow where a customer
        // can't return an item that hasn't shipped yet.
        await api.post(
          `/admin/orders/${orderId}/fulfillments`,
          {
            location_id: stockLocationId,
            items: [{ id: lineItem.id, quantity: 3 }],
          },
          adminHeaders
        )

        const { data: returnData } = await api.post(
          "/admin/returns",
          { order_id: orderId, location_id: stockLocationId },
          adminHeaders
        )
        const returnId = returnData.return.id

        await api.post(
          `/admin/returns/${returnId}/request-items`,
          { items: [{ id: lineItem.id, quantity: 1 }] },
          adminHeaders
        )
        await api.post(`/admin/returns/${returnId}/request`, {}, adminHeaders)
        await api.post(`/admin/returns/${returnId}/receive`, {}, adminHeaders)
        await api.post(
          `/admin/returns/${returnId}/receive-items`,
          { items: [{ id: lineItem.id, quantity: 1 }] },
          adminHeaders
        )
        await api.post(
          `/admin/returns/${returnId}/receive/confirm`,
          {},
          adminHeaders
        )

        const availableAfterReturn = await getAvailableQuantity()
        // Only 1 of the 3 sold units was returned — the pool goes up by 1,
        // not back to the pre-order level (which would mean all 3 restocked).
        expect(availableAfterReturn).toBe(availableAfterOrder + 1)
        expect(availableAfterReturn).toBeLessThan(availableBeforeOrder)
      })
    })
  },
})
