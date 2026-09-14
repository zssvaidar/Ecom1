import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import {
  createApiKeysWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
} from "@medusajs/medusa/core-flows";
import {
  ContainerRegistrationKeys,
  ModuleRegistrationName,
  ProductStatus,
} from "@medusajs/framework/utils";

// Covers TDD cases 1-3 from docs/tdd/medusa-catalog.tdd.md: a product
// assigned to a single sales channel must not leak into the other brand's
// catalog, a cross-listed product must appear under both, and its price
// must resolve to the right currency/region for each.
jest.setTimeout(60 * 1000);

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Catalog channel scoping", () => {
      let brandAKey: string;
      let brandBKey: string;
      let usRegionId: string;
      let jpRegionId: string;
      let brandOnlyProductId: string;
      let crossListedProductId: string;

      beforeAll(async () => {
        const container = getContainer();
        const query = container.resolve(ContainerRegistrationKeys.QUERY);

        const { result: channels } = await createSalesChannelsWorkflow(
          container
        ).run({
          input: {
            salesChannelsData: [
              { name: "Test Brand A" },
              { name: "Test Brand B" },
            ],
          },
        });
        const brandA = channels.find((c) => c.name === "Test Brand A")!;
        const brandB = channels.find((c) => c.name === "Test Brand B")!;

        const { result: apiKeys } = await createApiKeysWorkflow(
          container
        ).run({
          input: {
            api_keys: [
              {
                title: "Test Brand A Key",
                type: "publishable",
                created_by: "",
              },
              {
                title: "Test Brand B Key",
                type: "publishable",
                created_by: "",
              },
            ],
          },
        });
        const brandAApiKey = apiKeys.find(
          (k) => k.title === "Test Brand A Key"
        )!;
        const brandBApiKey = apiKeys.find(
          (k) => k.title === "Test Brand B Key"
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
                name: "Test US Region",
                currency_code: "usd",
                countries: ["us"],
                payment_providers: ["pp_system_default"],
              },
              {
                name: "Test JP Region",
                currency_code: "jpy",
                countries: ["jp"],
                payment_providers: ["pp_system_default"],
              },
            ],
          },
        });
        usRegionId = regions.find((r) => r.currency_code === "usd")!.id;
        jpRegionId = regions.find((r) => r.currency_code === "jpy")!.id;

        // The integration test runner spins up a fresh database via schema
        // migrations only — it does NOT run src/migration-scripts (that's a
        // separate `medusa db:migrate` step), so unlike a real dev DB there is
        // no default shipping profile here yet. Create one directly instead
        // of assuming it exists (a real bug this test caught: the seed
        // script's original comment — "created by a migration script in
        // core" — is only true against a `db:migrate`'d database).
        const { data: existingShippingProfiles } = await query.graph({
          entity: "shipping_profile",
          fields: ["id"],
        });
        let shippingProfileId = existingShippingProfiles[0]?.id;
        if (!shippingProfileId) {
          const fulfillmentModuleService = container.resolve(
            ModuleRegistrationName.FULFILLMENT
          );
          const created = await fulfillmentModuleService.createShippingProfiles(
            { name: "Test Shipping Profile", type: "default" }
          );
          shippingProfileId = created.id;
        }

        const { result: brandOnlyProducts } = await createProductsWorkflow(
          container
        ).run({
          input: {
            products: [
              {
                title: "Brand A Only Tee",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: shippingProfileId,
                options: [{ title: "Size", values: ["One Size"] }],
                variants: [
                  {
                    title: "One Size",
                    sku: "BRAND-A-ONLY",
                    options: { Size: "One Size" },
                    prices: [{ amount: 10, currency_code: "usd" }],
                  },
                ],
                sales_channels: [{ id: brandA.id }],
              },
            ],
          },
        });
        brandOnlyProductId = brandOnlyProducts[0].id;

        const { result: crossListedProducts } = await createProductsWorkflow(
          container
        ).run({
          input: {
            products: [
              {
                title: "Cross-Listed Tee",
                status: ProductStatus.PUBLISHED,
                shipping_profile_id: shippingProfileId,
                options: [{ title: "Size", values: ["One Size"] }],
                variants: [
                  {
                    title: "One Size",
                    sku: "CROSS-LISTED",
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
        });
        crossListedProductId = crossListedProducts[0].id;
      });

      it("does not return a brand-A-only product under brand B's key", async () => {
        const response = await api.get("/store/products", {
          headers: { "x-publishable-api-key": brandBKey },
        });
        const ids = response.data.products.map((p: { id: string }) => p.id);
        expect(ids).not.toContain(brandOnlyProductId);
      });

      it("returns a brand-A-only product under brand A's key", async () => {
        const response = await api.get("/store/products", {
          headers: { "x-publishable-api-key": brandAKey },
        });
        const ids = response.data.products.map((p: { id: string }) => p.id);
        expect(ids).toContain(brandOnlyProductId);
      });

      it("returns a cross-listed product under both brands' keys", async () => {
        const [resA, resB] = await Promise.all([
          api.get("/store/products", {
            headers: { "x-publishable-api-key": brandAKey },
          }),
          api.get("/store/products", {
            headers: { "x-publishable-api-key": brandBKey },
          }),
        ]);
        expect(
          resA.data.products.map((p: { id: string }) => p.id)
        ).toContain(crossListedProductId);
        expect(
          resB.data.products.map((p: { id: string }) => p.id)
        ).toContain(crossListedProductId);
      });

      it("resolves the cross-listed variant's price to each brand's own currency/region", async () => {
        const [resUs, resJp] = await Promise.all([
          api.get(
            `/store/products/${crossListedProductId}?region_id=${usRegionId}`,
            { headers: { "x-publishable-api-key": brandAKey } }
          ),
          api.get(
            `/store/products/${crossListedProductId}?region_id=${jpRegionId}`,
            { headers: { "x-publishable-api-key": brandBKey } }
          ),
        ]);

        const usPrice = resUs.data.product.variants[0].calculated_price;
        const jpPrice = resJp.data.product.variants[0].calculated_price;

        expect(usPrice.currency_code).toBe("usd");
        expect(usPrice.calculated_amount).toBe(20);
        expect(jpPrice.currency_code).toBe("jpy");
        expect(jpPrice.calculated_amount).toBe(3000);
      });
    });
  },
});
