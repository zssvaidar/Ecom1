import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

// @medusajs/payment-stripe throws at container-boot time ("Required option
// `apiKey` is missing in Stripe plugin") if registered with no apiKey — so it
// is only registered when a real key is present. Without this guard,
// `medusa develop`/`build`/tests would break in any environment without
// Stripe configured (this repo's CI and local dev both fall in that bucket
// per docs/specs/14-env-secrets.md). Falls back to `pp_system_default`,
// which needs no explicit registration and is what every test/seed in this
// repo uses today. Once registered, the resulting provider id is
// `pp_stripe_stripe` (Medusa builds it as `pp_<identifier>_<id>` — see
// @medusajs/payment/dist/loaders/providers.js), not `pp_stripe`.
const paymentProviders = process.env.STRIPE_SECRET_KEY
  ? [
      {
        resolve: '@medusajs/payment-stripe',
        id: 'stripe',
        options: {
          apiKey: process.env.STRIPE_SECRET_KEY,
          webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
        },
      },
    ]
  : []

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    }
  },
  modules: [
    // Durable audit/idempotency log for the Twenty CRM sync (docs/specs/
    // 08-integration-webhooks.md) — always registered, unlike the
    // conditional Stripe registration below, since it has no required
    // options and needs no external service to boot.
    { resolve: './src/modules/twenty-sync' },
    ...(paymentProviders.length > 0
      ? [
          {
            resolve: '@medusajs/medusa/payment',
            options: { providers: paymentProviders },
          },
        ]
      : []),
  ],
})
