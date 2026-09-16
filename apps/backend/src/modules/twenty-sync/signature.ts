import { createHmac, timingSafeEqual } from "node:crypto"

// Shared by both directions of the Medusa <-> Twenty sync (docs/specs/
// 08-integration-webhooks.md, "Auth" section): a shared secret signs the
// raw request body with HMAC-SHA256; the receiver recomputes the same
// signature over the raw body it received and rejects anything that
// doesn't match byte-for-byte. Signing the body (not just checking a
// shared-secret header) is what makes this cover tampering, not just
// authentication.
export function signPayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
}

// Constant-time comparison — a naive `===` leaks timing information about
// how many leading bytes matched, which defeats the point of an HMAC check.
// Mismatched-length inputs are always invalid rather than throwing (a
// malformed/short header should not crash the request).
export function verifySignature(
  rawBody: string,
  signature: string | undefined | null,
  secret: string
): boolean {
  if (!signature) {
    return false
  }

  const expected = signPayload(rawBody, secret)
  const expectedBuffer = Buffer.from(expected, "hex")
  const actualBuffer = Buffer.from(signature, "hex")

  if (
    expectedBuffer.length !== actualBuffer.length ||
    expectedBuffer.length === 0
  ) {
    return false
  }

  return timingSafeEqual(expectedBuffer, actualBuffer)
}
