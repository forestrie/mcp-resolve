/**
 * `@forestrie/mcp-resolve` — the browser-safe core.
 *
 * This is the `"."` export. Everything reachable from here is pure over
 * bytes: no `node:*`, no `fetch`, no filesystem, no MCP SDK. An importer who
 * takes `"."` gets URL construction, response classification and
 * provenance/supports labelling and nothing else; `"./net"` is the only
 * place `fetch` is called, and `"./server"` is where the MCP adapter lives.
 * `pnpm run check:browser-safe` bundles this file for `platform: "browser"`
 * and fails on any edge to a node builtin, so that boundary is proven on
 * every test run and before every publish, not asserted.
 *
 * Phase 1 step 1.6 (plan-2609-05) adds the pure layer proper: `endpoints.ts`
 * (URL + calldata builders), `chain.ts` (logState ABI decode + known-
 * accumulator snapshot builder), `genesis-binding.ts` (the forest's chain
 * binding, decoded from a genesis document — N2 amendment A),
 * `classify.ts` (response classification, N8), `provenance.ts`
 * (the honesty rule's fixed `SUPPORTS` table, N3), `compose.ts`
 * (`verifyFetched` / `summarizeFetched` over the verifier's own core), and
 * `result.ts` (`FetchedVerifyResult`).
 */

export {
  PACKAGE_VERSION,
  VERIFIER_VERSION,
  SCRAPI_CLIENT_VERSION,
  RECEIPT_VERIFY_VERSION,
  ENCODING_VERSION,
  COURIER,
} from "./version.js";

export {
  EndpointError,
  scittConfigurationUrl,
  registrationStatusUrl,
  receiptUrl,
  genesisUrl,
  LOG_STATE_SELECTOR,
  toContractLogId,
  logStateCalldata,
  normalizeAddress,
} from "./endpoints.js";

export {
  ChainError,
  hexToBigint,
  hexToBytes32,
  decodeLogStateResult,
  buildKnownAccumulator,
} from "./chain.js";

export {
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_SCHEMA_V2,
  GenesisBindingError,
  decodeChainBindingFromGenesis,
} from "./genesis-binding.js";
export type { ChainBinding } from "./genesis-binding.js";

export { classify } from "./classify.js";
export type { ClassifyRoute, ClassifyView, Classified } from "./classify.js";

export { SUPPORTS, COURIER_DIAGNOSTIC_CODES } from "./provenance.js";
export type {
  ProvenanceSource,
  Provenance,
  HistoryProvenance,
  SupportsRow,
  Supports,
  ToolName,
} from "./provenance.js";

export {
  verifyFetched,
  summarizeFetched,
  isPeakNotInKnownAccumulator,
  recomputePeakForReceipt,
  peakHeldIn,
} from "./compose.js";
export type { VerifyFetchedInput } from "./compose.js";

export {
  CHECKPOINT_PUBLISHED_TOPIC0,
  HistoryError,
  checkpointPublishedTopics,
  decodeCheckpointPublishedLog,
  historyWindows,
  selectCheckpoint,
  sortNewestFirst,
  toKnownAccumulator,
} from "./history.js";
export type { HistoryWindow, PublishedCheckpoint } from "./history.js";

// The verifier's trust-root input union: `VerifyFetchedInput["trust"]`'s
// type, re-exported so a caller of `verifyFetched` need not also depend on
// `@forestrie/mcp-verify` directly just to name it.
export type { TrustRoot } from "@forestrie/mcp-verify";

export type {
  AnchorReport,
  CourierDiagnostic,
  CourierDiagnosticCode,
  Diagnostic,
  DiagnosticCode,
  FetchedVerifyResult,
  QuestionAnswer,
  QuestionName,
  QuestionStatus,
  ReceiptVerifyStage,
  RootName,
  StageRow,
  StageStatus,
  TrustQuestions,
  VerifierIdentity,
  VerifyResult,
} from "./result.js";
