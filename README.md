# Ecom1 — Medusa + Twenty CRM, two-brand commerce platform

One Medusa v2 backend serving two independently-branded storefronts (shared inventory,
shared customer accounts, one Admin) with fulfillment run through Twenty CRM. Full
design in [`docs/specs/00-architecture.md`](docs/specs/00-architecture.md); current
build status in [`docs/specs/19-milestones.md`](docs/specs/19-milestones.md).

## Layout

```
apps/
  backend/               # Medusa v2 — catalog, cart, checkout, orders, payments, inventory
  storefront-brand-a/    # Next.js storefront, Brand A (USD/US), :8000
  storefront-brand-b/    # Next.js storefront, Brand B (JPY/JP), :8001
docs/specs/              # One doc per concern — architecture, config, data flows, ...
docs/tdd/                # Test-first specs, one per testable module
infra/infra.sh           # AWS VPC/RDS/EC2/ECS create/destroy (staging/prod only)
```

See [`AGENTS.md`](AGENTS.md) for day-to-day commands and conventions, and
[`docs/specs/18-folder-structure.md`](docs/specs/18-folder-structure.md) for how this
maps to the plan in `docs/medusa-twenty-implementation-plan.md`.

## Local development

Prerequisites: Node 20.19+/22.12+, npm, Docker (for Postgres/Redis).

```bash
npm install

# Postgres + Redis only, so the apps below can run with `npm run dev`:
cp .env.example .env
docker compose up postgres redis -d

cp apps/backend/.env.template apps/backend/.env
# then set DATABASE_URL in apps/backend/.env to
# postgres://postgres:postgres@localhost:5432/medusa

cd apps/backend
npx medusa db:migrate
npx medusa user -e admin@test.com -p supersecret
cd ../..

npm run backend:dev        # http://localhost:9000, admin at /app
```

Open the admin, create a publishable API key per sales channel (Phase 1 —
see `docs/specs/01-medusa-config.md`), then:

```bash
cp apps/storefront-brand-a/.env.template apps/storefront-brand-a/.env.local
cp apps/storefront-brand-b/.env.template apps/storefront-brand-b/.env.local
# set NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY in each to its brand's key

npm run storefront-a:dev   # http://localhost:8000
npm run storefront-b:dev   # http://localhost:8001
```

Or bring up the full stack (Postgres, Redis, backend, both storefronts) in containers:

```bash
cp .env.example .env
docker compose up --build
```

Twenty CRM isn't wired into the stack yet — that's Phase 4/5
(`docs/specs/07-twenty-data-model.md`, `docs/specs/08-integration-webhooks.md`).

## CI

`.github/workflows/ci.yml` runs lint (all apps), backend unit tests, and a backend
build on every push/PR. It stands in for the GitLab+Jenkins pipeline in
`docs/specs/15-cicd.md`, which targets self-hosted infra this repo doesn't have — see
`docs/specs/18-folder-structure.md` for that tradeoff.

## Staging/prod infra

`infra/infra.sh` provisions the AWS side (VPC, RDS, EC2, ECS) for staging/prod. See
[`infra/README.md`](infra/README.md).
