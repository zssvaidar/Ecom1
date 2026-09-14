# 13 — Infrastructure / Docker Compose Spec

## Purpose
Define the local dev stack and how it diverges from staging/prod, now that Postgres is
AWS-hosted rather than containerized outside of local dev.

## Environment matrix

| Service | Local dev | Staging/Prod |
|---|---|---|
| Postgres | Docker Compose container | **AWS RDS** (per `12-database-design.md`) |
| Redis | Docker Compose container | Managed Redis (e.g., AWS ElastiCache) or containerized, TBD at infra setup |
| Medusa backend | Docker Compose container | Containerized deploy — **both EC2 and ECS supported side by side**, provisioned via `infra/infra.sh` (see below); per-environment choice made by the CI/CD deploy step (`15-cicd.md`), not baked into the image |
| Twenty CRM | Docker Compose container (or Twenty Cloud, if used instead of self-hosting) | Same choice, carried through |
| Next.js App A / App B | Docker Compose container or `next dev` | Static/SSR deploy (e.g., Vercel or containerized) |
| Vault | Docker Compose dev-mode container | Existing Vault instance from prior project |

## docker-compose.yml structure (local dev)

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: medusa
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]

  redis:
    image: redis:7
    ports: ["6379:6379"]

  medusa:
    build: ./medusa
    depends_on: [postgres, redis]
    environment:
      DATABASE_URL: postgres://postgres:5432/medusa   # points at local container in dev,
                                                        # AWS RDS endpoint in staging/prod
      REDIS_URL: redis://redis:6379
    ports: ["9000:9000"]

  twenty:
    build: ./twenty            # or omitted entirely if using Twenty Cloud
    depends_on: [postgres]
    ports: ["3001:3000"]

  app-a:
    build: ./frontend-a
    environment:
      MEDUSA_PUBLISHABLE_KEY: ${BRAND_A_KEY}
    ports: ["3000:3000"]

  app-b:
    build: ./frontend-b
    environment:
      MEDUSA_PUBLISHABLE_KEY: ${BRAND_B_KEY}
    ports: ["3002:3000"]

volumes:
  pgdata:
```

The only thing that changes between local and AWS-hosted Postgres is the `DATABASE_URL`
value — the `postgres` service block above exists **only** in the local compose file; it
is absent from whatever deploy manifest targets staging/prod, where Medusa connects
directly to the RDS endpoint instead.

## Networking

- All services on a single Compose network locally; no need to expose Postgres/Redis
  ports beyond what's needed for local debugging
- In staging/prod, Medusa's outbound connection to RDS must be allowed through the VPC
  security group — RDS should not be publicly reachable

## AWS provisioning: `infra/infra.sh`

The AWS side of staging/prod (VPC, subnets, security groups, RDS, and both compute
targets) is provisioned by a single bash + awscli script, **`infra/infra.sh`**, rather
than a separate IaC tool — kept intentionally simple and inspectable for this project's
scope. Full usage in `infra/README.md`; summary here.

**What it provisions, in order:**

1. **VPC** — one VPC, two public subnets (EC2/future ALB) and two private subnets
   (RDS), an internet gateway, and two security groups (`web` open on 80/443/22,
   `rds` open on 5432 only from `web`)
2. **RDS** — the Postgres instance referenced in `12-database-design.md`, always in
   the private subnets, never publicly accessible
3. **EC2** — a single Docker host (Ubuntu, Docker installed via user-data) as one
   compute option
4. **ECS** — a Fargate cluster + task execution IAM role as the other compute option

EC2 and ECS are provisioned **side by side** on the same VPC/RDS foundation — nothing
about the network layer assumes one or the other. Which one actually runs the app in a
given environment is decided by the CI/CD deploy step (`deploy-ec2.sh` vs.
`deploy-ecs.sh`, per `15-cicd.md`), not by this provisioning script. This lets you run
on EC2 today and move an environment to ECS later (or vice versa) without touching the
network/database layer at all.

**State tracking:** every resource ID created is written to `infra/infra-state.json`,
so `./infra.sh destroy <target>` always tears down exactly what was created — nothing
is inferred by name-guessing. This file must persist between create/destroy runs
(store it somewhere durable, not just on a developer laptop, once this leaves the
portfolio-project stage).

**Commands:**
```bash
./infra.sh create all      # or: vpc | rds | ec2 | ecs individually
./infra.sh destroy all     # reverse order
./infra.sh status          # print current state
```

**Explicitly out of scope for this script** — provisioning the platform only, not
deploying app versions onto it, and not yet creating a load balancer (see open
questions below).

## Open questions
- Confirm whether Twenty is self-hosted (containerized here) or Twenty Cloud is used
  instead — changes whether a `twenty` service block is needed at all
- No ALB is provisioned yet — needed before EC2 or ECS actually serves production
  traffic; add `create_alb`/`destroy_alb` to `infra.sh` following the same state-file
  pattern when ready

## Done means
- [ ] `docker-compose up` brings up the full local stack (Postgres, Redis, Medusa, Twenty,
      both frontends) with no manual steps beyond `.env` setup
- [ ] Switching `DATABASE_URL` to a real RDS endpoint (e.g., a dev RDS instance) works
      with no code changes, only config
- [ ] RDS is not publicly accessible; only Medusa's compute can reach it
- [ ] `./infra.sh create all` successfully provisions VPC + RDS + EC2 + ECS from a
      clean AWS account, and `./infra.sh destroy all` fully tears it back down with
      nothing orphaned
- [ ] `infra-state.json` accurately reflects every live resource at all times
