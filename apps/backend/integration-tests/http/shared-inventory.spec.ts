import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
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
} from "@medusajs/medusa/core-flows";
import {
  ContainerRegistrationKeys,
  ModuleRegistrationName,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";

// Covers TDD cases 4-7 from docs/tdd/medusa-catalog.tdd.md: a cross-listed
// variant backed by one shared inventory item must decrement when an order
// completes via one brand — the item is not scoped to a sales channel, so
// both brands read the same stocked/reserved numbers by construction. Cases
// 5-7 (zero-stock rejection, immediate restock visibility, concurrent-
// checkout oversell prevention) are covered further down.
jest.setTimeout(60 * 1000);

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Shared inventory pool across brands", () => {
      let brandAKey: string;
      let brandBKey: string;
      let usRegionId: string;
      let variantId: string;
      let inventoryItemId: string;
      let shippingOptionId: string;
      let outOfStockVariantId: string;
      let outOfStockInventoryItemId: string;
      let lastUnitVariantId: string;
      let lastUnitInventoryItemId: string;
      let stockLocationId: string;

      beforeAll(async () => {
        const container = getContainer();
        const query = container.resolve(ContainerRegistrationKeys.QUERY);
        const link = container.resolve(ContainerRegistrationKeys.LINK);
        const fulfillmentModuleService = container.resolve(
          ModuleRegistrationName.FULFILLMENT
        );

        const { result: channels } = await createSalesChannelsWorkflow(
          container
        ).run({
          input: {
            salesChannelsData: [
              { name: "Inv Test Brand A" },
              { name: "Inv Test Brand B" },
            ],
          },
        });
        const brandA = channels.find((c) => c.name === "Inv Test Brand A")!;
        const brandB = channels.find((c) => c.name === "Inv Test Brand B")!;

        const { result: apiKeys } = await createApiKeysWorkflow(
          container
        ).run({
          input: {
            api_keys: [
              {
                title: "Inv Test Brand A Key",
                type: "publishable",
                created_by: "",
              },
              {
                title: "Inv Test Brand B Key",
                type: "publishable",
                created_by: "",
              },
            ],
          },
        });
        const brandAApiKey = apiKeys.find(
          (k) => k.title === "Inv Test Brand A Key"
        )!;
        const brandBApiKey = apiKeys.find(
          (k) => k.title === "Inv Test Brand B Key"
        )!;
        brandAKey = brandAApiKey.token;
        brandBKey = brandBApiKey.token;
        await linkSalesChannelsToApiKeyWorkflow(container).run({
          input: { id: brandAApiKey.id, add: [brandA.id] },
        });
        await linkSalesChannelsToApiKeyWorkflow(container).run({
          input: { id: brandBApiKey.id, add: [brandB.id] },
        });

        const { result: regions } = await createRegionsWorkflow(
          container
        ).run({
          input: {
            regions: [
              {
                name: "Inv Test US Region",
                currency_code: "usd",
                countries: ["us"],
                payment_providers: ["pp_system_default"],
              },
            ],
          },
        });
        usRegionId = regions[0].id;

        const { result: stockLocations } = await createStockLocationsWorkflow(
          container
        ).run({
          input: {
            locations: [
              {
                name: "Shared Test Warehouse",
                address: { city: "Los Angeles", country_code: "US", address_1: "" },
              },
            ],
          },
        });
        const stockLocation = stockLocations[0];
        stockLocationId = stockLocation.id;

        await link.create({
          [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
          [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
        });

        const { data: existingShippingProfiles } = await query.graph({
          entity: "shipping_profile",
          fields: ["id"],
        });
        let shippingProfileId = existingShippingProfiles[0]?.id;
        if (!shippingProfileId) {
          const created = await fulfillmentModuleService.createShippingProfiles(
            { name: "Inv Test Shipping Profile", type: "default" }
          );
          shippingProfileId = created.id;
        }

        const fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
          name: "Shared Test Warehouse delivery",
          type: "shipping",
          service_zones: [
            {
              name: "United States",
              geo_zones: [{ country_code: "us", type: "country" }],
            },
          ],
        });

        await link.create({
          [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
          [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
        });

        const { result: shippingOptions } = await createShippingOptionsWorkflow(
          container
        ).run({
          input: [
            {
              name: "Test Standard Shipping",
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
        });
        shippingOptionId = shippingOptions[0].id;

        // The shared pool: one stock location linked to both brands, so
        // there is exactly one inventory_level row for the variant below
        // regardless of which storefront sells it.
        await linkSalesChannelsToStockLocationWorkflow(container).run({
          input: { id: stockLocation.id, add: [brandA.id, brandB.id] },
        });

        const { result: products } = await createProductsWorkflow(
          container
        ).run({
          input: {
            products: [
              {
                title: "Shared Stock Tee",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: shippingProfileId,
                options: [{ title: "Size", values: ["One Size"] }],
                variants: [
                  {
                    title: "One Size",
                    sku: "SHARED-STOCK-TEE",
                    options: { Size: "One Size" },
                    prices: [{ amount: 20, currency_code: "usd" }],
                  },
                ],
                sales_channels: [{ id: brandA.id }, { id: brandB.id }],
              },
              {
                title: "Out Of Stock Tee",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: shippingProfileId,
                options: [{ title: "Size", values: ["One Size"] }],
                variants: [
                  {
                    title: "One Size",
                    sku: "OUT-OF-STOCK-TEE",
                    options: { Size: "One Size" },
                    prices: [{ amount: 20, currency_code: "usd" }],
                  },
                ],
                sales_channels: [{ id: brandA.id }, { id: brandB.id }],
              },
              {
                title: "Last Unit Tee",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: shippingProfileId,
                options: [{ title: "Size", values: ["One Size"] }],
                variants: [
                  {
                    title: "One Size",
                    sku: "LAST-UNIT-TEE",
                    options: { Size: "One Size" },
                    prices: [{ amount: 20, currency_code: "usd" }],
                  },
                ],
                sales_channels: [{ id: brandA.id }, { id: brandB.id }],
              },
            ],
          },
        });
        variantId = products[0].variants[0].id;
        outOfStockVariantId = products[1].variants[0].id;
        lastUnitVariantId = products[2].variants[0].id;

        const { data: inventoryItems } = await query.graph({
          entity: "inventory_item",
          fields: ["id", "sku"],
          filters: {
            sku: ["SHARED-STOCK-TEE", "OUT-OF-STOCK-TEE", "LAST-UNIT-TEE"],
          },
        });
        inventoryItemId = inventoryItems.find(
          (i) => i.sku === "SHARED-STOCK-TEE"
        )!.id;
        outOfStockInventoryItemId = inventoryItems.find(
          (i) => i.sku === "OUT-OF-STOCK-TEE"
        )!.id;
        lastUnitInventoryItemId = inventoryItems.find(
          (i) => i.sku === "LAST-UNIT-TEE"
        )!.id;

        await createInventoryLevelsWorkflow(container).run({
          input: {
            inventory_levels: [
              {
                location_id: stockLocation.id,
                stocked_quantity: 5,
                inventory_item_id: inventoryItemId,
              },
              {
                location_id: stockLocation.id,
                stocked_quantity: 0,
                inventory_item_id: outOfStockInventoryItemId,
              },
              {
                location_id: stockLocation.id,
                stocked_quantity: 1,
                inventory_item_id: lastUnitInventoryItemId,
              },
            ],
          },
        });
      });

      // Builds a cart through to a completable state (address + shipping
      // method + payment session), stopping just short of /complete — used
      // by the concurrency test below so both racing requests are as close
      // to simultaneous as possible.
      async function buildCompletableCart(
        apiKey: string,
        variant: string,
        quantity: number
      ) {
        const authHeaders = { headers: { "x-publishable-api-key": apiKey } };
        const { data: cartData } = await api.post(
          "/store/carts",
          {
            region_id: usRegionId,
            email: "buyer@example.com",
            items: [{ variant_id: variant, quantity }],
          },
          authHeaders
        );
        const cartId = cartData.cart.id;

        await api.post(
          `/store/carts/${cartId}`,
          {
            shipping_address: {
              first_name: "Test",
              last_name: "Buyer",
              address_1: "123 Main St",
              city: "Los Angeles",
              country_code: "us",
              postal_code: "90001",
            },
          },
          authHeaders
        );

        await api.post(
          `/store/carts/${cartId}/shipping-methods`,
          { option_id: shippingOptionId },
          authHeaders
        );

        const { data: paymentCollectionData } = await api.post(
          "/store/payment-collections",
          { cart_id: cartId },
          authHeaders
        );
        const paymentCollectionId = paymentCollectionData.payment_collection.id;

        await api.post(
          `/store/payment-collections/${paymentCollectionId}/payment-sessions`,
          { provider_id: "pp_system_default" },
          authHeaders
        );

        return { cartId, authHeaders };
      }

      it("decrements the shared inventory item when an order completes via Brand A", async () => {
        const authHeaders = { headers: { "x-publishable-api-key": brandAKey } };

        const { data: cartData } = await api.post(
          "/store/carts",
          {
            region_id: usRegionId,
            email: "buyer@example.com",
            items: [{ variant_id: variantId, quantity: 2 }],
          },
          authHeaders
        );
        const cartId = cartData.cart.id;

        await api.post(
          `/store/carts/${cartId}`,
          {
            shipping_address: {
              first_name: "Test",
              last_name: "Buyer",
              address_1: "123 Main St",
              city: "Los Angeles",
              country_code: "us",
              postal_code: "90001",
            },
          },
          authHeaders
        );

        await api.post(
          `/store/carts/${cartId}/shipping-methods`,
          { option_id: shippingOptionId },
          authHeaders
        );

        const { data: paymentCollectionData } = await api.post(
          "/store/payment-collections",
          { cart_id: cartId },
          authHeaders
        );
        const paymentCollectionId = paymentCollectionData.payment_collection.id;

        await api.post(
          `/store/payment-collections/${paymentCollectionId}/payment-sessions`,
          { provider_id: "pp_system_default" },
          authHeaders
        );

        const { data: completion } = await api.post(
          `/store/carts/${cartId}/complete`,
          {},
          authHeaders
        );
        expect(completion.type).toBe("order");

        const { data: inventoryLevels } = await getContainer()
          .resolve(ContainerRegistrationKeys.QUERY)
          .graph({
            entity: "inventory_level",
            fields: ["stocked_quantity", "reserved_quantity"],
            filters: { inventory_item_id: inventoryItemId },
          });
        const level = inventoryLevels[0];
        expect(level.stocked_quantity - level.reserved_quantity).toBe(3);
      });

      // TDD case 5.
      it("rejects add-to-cart when the shared inventory item is at zero stock", async () => {
        const authHeaders = { headers: { "x-publishable-api-key": brandAKey } };

        await expect(
          api.post(
            "/store/carts",
            {
              region_id: usRegionId,
              email: "buyer@example.com",
              items: [{ variant_id: outOfStockVariantId, quantity: 1 }],
            },
            authHeaders
          )
        ).rejects.toMatchObject({
          response: { status: 400 },
        });

        const { data: inventoryLevels } = await getContainer()
          .resolve(ContainerRegistrationKeys.QUERY)
          .graph({
            entity: "inventory_level",
            fields: ["stocked_quantity", "reserved_quantity"],
            filters: { inventory_item_id: outOfStockInventoryItemId },
          });
        expect(inventoryLevels[0].stocked_quantity).toBe(0);
        expect(inventoryLevels[0].reserved_quantity).toBe(0);
      });

      // TDD case 6.
      it("reflects a restock immediately for both brands without a brand-specific step", async () => {
        const inventoryModuleService = getContainer().resolve(
          ModuleRegistrationName.INVENTORY
        );
        await inventoryModuleService.updateInventoryLevels([
          {
            inventory_item_id: outOfStockInventoryItemId,
            location_id: stockLocationId,
            stocked_quantity: 4,
          },
        ]);

        for (const key of [brandAKey, brandBKey]) {
          const { data: productData } = await api.get(
            `/store/products?handle=out-of-stock-tee&fields=id,variants.id,variants.inventory_quantity`,
            { headers: { "x-publishable-api-key": key } }
          );
          expect(
            productData.products[0].variants[0].inventory_quantity
          ).toBe(4);
        }
      });

      // TDD case 7. Fires two simultaneous /complete requests — one via
      // Brand A, one via Brand B — against a shared item with stock = 1.
      // Exactly one should win; the other must be rejected rather than
      // both succeeding and driving stock negative.
      it("allows only one of two simultaneous checkouts to claim the last shared unit", async () => {
        const cartA = await buildCompletableCart(
          brandAKey,
          lastUnitVariantId,
          1
        );
        const cartB = await buildCompletableCart(
          brandBKey,
          lastUnitVariantId,
          1
        );

        const [resultA, resultB] = await Promise.allSettled([
          api.post(`/store/carts/${cartA.cartId}/complete`, {}, cartA.authHeaders),
          api.post(`/store/carts/${cartB.cartId}/complete`, {}, cartB.authHeaders),
        ]);

        const outcomes = [resultA, resultB].map((result) => {
          if (result.status === "rejected") return "failed";
          return result.value.data.type === "order" ? "order" : "failed";
        });
        const successCount = outcomes.filter((o) => o === "order").length;
        expect(successCount).toBe(1);

        const { data: inventoryLevels } = await getContainer()
          .resolve(ContainerRegistrationKeys.QUERY)
          .graph({
            entity: "inventory_level",
            fields: ["stocked_quantity", "reserved_quantity"],
            filters: { inventory_item_id: lastUnitInventoryItemId },
          });
        const available =
          inventoryLevels[0].stocked_quantity -
          inventoryLevels[0].reserved_quantity;
        expect(available).toBeGreaterThanOrEqual(0);
        expect(available).toBe(0);
      });
    });
  },
});
