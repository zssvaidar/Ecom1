# 19 — Milestones

Maps to the phases in `medusa-twenty-implementation-plan.md`. Checked items are verified
working in this repo; unchecked items are scoped but not yet built.

## Phase 0 — Foundations
- [x] Monorepo layout: `apps/backend` (Medusa v2), `apps/storefront-brand-a`,
      `apps/storefront-brand-b` (Next.js), npm workspaces + Turborepo
- [x] `docs/` and `infra/` committed
- [x] `.env.example` (non-secret defaults) and per-app `.env.template` files
- [x] Docker Compose skeleton: Postgres, Redis, backend, both storefronts
- [x] CI pipeline skeleton (GitHub Actions: lint all apps, backend unit tests, backend
      build) — see `18-folder-structure.md` for why this differs from `15-cicd.md`'s
      GitLab/Jenkins. Storefronts are linted but not production-built in CI yet: their
      `next build` statically renders pages that fetch from a live Medusa backend, so a
      real build needs a running, seeded backend — revisit once Phase 1 gives CI one.
- [ ] Vault wiring (no Vault instance available in this environment; secret inventory in
      `14-env-secrets.md` is the contract to wire up against a real Vault later)

## Phase 1 — Medusa core commerce
- [x] Seed script (`apps/backend/src/migration-scripts/initial-data-seed.ts`), run
      automatically and exactly once by `medusa db:migrate`: two sales channels (Brand
      A, Brand B) with a publishable key each, two regions (US/USD, JP/JPY), US+JP tax
      regions, one shared `Main Warehouse` stock location linked to both channels, and a
      cross-listed demo product priced in both currencies. **Verified against a real
      local Postgres** — ran clean end to end. There is no separate `seed` command; see
      `AGENTS.md`'s Database section for why one must not be added back.
- [x] Integration test (`apps/backend/integration-tests/http/catalog-channels.spec.ts`)
      covering TDD cases 1–3 from `docs/tdd/medusa-catalog.tdd.md`: a single-channel
      product doesn't leak into the other brand's `/store/products`; a cross-listed
      product appears under both; its price resolves to the right currency/region
      (USD for the US region, JPY for the JP region) for each brand. **4/4 passing
      against a real local Postgres.** Caught a real gap along the way: the test
      runner's ephemeral database only runs schema migrations, not
      `src/migration-scripts/` — so unlike a real dev DB, no default shipping profile
      exists yet; the test creates one directly instead of assuming it.
