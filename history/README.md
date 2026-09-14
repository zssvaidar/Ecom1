# History

One file per commit on this branch, named `<n>-<short-hash>.md` — `<n>` is a sequence
number in order of creation, `<short-hash>` the 7-char hash from `git log --oneline`.
Summarizes what that commit did and why. Written retroactively where needed — a
commit's own hash isn't known until after it's made, so its entry sometimes lands in
the following commit rather than the same one.

| # | Commit | Summary |
|---|---|---|
| 1 | [`2147ea4`](./1-2147ea4.md) | Scaffold Phase 0: Medusa v2 + two-brand Next.js monorepo |
| 2 | [`e58bd43`](./2-e58bd43.md) | Phase 1: seed script for two-brand sales channels, regions, shared inventory |
| 3 | [`ba67aa8`](./3-ba67aa8.md) | Fix unsafe seed re-run, add passing catalog-channel integration test, changelog |
| 4 | [`fa044d5`](./4-fa044d5.md) | Add price-by-region test case (TDD case 3), changelog for previous commit |
| 5 | [`3735fa3`](./5-3735fa3.md) | Add changelog entry for fa044d5 |
| 6 | [`7899ffc`](./6-7899ffc.md) | Index history files by creation order (1-hash, 2-hash, ...) |
| 7 | [`42074cb`](./7-42074cb.md) | Add shared-inventory integration test (TDD case 4), passing end to end |
| 8 | [`ddf89b3`](./8-ddf89b3.md) | Add changelog entries for 7899ffc and 42074cb |
| 9 | [`21f6ccb`](./9-21f6ccb.md) | Phase 2: discount tests (channel-scoped, global, currency-locked); flag gift-card gap |
| 10 | [`6fa1a60`](./10-6fa1a60.md) | Add changelog entries for ddf89b3 and 21f6ccb, fix numbering |
| 11 | [`f3a7e10`](./11-f3a7e10.md) | Phase 2: conditional Stripe registration; document failed mocking attempts |
| 12 | [`e5872f1`](./12-e5872f1.md) | Add changelog entry for f3a7e10 |
| 13 | [`20d6941`](./13-20d6941.md) | Phase 3: shared customer identity and partial-return restock tests |
| 14 | [`f70f010`](./14-f70f010.md) | Verify storefronts against a real seeded backend end to end |
| 15 | [`8e2ca18`](./15-8e2ca18.md) | Phase 3: tax configuration (JP consumption tax, US deferred) |
