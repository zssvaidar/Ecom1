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

// Covers TDD case 4 from docs/tdd/medusa-catalog.tdd.md: a cross-listed
// variant backed by one shared inventory item must decrement when an order
// completes via one brand — the item is not scoped to a sales channel, so
// both brands read the same stocked/reserved numbers by construction.
jest.setTimeout(60 * 1000);

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Shared inventory pool across brands", () => {
      let brandAKey: string;
      let usRegionId: string;
      let variantId: string;
      let inventoryItemId: string;
      let shippingOptionId: string;

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
            ],
          },
        });
        const brandAApiKey = apiKeys[0];
        brandAKey = brandAApiKey.token;
        await linkSalesChannelsToApiKeyWorkflow(container).run({
          input: { id: brandAApiKey.id, add: [brandA.id] },
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
            ],
          },
        });
        variantId = products[0].variants[0].id;

        const { data: inventoryItems } = await query.graph({
          entity: "inventory_item",
          fields: ["id"],
          filters: { sku: "SHARED-STOCK-TEE" },
        });
        inventoryItemId = inventoryItems[0].id;

        await createInventoryLevelsWorkflow(container).run({
          input: {
            inventory_levels: [
              {
                location_id: stockLocation.id,
                stocked_quantity: 5,
                inventory_item_id: inventoryItemId,
              },
            ],
          },
        });
      });

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
    });
  },
});
