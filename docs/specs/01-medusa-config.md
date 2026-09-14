# 01 — Medusa Configuration Spec

## Purpose
Define how the single Medusa backend is configured to serve two brands with shared
inventory and per-brand currency, and the baseline tax setup.

## Sales channels

| Channel | Handle | Used by | Publishable API key |
|---|---|---|---|
| Brand A | `brand-a` | Next.js App A | `pk_brand_a` (stored in Vault) |
| Brand B | `brand-b` | Next.js App B | `pk_brand_b` (stored in Vault) |

Each product is assigned to one or both channels depending on whether it's brand-exclusive
or cross-listed. Shared inventory means the same inventory item can back variants listed on
both channels without duplicating stock.

## Regions & currency

| Region | Currency | Sales channel | Countries |
|---|---|---|---|
| Brand A Region | USD | `brand-a` | US (extend as needed) |
| Brand B Region | JPY | `brand-b` | JP |

Currency is fixed by which storefront/domain the customer is on — there is no in-app
currency switcher. If a brand ever needs to sell in both currencies, add a second region
under the same channel rather than introducing checkout-time currency selection.

## Inventory

- One shared inventory location (e.g., `main-warehouse`)
- All inventory items link to this single location
- Both sales channels' variants reference the same inventory items where SKUs overlap
- Reservations are created at cart level to prevent oversell across simultaneous checkouts
  on both storefronts

## Tax configuration

| Region | Tax approach |
|---|---|
| US (Brand A) | Sales tax — configure via Medusa tax provider (rate table or Stripe Tax, TBD in `06-returns-subscriptions.md` sibling doc if using tax-inclusive subscription pricing) |
| JP (Brand B) | Consumption tax (10% standard), prices tax-inclusive per common JP convention |

Tax rates are configured per region, not per channel, since region already maps 1:1 to
channel in this setup.

## Admin

- Single Medusa Admin instance
- Staff roles: `admin` (full access), `brand-a-staff`, `brand-b-staff` (scoped to their
  channel's orders/products where Medusa's permission model allows it)
- Order list default-filtered by sales channel per staff role

## Open questions
- Confirm whether Brand A ever needs a JPY-priced SKU (would require a second region under
  `brand-a`) — flag if so, currently assumed no.

## Done means
- [ ] Two regions (US/USD, JP/JPY) created, each tied to its sales channel
- [ ] Shared inventory location created; at least one SKU cross-listed on both channels to
      prove stock decrements correctly from either storefront
- [ ] Tax rates configured and verified on a test order per region
- [ ] Staff roles created with channel-scoped Admin views
