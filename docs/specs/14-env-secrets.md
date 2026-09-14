# 14 — Environment Variables & Secrets Spec

## Purpose
Define every secret/config value the system needs, where it's stored, and how it's
injected per environment — using the existing self-hosted HashiCorp Vault.

## Secret storage: self-hosted Vault

- All secrets live in Vault, organized under environment-scoped paths, e.g.:
  ```
  secret/medusa-twenty/local/...
  secret/medusa-twenty/staging/...
  secret/medusa-twenty/prod/...
  ```
- Jenkins pulls secrets from Vault at build/deploy time (via Vault's Jenkins plugin or a
  scripted `vault kv get` step) and injects them as environment variables into the
  container runtime — secrets are never written to disk in the repo or in Jenkins job
  logs.
- Local dev either points at the same Vault instance (read-only dev token) or uses a
  `.env.local` populated by pulling from Vault once, per developer preference — either
  way, `.env.local` stays gitignored and is never the source of truth.

## Secret inventory

| Key | Used by | Vault path (example) |
|---|---|---|
| `DATABASE_URL` | Medusa | `secret/medusa-twenty/<env>/database-url` |
| `REDIS_URL` | Medusa | `secret/medusa-twenty/<env>/redis-url` |
| `STRIPE_SECRET_KEY` | Medusa | `secret/medusa-twenty/<env>/stripe-secret` |
| `STRIPE_WEBHOOK_SECRET` | Medusa | `secret/medusa-twenty/<env>/stripe-webhook-secret` |
| `BRAND_A_PUBLISHABLE_KEY` | App A frontend | `secret/medusa-twenty/<env>/brand-a-pub-key` |
| `BRAND_B_PUBLISHABLE_KEY` | App B frontend | `secret/medusa-twenty/<env>/brand-b-pub-key` |
| `TWENTY_OUTBOUND_WEBHOOK_SECRET` | Medusa (signs Medusa → Twenty calls) | `secret/medusa-twenty/<env>/twenty-outbound-secret` |
| `TWENTY_INBOUND_WEBHOOK_SECRET` | Medusa (verifies Twenty → Medusa calls) | `secret/medusa-twenty/<env>/twenty-inbound-secret` |
| `TWENTY_API_TOKEN` | Medusa or a sync worker, if calling Twenty's API directly | `secret/medusa-twenty/<env>/twenty-api-token` |
| `JWT_SECRET` | Medusa (customer auth tokens, per `11-auth-security.md`) | `secret/medusa-twenty/<env>/jwt-secret` |

## Non-secret config

Ordinary config (not secret) can live in plain environment files or Jenkins job
parameters — e.g., `NODE_ENV`, `SALES_CHANNEL_BRAND_A_ID`, `SALES_CHANNEL_BRAND_B_ID`,
region/currency codes. No need to route non-sensitive values through Vault.

## Rotation

- Webhook secrets and API tokens should be rotatable without a code deploy — Jenkins
  pipeline re-pulls from Vault on every deploy, so a rotated secret takes effect on the
  next deploy or a manual pipeline re-run
- Stripe keys rotated per Stripe's own recommended process; update the Vault path, no
  application code change needed

## Open questions
- Confirm Vault auth method Jenkins will use to fetch secrets (AppRole is the common
  pattern for CI systems — flag if you already have a pattern from the prior project)

## Done means
- [ ] No secret value appears anywhere in the GitLab repo, Jenkins job config, or
      container image layers
- [ ] Local dev, staging, and prod each read from their own Vault path — no cross-env
      leakage
- [ ] Rotating a webhook secret in Vault and re-running the Jenkins deploy picks up the
      new value with no code change
