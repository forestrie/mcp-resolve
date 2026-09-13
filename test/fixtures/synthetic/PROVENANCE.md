# synthetic fixtures — not captured, cannot be captured on demand

`429.body.txt` is SYNTHESISED, not captured. It reproduces the body shape
lane A returned on 2026-09-12 while both lanes' shared Cloudflare account
was over its daily request cap (plan-2609-02 Blocker A, FOR-562): plain text
`error code: 1027`, Cloudflare's own rate-limit error page body, status 429.
Both lanes recovered ~16:46 UTC that day after the billing fix and have
answered 200 on every runner probe since (`test/fixtures/lane-a/PROVENANCE.md`),
so a real 429 exchange is not something a runner can capture on demand: it
only happens when the shared account is already over cap, which is not a
state to induce deliberately against a shared quota. `test/node/tools.test.ts`
replays this body with status 429, `content-type: text/plain` and header
`retry-after: 60` (a value invented for the test, not observed — the real
2026-09-12 incident did not carry a `retry-after` header) against each fetch
tool and the receipt step of `verify_fetched_receipt`, asserting the N8
posture: a structured `problem` with `status: 429` and `retryAfterMs: 60000`,
`isError: false`, exactly one request, and no retry.

| File | Status | Content-Type | Body | Header |
|---|---|---|---|---|
| `429.body.txt` | 429 | `text/plain` | `error code: 1027` (16 B) | `retry-after: 60` |

Frozen alongside the captured fixtures (N6 gate 6): a real 429 capture, if
one is ever taken, replaces this file in its own orchestrator-authorised
step and this note is updated to say so.
