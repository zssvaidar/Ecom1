# 18 — Folder Structure Spec

## Purpose
Define the actual repo layout so the monorepo, docs, and infra scripts stay predictable
as the project grows across phases.

## Layout

```
.
├── apps/
│   ├── backend/                  # Medusa v2 backend (@dtc/backend) — single instance,
│   │                              # two sales channels (brand-a, brand-b)
│   ├── storefront-brand-a/       # Next.js storefront, Brand A (USD/US), port 8000
│   └── storefront-brand-b/       # Next.js storefront, Brand B (JPY/JP), port 8001
├── docs/
│   ├── specs/                    # One file per concern — see 00-architecture.md
│   ├── tdd/                      # Test-first specs, one per testable module
│   ├── functional-requirements-master-list.md
│   ├── medusa-twenty-implementation-plan.md
│   └── medusa-twenty-process-landscape.md
├── infra/
│   ├── infra.sh                  # AWS VPC/RDS/EC2/ECS create/destroy
│   └── README.md
├── .github/workflows/            # CI (lint/typecheck/build) — see 15-cicd.md note below
├── docker-compose.yml            # Local dev stack: postgres, redis, backend, storefronts
├── .env.example                  # Non-secret defaults; see 14-env-secrets.md
├── AGENTS.md / CLAUDE.md         # Agent-facing conventions for this repo
├── package.json / turbo.json     # npm workspaces + Turborepo task graph
```

Twenty CRM is not vendored into this repo — it's an off-the-shelf image, not our own
source, so there's no `apps/twenty` package to add. `docker-compose.yml` does now carry
a self-hosted `twenty`/`twenty-db` service pair behind an opt-in `twenty` profile
(Phase 4), as a default; a Twenty Cloud instance reached only via webhook/API remains
the alternative per `07-twenty-data-model.md`'s open questions, and either way the
Medusa-side integration code doesn't care which one is running behind
`TWENTY_WEBHOOK_URL`. The compose service itself is unverified in this repo's own
environment (no Docker daemon available here) — see `19-milestones.md` Phase 4.

## Deviation from `15-cicd.md`
`15-cicd.md` specifies self-hosted GitLab + Jenkins. This repo is hosted on GitHub, so
Phase 0's CI skeleton uses GitHub Actions instead, running the same stages (lint,
typecheck, test, build) described in that spec. The GitLab/Jenkins/Vault pipeline
remains the target for a real deployment (staging/prod approval gate, Vault secret
injection) and should be (re)implemented if/when this project moves to that
infrastructure; until then, GitHub Actions covers the "must pass before merge" gate
this repo actually has.

## Naming

- Kebab-case directories, matching `AGENTS.md`'s file convention.
- Each app's package name is scoped `@dtc/<app>` (e.g. `@dtc/backend`,
  `@dtc/storefront-brand-a`) so Turborepo filters (`--filter=@dtc/...`) stay unambiguous.

## Done means
- [x] `apps/backend`, `apps/storefront-brand-a`, `apps/storefront-brand-b` exist as
      npm workspaces under one Turborepo root
- [x] `docs/` and `infra/` are committed and traceable from this file
- [ ] A running Twenty instance (self-hosted or Cloud) reachable from this stack —
      the opt-in `docker-compose.yml` service pair added in Phase 4 is unverified
      (no Docker daemon in this repo's own environment); see `19-milestones.md`
