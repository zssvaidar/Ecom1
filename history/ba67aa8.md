# ba67aa8 — Fix unsafe seed re-run, add passing catalog-channel integration test, changelog

Got a real Postgres running in-session (postgresql-16 was already installed on this
machine) and used it to verify things the previous two commits could only compile, not
run.

## Bug found and fixed: duplicate data on re-seed
`apps/backend/src/migration-scripts/initial-data-seed.ts` lives under
`src/migration-scripts/`, which `medusa db:migrate` auto-discovers and runs exactly
once, tracked in a `script_migrations` table. The previous commit had added a `seed`
npm script (`medusa exec ./src/migration-scripts/initial-data-seed.ts`) meant to be a
convenient re-run — but `medusa exec` bypasses that tracking entirely. Ran it twice in a
row against a real database to check: the second run duplicated "Brand A"/"Brand B"
sales channels and API keys, then hard-failed with `Countries with codes: "jp, us" are
already assigned to a region`, leaving the DB in a partially-duplicated state.

Fix: removed the `seed` script from `apps/backend/package.json` and root
`package.json`, removed the now-unused `seed` task from `turbo.json`, and added a note
to `AGENTS.md`'s Database section explaining why a re-runnable seed command must not be
added back without making the underlying script idempotent first. Confirmed
`db:migrate` seeds cleanly on a fresh database and is correctly a no-op (skips the
already-tracked script) on a second run.

## New: passing integration test
Added `apps/backend/integration-tests/http/catalog-channels.spec.ts`, covering TDD
cases 1–2 from `docs/tdd/medusa-catalog.tdd.md`: a product assigned to one sales
channel doesn't leak into the other brand's `/store/products` response; a cross-listed
product appears under both brands' publishable keys. All 3 assertions pass against a
real Postgres.

Building it surfaced a second real gap: `medusaIntegrationTestRunner`'s ephemeral test
database only runs schema migrations, not `src/migration-scripts/` — so unlike a real
dev DB, there's no default shipping profile by the time a test's `beforeAll` runs. The
test creates one directly via the fulfillment module service instead of assuming one
exists (the assumption the seed script itself still makes, safely, only because
`db:migrate` guarantees one of Medusa's own core migration scripts creates a default
profile before `initial-data-seed.ts` runs).

Also discovered while wiring this up: `@medusajs/test-utils`'s database creation needs
discrete `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD` env vars — `DATABASE_URL` alone isn't
enough and fails with `no PostgreSQL user name specified in startup packet`.

## CI
Added a `test-backend-integration` job with a real `postgres:16` service container and
the `PG*` env vars above, so this test (and any future ones under
`integration-tests/http/`) actually run on every push/PR, not just locally.

## Changelog
Added `history/`: one `<short-hash>.md` file per commit on this branch. Backfilled
entries for `2147ea4` and `e58bd43`, the two commits before this one.

## Verified
- `npm run lint` — all three workspaces clean.
- `npx tsc --noEmit` on the backend — the new test file type-checks against Medusa's
  real workflow and test-utils types.
- `npm run test:integration:http --workspace=@dtc/backend` — 3/3 passing, against a
  real local Postgres (started via `pg_ctlcluster`, not Docker — no Docker daemon in
  this environment).
- `medusa db:migrate` run twice against the same database: seeds once, no-ops on the
  second run.
