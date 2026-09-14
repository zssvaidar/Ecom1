import { MedusaContainer } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  ModuleRegistrationName,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductCategoriesWorkflow,
  createProductOptionsWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createStockLocationsWorkflow,
  createStoresWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from "@medusajs/medusa/core-flows";

// Seeds the two-brand setup from docs/specs/01-medusa-config.md and
// docs/specs/02-catalog-inventory.md: two sales channels (brand-a, brand-b),
// two regions (US/USD, JP/JPY), one shared inventory location linked to both
// channels, and a cross-listed demo product proving the shared stock pool.
export default async function initial_data_seed({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const fulfillmentModuleService = container.resolve(
    ModuleRegistrationName.FULFILLMENT
  );

  logger.info("Seeding sales channels...");
  const { result: salesChannelsResult } = await createSalesChannelsWorkflow(
    container
  ).run({
    input: {
      salesChannelsData: [
        {
          name: "Brand A",
          description: "Brand A storefront (USD/US)",
        },
        {
          name: "Brand B",
          description: "Brand B storefront (JPY/JP)",
        },
      ],
    },
  });
  const brandAChannel = salesChannelsResult.find((c) => c.name === "Brand A")!;
  const brandBChannel = salesChannelsResult.find((c) => c.name === "Brand B")!;

  logger.info("Seeding publishable API keys...");
  const { result: apiKeysResult } = await createApiKeysWorkflow(
    container
  ).run({
    input: {
      api_keys: [
        {
          title: "Brand A Publishable Key",
          type: "publishable",
          created_by: "",
        },
        {
          title: "Brand B Publishable Key",
          type: "publishable",
          created_by: "",
        },
      ],
    },
  });
  const brandAKey = apiKeysResult.find(
    (k) => k.title === "Brand A Publishable Key"
  )!;
  const brandBKey = apiKeysResult.find(
    (k) => k.title === "Brand B Publishable Key"
  )!;

  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: brandAKey.id, add: [brandAChannel.id] },
  });
  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: brandBKey.id, add: [brandBChannel.id] },
  });
  logger.info(
    `Publishable keys — Brand A: ${brandAKey.token}, Brand B: ${brandBKey.token}`
  );

  logger.info("Seeding store...");
  await createStoresWorkflow(container).run({
    input: {
      stores: [
        {
          name: "Ecom1",
          supported_currencies: [
            { currency_code: "usd", is_default: true },
            { currency_code: "jpy", is_default: false },
          ],
          default_sales_channel_id: brandAChannel.id,
        },
      ],
    },
  });

  logger.info("Seeding region data...");
  const { result: regionsResult } = await createRegionsWorkflow(
    container
  ).run({
    input: {
      regions: [
        {
          name: "Brand A Region (US)",
          currency_code: "usd",
          countries: ["us"],
          payment_providers: ["pp_system_default"],
        },
        {
          name: "Brand B Region (JP)",
          currency_code: "jpy",
          countries: ["jp"],
          payment_providers: ["pp_system_default"],
        },
      ],
    },
  });
  const usRegion = regionsResult.find((r) => r.currency_code === "usd")!;
  const jpRegion = regionsResult.find((r) => r.currency_code === "jpy")!;
  logger.info("Finished seeding regions.");

  logger.info("Seeding tax regions...");
  await createTaxRegionsWorkflow(container).run({
    input: [
      { country_code: "us", provider_id: "tp_system" },
      { country_code: "jp", provider_id: "tp_system" },
    ],
  });
  logger.info("Finished seeding tax regions.");

  logger.info("Seeding shared inventory location...");
  const { result: stockLocationResult } = await createStockLocationsWorkflow(
    container
  ).run({
    input: {
      locations: [
        {
          name: "Main Warehouse",
          address: {
            city: "Los Angeles",
            country_code: "US",
            address_1: "",
          },
        },
      ],
    },
  });
  const stockLocation = stockLocationResult[0];

  await link.create({
    [Modules.STOCK_LOCATION]: {
      stock_location_id: stockLocation.id,
    },
    [Modules.FULFILLMENT]: {
      fulfillment_provider_id: "manual_manual",
    },
  });

  logger.info("Seeding fulfillment data...");
  // Shipping profile is created by a migration script in core.
  const { data: shippingProfileResult } = await query.graph({
    entity: "shipping_profile",
    fields: ["id"],
  });
  const shippingProfile = shippingProfileResult[0];

  const fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
    name: "Main Warehouse delivery",
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
  });

  await link.create({
    [Modules.STOCK_LOCATION]: {
      stock_location_id: stockLocation.id,
    },
    [Modules.FULFILLMENT]: {
      fulfillment_set_id: fulfillmentSet.id,
    },
  });

  const usZone = fulfillmentSet.service_zones.find(
    (z) => z.name === "United States"
  )!;
  const jpZone = fulfillmentSet.service_zones.find(
    (z) => z.name === "Japan"
  )!;

  await createShippingOptionsWorkflow(container).run({
    input: [
      {
        name: "Standard Shipping",
        price_type: "flat",
        provider_id: "manual_manual",
        service_zone_id: usZone.id,
        shipping_profile_id: shippingProfile.id,
        type: {
          label: "Standard",
          description: "Ship in 3-5 days.",
          code: "standard",
        },
        prices: [
          { currency_code: "usd", amount: 10 },
          { region_id: usRegion.id, amount: 10 },
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
        shipping_profile_id: shippingProfile.id,
        type: {
          label: "Standard",
          description: "Ship in 3-5 days.",
          code: "standard",
        },
        // JPY has no minor unit, so 1000 here already means ¥1000, not ¥10 —
        // the prices-in-major-units lint warning below is a false positive
        // for zero-decimal currencies.
        prices: [
          { currency_code: "jpy", amount: 1000 },
          { region_id: jpRegion.id, amount: 1000 },
        ],
        rules: [
          { attribute: "enabled_in_store", value: "true", operator: "eq" },
          { attribute: "is_return", value: "false", operator: "eq" },
        ],
      },
    ],
  });
  logger.info("Finished seeding fulfillment data.");

  // Both brands draw from the same location — this is the shared stock pool
  // from docs/specs/02-catalog-inventory.md, not two separate warehouses.
  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: {
      id: stockLocation.id,
      add: [brandAChannel.id, brandBChannel.id],
    },
  });
  logger.info("Finished seeding stock location data.");

  logger.info("Seeding cross-listed demo product...");
  const { result: categoryResult } = await createProductCategoriesWorkflow(
    container
  ).run({
    input: {
      product_categories: [{ name: "Apparel", is_active: true }],
    },
  });

  const { result: productOptionsResult } = await createProductOptionsWorkflow(
    container
  ).run({
    input: {
      product_options: [{ title: "Size", values: ["S", "M", "L"] }],
    },
  });
  const sizeOption = productOptionsResult[0];

  // Cross-listed on both channels with a USD and a JPY price on every
  // variant (docs/specs/02-catalog-inventory.md) — proves a sale on one
  // brand decrements stock the other brand sees, once inventory levels
  // below are seeded against this same shared location.
  await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: "Cross-Brand Demo Tee",
          category_ids: [categoryResult[0].id],
          description:
            "Demo product proving the shared inventory pool across Brand A and Brand B.",
          handle: "cross-brand-demo-tee",
          weight: 200,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          options: [{ id: sizeOption.id }],
          variants: ["S", "M", "L"].map((size) => ({
            title: size,
            sku: `DEMO-TEE-${size}`,
            options: { Size: size },
            prices: [
              { amount: 20, currency_code: "usd" },
              { amount: 3000, currency_code: "jpy" },
            ],
          })),
          sales_channels: [{ id: brandAChannel.id }, { id: brandBChannel.id }],
        },
      ],
    },
  });
  logger.info("Finished seeding product data.");

  logger.info("Seeding inventory levels.");
  const { data: inventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id"],
  });

  await createInventoryLevelsWorkflow(container).run({
    input: {
      inventory_levels: inventoryItems.map((item) => ({
        location_id: stockLocation.id,
        stocked_quantity: 100,
        inventory_item_id: item.id,
      })),
    },
  });
  logger.info("Finished seeding inventory levels data.");
}
