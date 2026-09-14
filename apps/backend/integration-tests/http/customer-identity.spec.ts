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

// Covers TDD cases 1-4 from docs/tdd/medusa-customer-returns.tdd.md: a
// customer who registers on Brand A can log into Brand B with the same
// credentials against the same customer record (no duplicate), the auth
// token isn't scoped to either brand's publishable key, and order history
// spans both brands tagged with their originating sales_channel_id.
//
// Case 5 (expired-JWT/refresh flow) isn't covered — it needs a
// configurable short-lived token and is about token-expiry mechanics, not
// the cross-brand identity guarantee this project actually cares about.
jest.setTimeout(60 * 1000)

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Shared customer identity across brands", () => {
      let brandAKey: string
      let brandBKey: string
      let usRegionId: string
      let jpRegionId: string
      let variantId: string
      let usShippingOptionId: string
      let jpShippingOptionId: string

      const email = "jane@example.com"
      const password = "supersecret123"

      beforeAll(async () => {
        const container = getContainer()
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const link = container.resolve(ContainerRegistrationKeys.LINK)
        const fulfillmentModuleService = container.resolve(
          ModuleRegistrationName.FULFILLMENT
        )

        const { result: channels } = await createSalesChannelsWorkflow(
          container
        ).run({
          input: {
            salesChannelsData: [
              { name: "Identity Test Brand A" },
              { name: "Identity Test Brand B" },
            ],
          },
        })
        const brandA = channels.find((c) => c.name === "Identity Test Brand A")!
        const brandB = channels.find((c) => c.name === "Identity Test Brand B")!

        const { result: apiKeys } = await createApiKeysWorkflow(
          container
        ).run({
          input: {
            api_keys: [
              {
                title: "Identity Test Brand A Key",
                type: "publishable",
                created_by: "",
              },
              {
                title: "Identity Test Brand B Key",
                type: "publishable",
                created_by: "",
              },
            ],
          },
        })
        const brandAApiKey = apiKeys.find(
          (k) => k.title === "Identity Test Brand A Key"
        )!
        const brandBApiKey = apiKeys.find(
          (k) => k.title === "Identity Test Brand B Key"
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
                  name: "Identity Test US Region",
                  currency_code: "usd",
                  countries: ["us"],
                  payment_providers: ["pp_system_default"],
                },
                {
                  name: "Identity Test JP Region",
                  currency_code: "jpy",
                  countries: ["jp"],
                  payment_providers: ["pp_system_default"],
                },
              ],
            },
          }
        )
        usRegionId = regions.find((r) => r.currency_code === "usd")!.id
        jpRegionId = regions.find((r) => r.currency_code === "jpy")!.id

        const { data: existingShippingProfiles } = await query.graph({
          entity: "shipping_profile",
          fields: ["id"],
        })
        let shippingProfileId = existingShippingProfiles[0]?.id
        if (!shippingProfileId) {
          const created = await fulfillmentModuleService.createShippingProfiles(
            { name: "Identity Test Shipping Profile", type: "default" }
          )
          shippingProfileId = created.id
        }

        const { result: stockLocations } = await createStockLocationsWorkflow(
          container
        ).run({
          input: {
            locations: [
              {
                name: "Identity Test Warehouse",
                address: {
                  city: "Los Angeles",
                  country_code: "US",
                  address_1: "",
                },
              },
            ],
          },
        })
        const stockLocation = stockLocations[0]

        await link.create({
          [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
          [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
        })

        const fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
          name: "Identity Test Warehouse delivery",
          type: "shipping",
          service_zones: [
            {
              name: "United States",
              geo_zones: [{ country_code: "us", type: "country" }],
            },
            {
              name: "Japan",
              geo_zones: [{ country_code: "jp", type: "country" }],
            },
          ],
        })

        await link.create({
          [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
          [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
        })

        const usZone = fulfillmentSet.service_zones.find(
          (z) => z.name === "United States"
        )!
        const jpZone = fulfillmentSet.service_zones.find(
          (z) => z.name === "Japan"
        )!

        const { result: shippingOptions } = await createShippingOptionsWorkflow(
          container
        ).run({
          input: [
            {
              name: "Standard Shipping",
              price_type: "flat",
              provider_id: "manual_manual",
              service_zone_id: usZone.id,
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
            {
              name: "Standard Shipping",
              price_type: "flat",
              provider_id: "manual_manual",
              service_zone_id: jpZone.id,
              shipping_profile_id: shippingProfileId,
              type: {
                label: "Standard",
                description: "Ship in 3-5 days.",
                code: "standard",
              },
              prices: [
                { currency_code: "jpy", amount: 1000 },
                { region_id: jpRegionId, amount: 1000 },
              ],
              rules: [
                { attribute: "enabled_in_store", value: "true", operator: "eq" },
                { attribute: "is_return", value: "false", operator: "eq" },
              ],
            },
          ],
        })
        usShippingOptionId = shippingOptions.find(
          (o) => o.service_zone_id === usZone.id
        )!.id
        jpShippingOptionId = shippingOptions.find(
          (o) => o.service_zone_id === jpZone.id
        )!.id

        await linkSalesChannelsToStockLocationWorkflow(container).run({
          input: {
            id: stockLocation.id,
            add: [brandA.id, brandB.id],
          },
        })

        const { result: products } = await createProductsWorkflow(
          container
        ).run({
          input: {
            products: [
              {
                title: "Identity Test Tee",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: shippingProfileId,
                options: [{ title: "Size", values: ["One Size"] }],
                variants: [
                  {
                    title: "One Size",
                    sku: "IDENTITY-TEST-TEE",
                    options: { Size: "One Size" },
                    prices: [
                      { amount: 20, currency_code: "usd" },
                      { amount: 3000, currency_code: "jpy" },
                    ],
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
          filters: { sku: "IDENTITY-TEST-TEE" },
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

      async function placeOrder(
        regionId: string,
        publishableKey: string,
        shippingOptionId: string,
        countryCode: string,
        authToken: string
      ) {
        const authHeaders = {
          headers: {
            "x-publishable-api-key": publishableKey,
            authorization: `Bearer ${authToken}`,
          },
        }

        const { data: cartData } = await api.post(
          "/store/carts",
          {
            region_id: regionId,
            email,
            items: [{ variant_id: variantId, quantity: 1 }],
          },
          authHeaders
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
              country_code: countryCode,
              postal_code: "00000",
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
        const paymentCollectionId = paymentCollectionData.payment_collection.id

        await api.post(
          `/store/payment-collections/${paymentCollectionId}/payment-sessions`,
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

      // One test, not two: medusaIntegrationTestRunner restores the database
      // to the post-beforeAll snapshot before every `it`, so a customer
      // registered in one test does not exist in the next — this whole
      // customer journey has to run as a single scenario.
      it("logs in on Brand B against the same customer, and shows order history from both brands", async () => {
        const { data: registerData } = await api.post(
          "/auth/customer/emailpass/register",
          { email, password },
          { headers: { "x-publishable-api-key": brandAKey } }
        )
        const registrationToken = registerData.token

        const { data: customerData } = await api.post(
          "/store/customers",
          { email, first_name: "Jane", last_name: "Doe" },
          {
            headers: {
              "x-publishable-api-key": brandAKey,
              authorization: `Bearer ${registrationToken}`,
            },
          }
        )
        const customerId = customerData.customer.id

        // Log in on Brand B with the same credentials.
        const { data: loginData } = await api.post(
          "/auth/customer/emailpass",
          { email, password },
          { headers: { "x-publishable-api-key": brandBKey } }
        )
        const token = loginData.token

        const { data: meFromB } = await api.get("/store/customers/me", {
          headers: {
            "x-publishable-api-key": brandBKey,
            authorization: `Bearer ${token}`,
          },
        })
        expect(meFromB.customer.id).toBe(customerId)

        // The same token also works presented against Brand A's key — auth
        // identity isn't scoped to whichever publishable key made the call.
        const { data: meFromA } = await api.get("/store/customers/me", {
          headers: {
            "x-publishable-api-key": brandAKey,
            authorization: `Bearer ${token}`,
          },
        })
        expect(meFromA.customer.id).toBe(customerId)

        await placeOrder(usRegionId, brandAKey, usShippingOptionId, "us", token)
        await placeOrder(jpRegionId, brandBKey, jpShippingOptionId, "jp", token)

        const { data: ordersData } = await api.get(
          "/store/orders?fields=id,sales_channel_id",
          {
            headers: {
              "x-publishable-api-key": brandAKey,
              authorization: `Bearer ${token}`,
            },
          }
        )

        expect(ordersData.orders.length).toBe(2)
        const channelIds = ordersData.orders.map(
          (o: { sales_channel_id: string }) => o.sales_channel_id
        )
        expect(new Set(channelIds).size).toBe(2)
      })
    })
  },
})
