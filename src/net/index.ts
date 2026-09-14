/**
 * `@forestrie/mcp-resolve` — the network layer.
 *
 * This is the `"./net"` export, and the ONLY place in this package that
 * calls `fetch` (through `./http.ts`, shared plumbing not exported here).
 * Every function takes `fetchImpl` as a parameter, defaulting to
 * `globalThis.fetch`, so that `test/net/**` can exercise this layer
 * entirely through injected fakes and the unit project's forbidden-fetch
 * setup (N6 gate 2) never sees a real network call.
 *
 * `scrapi.ts` exports four thin GET wrappers over the SCRAPI routes
 * `src/core/endpoints.ts` builds — `fetchScittConfiguration`,
 * `queryRegistration`, `fetchReceipt`, `fetchGenesis` — each returning a
 * raw `{status, headers, body}` for `src/core/classify.ts` to interpret.
 * `chain.ts` makes the JSON-RPC calls for the accumulator read itself —
 * N4 amendment B — rather than depending on `@forestrie/chain-rpc`, whose
 * `EthRpcOptions` has no `fetchImpl`/`fetch` injection point:
 * `readLogState` is the three-call `eth_chainId` /
 * `eth_getBlockByNumber` / `eth_call` read, and `fetchAccumulatorSnapshot`
 * composes it with core's decode/encode into a `known-accumulator`
 * snapshot; `readChainHead` (plan-2609-06 F4) is the same first two calls
 * without the `eth_call`, for `fetch_checkpoint_history`, which has no use
 * for `logState`. `types.ts` carries the shapes both share (`RawResponse`,
 * `FetchOptions`, `NetError`) and `toClassifyView`, the mapping from a
 * `RawResponse` onto core's `ClassifyView`.
 */

export type { RawResponse, FetchOptions } from "./types.js";
export { NetError, toClassifyView } from "./types.js";

export {
  fetchScittConfiguration,
  queryRegistration,
  fetchReceipt,
  fetchGenesis,
} from "./scrapi.js";
export type { FetchReceiptInput } from "./scrapi.js";

export {
  readLogState,
  readChainHead,
  fetchAccumulatorSnapshot,
} from "./chain.js";
export type {
  ReadLogStateInput,
  ReadLogStateResult,
  ReadChainHeadInput,
  ReadChainHeadResult,
  LogStateProblem,
  FetchAccumulatorSnapshotResult,
} from "./chain.js";

export { scanCheckpointHistory, fetchCheckpointHistory } from "./history.js";
export type {
  ScanCheckpointHistoryInput,
  ScanCheckpointHistoryResult,
  FetchCheckpointHistoryResult,
  CheckpointHistoryProblem,
} from "./history.js";
