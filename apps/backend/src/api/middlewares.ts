import { defineMiddlewares } from "@medusajs/framework/http"

// The Twenty inbound webhook needs the exact raw request bytes to verify
// its HMAC signature against (docs/specs/08-integration-webhooks.md,
// "Auth") — re-serializing the parsed JSON body before checking the
// signature could produce different bytes than what was actually signed
// (key order, whitespace), causing valid requests to fail verification.
// preserveRawBody makes Medusa's body-parser middleware stash the original
// buffer on req.rawBody in addition to parsing req.body as usual.
export default defineMiddlewares({
  routes: [
    {
      matcher: "/webhooks/twenty/fulfillment",
      method: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
  ],
})
