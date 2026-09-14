# 12 — Database Design Spec

## Purpose
Define where data lives, what's custom vs. standard Medusa schema, and how the
AWS-hosted Postgres instance fits into local dev vs. deployed environments.

## Hosting

- **Postgres is hosted on AWS (RDS)** — not run as a local/self-managed container in
  staging or production. This is the single source of truth for all Medusa data
  (products, orders, customers, inventory) across both sales channels.
- **Local development** still runs a Postgres container via Docker Compose (see
  `13-infra-docker-compose.md`) for fast iteration without touching AWS — schema is
  identical, just a different connection target.
- Connection string (host, credentials) is environment-specific and pulled from Vault,
  never hardcoded — `DATABASE_URL` differs between local, staging, and prod.
- Twenty CRM's own datastore is separate and out of scope here — it manages its own
  storage independently; this spec only covers the Medusa-owned database.

## Schema ownership

- **No custom tables added to Medusa's schema for this project.** Everything needed —
  two sales channels, shared inventory, regions/currencies, customers, discounts, gift
  cards, returns — is expressible with Medusa v2's standard data model plus configuration,
  per `01-medusa-config.md` through `06-returns.md`.
- If a genuine custom field becomes necessary later (e.g., a brand-specific metadata
  field), it should go through Medusa's supported `metadata` JSON column on the relevant
  entity rather than a schema migration, to avoid diverging from upstream Medusa's schema.

## Key relationships relied on (standard Medusa schema)

| Entity | Relevant relationship for this project |
|---|---|
| `sales_channel` | Two rows: `brand-a`, `brand-b` |
| `region` | Two rows, each tied to one sales channel, one currency |
| `product` / `product_variant` | Variants priced per region; products assigned to one or both channels |
| `inventory_item` / `inventory_level` | Single shared location; referenced by variants across both channels |
| `customer` | Not scoped to a channel — one row per person regardless of brand |
| `order` | Tagged with `sales_channel_id`; queried by `customer_id` for cross-brand history |

## Backups & migrations

- RDS automated backups (point-in-time recovery) — standard AWS setup, retention period
  TBD at infra setup (recommend 7 days minimum for a portfolio project)
- Schema migrations run via Medusa's standard migration tooling; applied to RDS through
  the CI/CD pipeline (`15-cicd.md`), never run manually against production
- Local Postgres container schema is kept in sync by running the same migrations locally

## Open questions
- Confirm RDS instance sizing/tier (not a schema concern, but affects `13-infra-docker-compose.md`
  and cost — flag your preferred tier, e.g., `db.t4g.micro` for a portfolio-scope workload)

## Done means
- [ ] Local Docker Compose Postgres and AWS RDS run identical schema via the same
      migration set
- [ ] `DATABASE_URL` is environment-specific and sourced from Vault, never hardcoded
- [ ] A cross-listed product's shared inventory row is correctly referenced from both
      sales channels' variants (verifies the relationship table above, not just the app logic)
- [ ] RDS automated backups enabled and retention period confirmed