- [x] Integration test (`apps/backend/integration-tests/http/shared-inventory.spec.ts`)
      covering TDD case 4: a real cart → shipping address → shipping method → payment
      collection/session (`pp_system_default`) → complete flow, placed via Brand A's
      publishable key, against a variant backed by one inventory item stocked at 5 and
      linked to both brands' sales channels through one shared stock location. Asserts
      the inventory item's available quantity (`stocked_quantity - reserved_quantity`)
      drops to 3 afterward. **Passing against a real local Postgres**, first try. The
      item isn't scoped to a sales channel at all, so this is the same number either
      brand would read — proven directly at the inventory_level row rather than via two
      separate HTTP calls.
      **Also now covered in the same file:**
      - Case 5: adding an out-of-stock variant to a cart is rejected with a 400
        ("Not enough stock available"), and the inventory level stays at 0/0 rather
        than going negative.
      - Case 6: an Admin-side restock (`inventoryModuleService.updateInventoryLevels`)
        is immediately visible to both brands' `/store/products` responses with no
        brand-specific step — confirms the shared item isn't cached or scoped per
        channel. (Fetching `variants.inventory_quantity` needs the field spelled out
        explicitly, e.g. `fields=variants.id,variants.inventory_quantity` — the `*`
        wildcard prefix used for relations doesn't pull in this computed field.)
      - Case 7: fired two simultaneous `/store/carts/:id/complete` requests via
        `Promise.allSettled` — one via Brand A, one via Brand B — against a shared
        item with stock = 1. **Medusa's built-in reservation locking already prevents
        the oversell**: exactly one request resolves with `type: "order"`, the other
        fails with "Not enough stock available", and the final available quantity
        (`stocked_quantity - reserved_quantity`) is 0, never negative. No custom
        locking code was needed — this was purely a verification task once the test
        harness could fire concurrent requests.
      - Case 9: added `src/subscribers/low-stock-alert.ts` — an opt-in low-stock
        alert keyed off `inventory_item.metadata.low_stock_threshold` (there's no
        such concept in Medusa v2's inventory module itself). **Real architecture
        finding along the way:** a sale only *reserves* stock at checkout
        (`reserveInventoryStep` → `createReservationItems_()`), and that call
        updates the `inventory_level` row's `reserved_quantity` through the
        repository directly rather than the module's own decorated
        `updateInventoryLevels()` method — so no inventory-level-updated event
        (module or workflow) fires at order-placement time at all. The correct hook
        for "a sale dropped available stock" turned out to be
        `ReservationItemWorkflowEvents.CREATED` (`reservation-item.created`),
        explicitly emitted by core-flows' `completeCartWorkflow` for exactly this
        reason. Restocks are a separate path — the Admin location-level update
        route runs `updateInventoryLevelsWorkflow`, which *does* emit
        `InventoryLevelWorkflowEvents.UPDATED` — so the subscriber listens for both
        events, using the first to detect a downward crossing and the second to
        clear the alerted flag once stock recovers. Verified two ways: the
        integration test drives two real checkouts (one per brand) against a
        shared item and asserts the alert fires exactly once despite two sales,
        then a real restock through `updateInventoryLevelsWorkflow` clears the
        flag; separately, a real `medusa develop` server plus a real curl-driven
        checkout against a freshly seeded dev database produced the exact same
        log line, confirming the subscriber registers and fires outside the test
        harness too.
      Not covered yet: TDD case 8 (a cart's reservation expiring frees the unit for a
      competing cart — needs a short reservation TTL configured for test speed, not
      just concurrent requests; also, Medusa v2 has no TTL/expiry field on
      reservations at all — `CreateReservationItemInput`/`UpdateReservationItemInput`
      carry no expiry concept, so this case doesn't map onto this Medusa version's
      actual architecture without first building custom expiry logic, which felt
      like scope creep beyond what this TDD case was asking to verify).
- [ ] Product/variant catalog beyond the one demo product
- [ ] Admin roles scoped by sales channel — Medusa v2 doesn't have a built-in per-channel
      admin role; revisit whether this needs a custom module or is just an Admin UI
      convention (filtering, not enforcement)

## Phase 2 — Payments & checkout
- [x] Stripe module registration (`apps/backend/medusa-config.ts`): conditional on
      `STRIPE_SECRET_KEY` being set, so `medusa develop`/`build`/tests keep working
      without one — verified the app still boots and the full test suite still passes
      with the key absent. The resulting provider id is `pp_stripe_stripe`.
- [ ] Currency-correct payment session tests (TDD cases 1-2) — **attempted, not
      landed.** Both `jest.mock("stripe")` and a `nock`-based network intercept were
      tried; neither worked in this environment (see `medusa-checkout-payments.tdd.md`'s
      new "Mocking Stripe" section for the specifics — the nock version actively hung
      to timeout, so it was removed rather than left half-working). Needs either a
      different mocking strategy or real Stripe test-mode credentials to verify for
      real; not something to keep guessing at blind.
- [ ] Payment success/failure/refund flows (TDD cases 3-8) — not started, same
      real-credentials blocker as above.
- [x] Discounts (`apps/backend/integration-tests/http/discounts.spec.ts`, new
      `docs/tdd/medusa-discounts-giftcards.tdd.md`): a channel-scoped percentage
      discount applies only on its own brand's cart; a global percentage discount
      applies on both brands, each in its own currency; a fixed-amount discount is
      locked to the currency it was created in (applies on a matching-currency cart,
      silently doesn't apply on a mismatched one). **5/5 passing against a real local
      Postgres.**
- [ ] Gift cards — **found a real gap, not just "not started yet":** Medusa v2 (2.21.0)
      has no gift-card module at all (no package, no module registration, no API
      routes) — only a vestigial `is_giftcard` boolean on the product model with
      nothing behind it. `docs/specs/05-discounts-giftcards.md` describes Medusa v1
      gift-card behavior (balance, partial redemption, currency lock) that doesn't
      exist here. This needs a scope decision — drop gift cards, or design a custom
      module — before any gift-card code gets written; see that spec's Open Questions.

## Phase 3 — Customer & post-purchase
- [x] Shared customer accounts (`apps/backend/integration-tests/http/
      customer-identity.spec.ts`, covers TDD cases 1-4 from `medusa-customer-
      returns.tdd.md`): registering on Brand A and logging in on Brand B resolves to
      the same customer record (no duplicate); the JWT works identically presented
      against either brand's publishable key (identity isn't channel-scoped); order
      history spans both brands, each order tagged with its own `sales_channel_id`.
      Case 5 (expired-JWT/refresh) not covered — token-expiry mechanics, not the
      cross-brand identity guarantee this project cares about.
- [x] Returns/refunds — partial restock only
      (`apps/backend/integration-tests/http/returns.spec.ts`, TDD case 6): an order
      for 3 units, 1 returned and received, restocks the shared pool by exactly 1, not
      all 3 — proving a partial return doesn't over-restock. Getting there surfaced a
      real Medusa constraint: a return can only cover *fulfilled* quantity ("Cannot
      request to return more items than what was fulfilled"), so the test creates an
      order fulfillment before requesting the return, mirroring the real flow where
      you can't return something that hasn't shipped. Admin actions in the test use a
      real admin user, created by registering an auth identity over HTTP
      (`/auth/user/emailpass/register`) and attaching a `User` to it via
      `createUserAccountWorkflow` directly — Medusa has no open self-registration for
      admin users, only an invite-accept flow, and this is the same underlying
      mechanism without needing to also drive the invite/accept HTTP round trip.
      **Not covered:** case 7 (return-window rejection — unclear if Medusa v2 enforces
      this out of the box; not yet checked), case 8 (full-order return + refund —
      needs the same Stripe credentials/mocking already blocked in Phase 2), case 9
      (Twenty sync event emission — Twenty isn't in the stack yet, Phase 4/5).
- [x] Tax configuration (JP consumption tax, US sales tax)
      (`apps/backend/integration-tests/http/tax.spec.ts`): a JP tax region carries a
      10% "Consumption Tax" rate; a JP cart correctly backs 10% out of a
      tax-inclusive price (¥3300 item total → ¥300 tax, ¥3300 total unchanged), while
      a US cart shows zero tax since no rate is configured for it yet. Getting the JP
      case right surfaced a real Medusa quirk: tax-inclusivity for a price is resolved
      from the price preference matching how the price itself was *set* — our variant
      prices carry a plain `currency_code`, not a region-specific price rule, so only
      a **currency-level** `PricePreference` (`{attribute: "currency_code", value:
      "jpy"}`) takes effect; a region-level one (`{attribute: "region_id", ...}`)
      silently has no effect on cart tax computation for these prices. See
      `isTaxInclusive()` in `@medusajs/pricing/dist/services/pricing-module.js`.
      `initial-data-seed.ts` updates the "jpy" preference `createStoresWorkflow`
      already created (updating rather than creating avoids an "already exists"
      conflict); the test creates one from scratch since it never runs
      `createStoresWorkflow`. Verified against a fresh `db:migrate`'d dev database via
      a real cart request, not just the integration test: item_total 3000, tax_total
      ≈272.73, total 3000 on the seeded demo product.
      **US sales tax is intentionally deferred** — it varies by state, so a single
      flat country-level rate would misrepresent it; `docs/specs/01-medusa-config.md`
      marks the exact provider/rate-table approach as still TBD, so the US tax region
      exists (for `tp_system` to resolve against) but carries no rate.

## Phase 4 — Twenty CRM data model
- [ ] Twenty added to the stack (self-hosted service or Cloud reference)
- [ ] Person/Company objects, Shipment/Fulfillment custom object

## Phase 5 — Medusa ↔ Twenty integration
- [ ] Outbound `order.placed` webhook + customer upsert
- [ ] Inbound fulfillment/tracking webhook
- [ ] Redis-backed retry queue, idempotency keys

## Phase 6 — Frontend
- [x] Two Next.js apps scaffolded, each on its own port, own `.env.template`
- [x] Storefronts wired to real sales-channel publishable keys and driven end to end in a
      real browser (Playwright against the pre-installed Chromium, `chromium-cli` wasn't
      available in this environment): ran the backend + both storefronts against a fresh
      seeded Postgres, confirmed both render the seeded catalog, resolve the
      cross-listed demo product to the correct currency for each brand ($20.00 on Brand
      A, ¥3,000 on Brand B), and complete a full browse → select variant → add-to-cart
      flow with no console errors. `.env.local` files hold the real (dev-only)
      publishable keys and are gitignored, not committed — see the README for the exact
      steps to reproduce.
- [ ] Shared account/session across both apps — not verified in the browser yet; the
      backend side of this is already covered by
      `apps/backend/integration-tests/http/customer-identity.spec.ts` (Phase 3)

## Phase 7 — Hardening & launch
- [ ] Logging/monitoring
- [ ] CI/CD to staging/prod
- [ ] Secrets rotation via Vault
