/**
 * `@forestrie/mcp-resolve` — the network layer.
 *
 * This is the `"./net"` export, and the ONLY place in this package that
 * calls `fetch`. Every function here takes `fetchImpl` as a parameter,
 * defaulting to `globalThis.fetch`, so that `test/net/**` can exercise this
 * layer entirely through injected fakes and the unit project's forbidden-fetch
 * setup (N6 gate 2) never sees a real network call. `src/net/chain.ts`
 * (phase 2) makes the JSON-RPC calls for the accumulator read itself — N4
 * amendment B — rather than depending on `@forestrie/chain-rpc`, whose
 * `EthRpcOptions` has no `fetchImpl`/`fetch` injection point.
 *
 * Phase 1 (this repo's bootstrap, plan-2609-05 step 1.5) exports nothing
 * yet: the scrapi-client wrappers and the local chain reader are phase 2
 * work.
 */

export {};
