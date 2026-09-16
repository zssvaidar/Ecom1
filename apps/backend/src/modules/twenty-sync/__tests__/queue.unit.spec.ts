import { computeBackoffDelayMs, MAX_RETRY_WINDOW_MS } from "../queue"

// TDD case 3 from docs/tdd/integration-webhooks.tdd.md: "the event is
// retried per the documented backoff schedule (1m, 5m, 30m, 2h, hourly to
// 24h)". This is a pure function so the schedule itself is unit-tested
// directly rather than by actually waiting out real delays.
describe("Twenty sync retry backoff schedule", () => {
  it("follows the documented 1m, 5m, 30m, 2h schedule for the first four retries", () => {
    expect(computeBackoffDelayMs(1)).toBe(60_000)
    expect(computeBackoffDelayMs(2)).toBe(5 * 60_000)
    expect(computeBackoffDelayMs(3)).toBe(30 * 60_000)
    expect(computeBackoffDelayMs(4)).toBe(2 * 3600_000)
  })

  it("falls back to hourly after the fourth retry", () => {
    expect(computeBackoffDelayMs(5)).toBe(3600_000)
    expect(computeBackoffDelayMs(20)).toBe(3600_000)
  })

  it("the documented dead-letter window is 24 hours", () => {
    expect(MAX_RETRY_WINDOW_MS).toBe(24 * 3600_000)
  })
})
