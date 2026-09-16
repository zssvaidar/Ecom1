import { signPayload, verifySignature } from "../signature"

// TDD cases 10-13 from docs/tdd/integration-webhooks.tdd.md.
describe("Twenty webhook signature verification", () => {
  const secret = "test-secret"
  const body = JSON.stringify({ event: "order.placed", order: { id: "order_1" } })

  it("accepts a correctly signed request", () => {
    const signature = signPayload(body, secret)
    expect(verifySignature(body, signature, secret)).toBe(true)
  })

  it("rejects a missing signature", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false)
    expect(verifySignature(body, null, secret)).toBe(false)
    expect(verifySignature(body, "", secret)).toBe(false)
  })

  it("rejects a validly-formatted signature computed with the wrong secret", () => {
    const signature = signPayload(body, "wrong-secret")
    expect(verifySignature(body, signature, secret)).toBe(false)
  })

  it("rejects a tampered body even though a signature is present", () => {
    const signature = signPayload(body, secret)
    const tamperedBody = JSON.stringify({
      event: "order.placed",
      order: { id: "order_2" },
    })
    expect(verifySignature(tamperedBody, signature, secret)).toBe(false)
  })

  it("rejects a garbage/non-hex signature without throwing", () => {
    expect(verifySignature(body, "not-a-hex-signature", secret)).toBe(false)
  })
})
