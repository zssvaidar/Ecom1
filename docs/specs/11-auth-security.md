# 11 — Authentication & Security Spec

## Purpose
Define how each actor (customer, staff, service-to-service) authenticates, and the
security controls around secrets and inter-service calls.

## Customer authentication

- Email/password via Medusa's standard `/store/auth` endpoint, issuing a JWT
- **JWT-based**, not cookie-based (decision from `03-customer-model.md`) — since Brand A
  and Brand B are on separate domains, a JWT stored client-side (e.g., in memory + secure
  refresh flow) works across both origins where a domain-scoped cookie would not
- Token expiry: short-lived access token + refresh token pattern (standard Medusa
  behavior), refresh handled silently by each storefront

## Staff authentication (Medusa Admin)

- Standard Medusa Admin session auth
- Role scoping per `01-medusa-config.md`: `admin`, `brand-a-staff`, `brand-b-staff`
- Staff working the Twenty side authenticate via Twenty's own auth — out of scope for this
  spec, governed by Twenty's workspace access controls

## Service-to-service auth

| Call | Mechanism |
|---|---|
| Medusa → Twenty webhook | HMAC signature, secret stored in Vault, verified by Twenty receiver |
| Twenty → Medusa webhook | HMAC signature, separate secret stored in Vault, verified by Medusa endpoint |
| Medusa → Stripe | Stripe secret API key (Vault), standard Stripe SDK auth |
| Stripe → Medusa webhook | Stripe's own webhook signing secret, verified via Stripe SDK helper |

No service-to-service call is ever made with a long-lived bearer token where HMAC signing
is available — signing lets the receiver verify payload integrity, not just sender
identity.

## Secrets management

- All keys/tokens (Stripe, Twenty webhook secrets, Medusa webhook secret, publishable
  keys) live in Vault, injected as environment variables at container start — never
  committed to the repo, never logged
- Local dev uses a Vault dev-mode instance (or `.env.example` with placeholder values) so
  the workflow is reproducible without exposing real secrets

## PCI scope

- Card data never touches Medusa or either storefront directly — Stripe Elements handles
  the entire card-entry flow client-side, keeping PCI scope minimal (SAQ A)

## Rate limiting & abuse

- Standard rate limiting on `/store/auth` to mitigate credential-stuffing (exact limits
  TBD at implementation, portfolio-scope default: reasonable per-IP limit, not a hardened
  WAF setup)
- Webhook endpoints reject any request that fails signature verification before doing any
  further processing — no partial trust

## Open questions
None — this spec formalizes decisions already made in `03-customer-model.md` and
`08-integration-webhooks.md`.

## Done means
- [ ] Customer JWT issued on Brand A is accepted (via the shared customer identity) when
      the same customer authenticates on Brand B
- [ ] Staff role restrictions verified: `brand-a-staff` cannot view/modify Brand B orders
- [ ] All webhook endpoints reject unsigned or tampered payloads
- [ ] No secret appears in git history, logs, or client-side bundles
