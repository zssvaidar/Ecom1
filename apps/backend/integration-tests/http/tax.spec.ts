import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createPricePreferencesWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createTaxRatesWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  createStockLocationsWorkflow,
} from "@medusajs/medusa/core-flows"
import {
  ContainerRegistrationKeys,
  ModuleRegistrationName,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils"

// Covers docs/specs/01-medusa-config.md's tax "Done means": JP consumption tax
// (10%, tax-inclusive pricing) computes correctly on a cart; US carries no
// rate yet (that spec marks the exact provider/rate-table approach as still
// TBD, since US sales tax varies by state) so its cart shows zero tax rather
// than a made-up flat rate.
jest.setTimeout(60 * 1000)

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Tax configuration", () => {
      let brandKey: string
      let usRegionId: string
      let jpRegionId: string
      let variantId: string

      beforeAll(async () => {
        const container = getContainer()
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const link = container.resolve(ContainerRegistrationKeys.LINK)
        const fulfillmentModuleService = container.resolve(
          ModuleRegistrationName.FULFILLMENT
        )
        const pricingModuleService = container.resolve(
          ModuleRegistrationName.PRICING
        )

        const { result: channels } = await createSalesChannelsWorkflow(
          container
        ).run({
          input: { salesChannelsData: [{ name: "Tax Test Brand" }] },
        })
        const channel = channels[0]

        const { result: apiKeys } = await createApiKeysWorkflow(
          container
        ).run({
          input: {
            api_keys: [
              { title: "Tax Test Key", type: "publishable", created_by: "" },
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
                  name: "Tax Test US Region",
                  currency_code: "usd",
                  countries: ["us"],
                  payment_providers: ["pp_system_default"],
                },
                {
                  name: "Tax Test JP Region",
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

        const { result: taxRegions } = await createTaxRegionsWorkflow(
          container
        ).run({
          input: [
            { country_code: "us", provider_id: "tp_system" },
            { country_code: "jp", provider_id: "tp_system" },
          ],
        })
        const jpTaxRegion = taxRegions.find((r) => r.country_code === "jp")!

        await createTaxRatesWorkflow(container).run({
          input: [
            {
              tax_region_id: jpTaxRegion.id,
              name: "Consumption Tax",
              code: "JP_CONSUMPTION",
              rate: 10,
              is_default: true,
            },
          ],
        })

        // Tax-inclusivity is resolved from the *currency-level* preference
        // when a price was set by currency_code (as this test's product
        // prices are) — a region-level preference only applies if the price
        // also carries a region_id price rule. See the identical comment in
        // src/migration-scripts/initial-data-seed.ts for how this was found.
        // Unlike the real seed script, this test never runs
        // createStoresWorkflow, so no default "jpy" preference exists yet —
        // create one instead of updating an existing one.
        const [existingJpyPricePreference] =
          await pricingModuleService.listPricePreferences({
            attribute: "currency_code",
            value: "jpy",
          })
        if (existingJpyPricePreference) {
          await pricingModuleService.updatePricePreferences(
            existingJpyPricePreference.id,
            { is_tax_inclusive: true }
          )
        } else {
          await createPricePreferencesWorkflow(container).run({
            input: [
              { attribute: "currency_code", value: "jpy", is_tax_inclusive: true },
            ],
          })
        }

        const { data: existingShippingProfiles } = await query.graph({
          entity: "shipping_profile",
          fields: ["id"],
        })
        let shippingProfileId = existingShippingProfiles[0]?.id
        if (!shippingProfileId) {
          const created = await fulfillmentModuleService.createShippingProfiles(
            { name: "Tax Test Shipping Profile", type: "default" }
          )
          shippingProfileId = created.id
        }

        const { result: stockLocations } = await createStockLocationsWorkflow(
          container
        ).run({
          input: {
            locations: [
              {
                name: "Tax Test Warehouse",
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
        await linkSalesChannelsToStockLocationWorkflow(container).run({
          input: { id: stockLocation.id, add: [channel.id] },
        })

        const { result: products } = await createProductsWorkflow(
          container
        ).run({
          input: {
            products: [
              {
                title: "Tax Test Tee",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: shippingProfileId,
                options: [{ title: "Size", values: ["One Size"] }],
                variants: [
                  {
                    title: "One Size",
                    sku: "TAX-TEST-TEE",
                    options: { Size: "One Size" },
                    prices: [
                      { amount: 20, currency_code: "usd" },
                      { amount: 3300, currency_code: "jpy" },
                    ],
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
          filters: { sku: "TAX-TEST-TEE" },
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

      async function createCartWithItem(regionId: string, countryCode: string) {
        const { data: cartData } = await api.post(
          "/store/carts",
          {
            region_id: regionId,
            items: [{ variant_id: variantId, quantity: 1 }],
          },
          { headers: { "x-publishable-api-key": brandKey } }
        )
        await api.post(
          `/store/carts/${cartData.cart.id}`,
          { shipping_address: { country_code: countryCode } },
          { headers: { "x-publishable-api-key": brandKey } }
        )
        const { data: refreshed } = await api.get(
          `/store/carts/${cartData.cart.id}`,
          { headers: { "x-publishable-api-key": brandKey } }
        )
        return refreshed.cart
      }

      it("computes 10% tax-inclusive consumption tax on a JP cart", async () => {
        const cart = await createCartWithItem(jpRegionId, "jp")

        expect(cart.currency_code).toBe("jpy")
        expect(cart.item_total).toBe(3300)
        // Tax-inclusive: the 3300 already contains 10% tax, so the tax
        // portion backed out is 3300 - 3300/1.1 = 300.
        expect(cart.tax_total).toBe(300)
        // The customer-facing total does not change because of tax — it's
        // already included in the price they saw on the product page.
        expect(cart.total).toBe(3300)
      })

      it("shows zero tax on a US cart (no rate configured yet)", async () => {
        const cart = await createCartWithItem(usRegionId, "us")

        expect(cart.currency_code).toBe("usd")
        expect(cart.item_total).toBe(20)
        expect(cart.tax_total).toBe(0)
        expect(cart.total).toBe(20)
      })
    })
  },
})
