import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  createPromotionsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createStockLocationsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from "@medusajs/medusa/core-flows";
import {
  ContainerRegistrationKeys,
  ModuleRegistrationName,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";

// Covers docs/tdd/medusa-discounts-giftcards.tdd.md cases 1-5: a
// channel-scoped discount only applies on its own brand, a global
// percentage discount applies on both brands in their own currency, and a
// fixed-amount discount is locked to the currency it was created in.
// Gift cards are out of scope here — see that TDD doc's scope note: Medusa
// v2 has no gift-card module to test against.
jest.setTimeout(60 * 1000);

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Discount scope and currency locking", () => {
      let brandAKey: string;
      let brandBKey: string;
      let usRegionId: string;
      let jpRegionId: string;
      let variantId: string;
      let brandAOnlyCode: string;
      let globalCode: string;
      let usdFixedCode: string;

      beforeAll(async () => {
        const container = getContainer();
        const query = container.resolve(ContainerRegistrationKeys.QUERY);
        const fulfillmentModuleService = container.resolve(
          ModuleRegistrationName.FULFILLMENT
        );

        const { result: channels } = await createSalesChannelsWorkflow(
          container
        ).run({
          input: {
            salesChannelsData: [
              { name: "Discount Test Brand A" },
              { name: "Discount Test Brand B" },
            ],
          },
        });
        const brandA = channels.find((c) => c.name === "Discount Test Brand A")!;
        const brandB = channels.find((c) => c.name === "Discount Test Brand B")!;

        const { result: apiKeys } = await createApiKeysWorkflow(
          container
        ).run({
          input: {
            api_keys: [
              {
                title: "Discount Test Brand A Key",
                type: "publishable",
                created_by: "",
              },
              {
                title: "Discount Test Brand B Key",
                type: "publishable",
                created_by: "",
              },
            ],
          },
        });
        const brandAApiKey = apiKeys.find(
          (k) => k.title === "Discount Test Brand A Key"
        )!;
        const brandBApiKey = apiKeys.find(
          (k) => k.title === "Discount Test Brand B Key"
        )!;
        brandAKey = brandAApiKey.token;
        brandBKey = brandBApiKey.token;

        await linkSalesChannelsToApiKeyWorkflow(container).run({
          input: { id: brandAApiKey.id, add: [brandA.id] },
        });
        await linkSalesChannelsToApiKeyWorkflow(container).run({
          input: { id: brandBApiKey.id, add: [brandB.id] },
        });

        const { result: regions } = await createRegionsWorkflow(container).run({
          input: {
            regions: [
              {
                name: "Discount Test US Region",
                currency_code: "usd",
                countries: ["us"],
                payment_providers: ["pp_system_default"],
              },
              {
                name: "Discount Test JP Region",
                currency_code: "jpy",
                countries: ["jp"],
                payment_providers: ["pp_system_default"],
              },
            ],
          },
        });
        usRegionId = regions.find((r) => r.currency_code === "usd")!.id;
        jpRegionId = regions.find((r) => r.currency_code === "jpy")!.id;

        const { data: existingShippingProfiles } = await query.graph({
          entity: "shipping_profile",
          fields: ["id"],
        });
        let shippingProfileId = existingShippingProfiles[0]?.id;
        if (!shippingProfileId) {
          const created = await fulfillmentModuleService.createShippingProfiles(
            { name: "Discount Test Shipping Profile", type: "default" }
          );
          shippingProfileId = created.id;
        }

        // Adding a line item to a cart validates inventory availability at a
        // stock location tied to the cart's sales channel, so a stock
        // location has to exist and be linked to both brands even though
        // this test never completes an order.
        const { result: stockLocations } = await createStockLocationsWorkflow(
          container
        ).run({
          input: {
            locations: [
              {
                name: "Discount Test Warehouse",
                address: { city: "Los Angeles", country_code: "US", address_1: "" },
              },
            ],
          },
        });
        const stockLocation = stockLocations[0];

        const link = container.resolve(ContainerRegistrationKeys.LINK);
        await link.create({
          [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
          [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
        });

        await linkSalesChannelsToStockLocationWorkflow(container).run({
          input: { id: stockLocation.id, add: [brandA.id, brandB.id] },
        });

        const { result: products } = await createProductsWorkflow(
          container
        ).run({
          input: {
            products: [
              {
                title: "Discount Test Tee",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: shippingProfileId,
                options: [{ title: "Size", values: ["One Size"] }],
                variants: [
                  {
                    title: "One Size",
                    sku: "DISCOUNT-TEST-TEE",
                    options: { Size: "One Size" },
                    prices: [
                      { amount: 100, currency_code: "usd" },
                      { amount: 10000, currency_code: "jpy" },
                    ],
                  },
                ],
                sales_channels: [{ id: brandA.id }, { id: brandB.id }],
              },
            ],
          },
        });
        variantId = products[0].variants[0].id;

        const { data: inventoryItems } = await query.graph({
          entity: "inventory_item",
          fields: ["id"],
          filters: { sku: "DISCOUNT-TEST-TEE" },
        });
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
        });

        brandAOnlyCode = "BRANDA10";
        globalCode = "GLOBAL10";
        usdFixedCode = "USD5OFF";

        await createPromotionsWorkflow(container).run({
          input: {
            promotionsData: [
              {
                code: brandAOnlyCode,
                type: "standard",
                status: "active",
                application_method: {
                  type: "percentage",
                  target_type: "items",
                  allocation: "across",
                  value: 10,
                },
                rules: [
                  {
                    attribute: "sales_channel_id",
                    operator: "eq",
                    values: [brandA.id],
                  },
                ],
              },
              {
                code: globalCode,
                type: "standard",
                status: "active",
                application_method: {
                  type: "percentage",
                  target_type: "items",
                  allocation: "across",
                  value: 10,
                },
              },
              {
                code: usdFixedCode,
                type: "standard",
                status: "active",
                application_method: {
                  type: "fixed",
                  target_type: "items",
                  allocation: "across",
                  value: 5,
                  currency_code: "usd",
                },
              },
            ],
          },
        });
      });

      async function createCartWithItem(
        regionId: string,
        publishableKey: string
      ) {
        const { data } = await api.post(
          "/store/carts",
          { region_id: regionId, items: [{ variant_id: variantId, quantity: 1 }] },
          { headers: { "x-publishable-api-key": publishableKey } }
        );
        return data.cart;
      }

      async function applyCode(
        cartId: string,
        code: string,
        publishableKey: string
      ) {
        const { data } = await api.post(
          `/store/carts/${cartId}/promotions`,
          { promo_codes: [code] },
          { headers: { "x-publishable-api-key": publishableKey } }
        );
        return data.cart;
      }

      it("applies a channel-scoped discount on its own brand's cart", async () => {
        const cart = await createCartWithItem(usRegionId, brandAKey);
        const discounted = await applyCode(cart.id, brandAOnlyCode, brandAKey);
        expect(discounted.discount_total).toBeGreaterThan(0);
        expect(discounted.total).toBeLessThan(cart.total);
      });

      it("does not apply a channel-scoped discount on the other brand's cart", async () => {
        const cart = await createCartWithItem(jpRegionId, brandBKey);
        const afterApply = await applyCode(cart.id, brandAOnlyCode, brandBKey);
        expect(afterApply.discount_total ?? 0).toBe(0);
        expect(afterApply.total).toBe(cart.total);
      });

      it("applies a global percentage discount on both brands, in their own currency", async () => {
        const cartA = await createCartWithItem(usRegionId, brandAKey);
        const cartB = await createCartWithItem(jpRegionId, brandBKey);

        const discountedA = await applyCode(cartA.id, globalCode, brandAKey);
        const discountedB = await applyCode(cartB.id, globalCode, brandBKey);

        expect(discountedA.currency_code).toBe("usd");
        expect(discountedA.total).toBe(cartA.total - discountedA.discount_total);
        expect(discountedA.discount_total).toBeCloseTo(cartA.total * 0.1, 1);

        expect(discountedB.currency_code).toBe("jpy");
        expect(discountedB.total).toBe(cartB.total - discountedB.discount_total);
        expect(discountedB.discount_total).toBeCloseTo(cartB.total * 0.1, 1);
      });

      it("applies a USD fixed-amount discount on a USD cart", async () => {
        const cart = await createCartWithItem(usRegionId, brandAKey);
        const discounted = await applyCode(cart.id, usdFixedCode, brandAKey);
        expect(discounted.discount_total).toBe(5);
        expect(discounted.total).toBe(cart.total - 5);
      });

      it("does not apply a USD fixed-amount discount on a JPY cart", async () => {
        const cart = await createCartWithItem(jpRegionId, brandBKey);
        const afterApply = await applyCode(cart.id, usdFixedCode, brandBKey);
        expect(afterApply.discount_total ?? 0).toBe(0);
        expect(afterApply.total).toBe(cart.total);
      });
    });
  },
});
