/**
 * The honesty rule as data: where every fetched or
 * chain-read artefact came from, and which of the verifier's four trust
 * questions the fetched material can serve as evidence for, under which
 * root. The `SUPPORTS` rows and notes are fixed wording, changed only on
 * purpose; `test/core/supports-table.test.ts` asserts every row and note
 * against a literal copy, so a drift in either file is a red test.
 */
import type { QuestionName, RootName } from "@forestrie/mcp-verify";

export type ProvenanceSource = "fetched" | "chain-read" | "supplied";

/** Present only when the accumulator was selected from published
 *  `CheckpointPublished` history rather than the latest `logState`
 *  read: the selected checkpoint's own block/size, and how much of the
 *  scan it cost. `blockNumber`/`blockHash`/`size` name the one checkpoint
 *  selected out of history (`fetch_accumulator`, `verify_fetched_receipt`);
 *  they are absent for `fetch_checkpoint_history`, whose scan returns
 *  every checkpoint in range rather than selecting one, so only the scan's
 *  own bounds and cost apply there. */
export type HistoryProvenance = {
  blockNumber?: number;
  blockHash?: string;
  size?: number;
  scannedFrom: number;
  scannedTo: number;
  requests: number;
};

export type Provenance = {
  source: ProvenanceSource;
  from: string | { rpcUrl: string; univocity: string; chainId: number };
  at: string;
  binding?: "held-genesis" | "explicit";
  history?: HistoryProvenance;
};

/** `verify_fetched_receipt`'s top-level
 *  `provenance.logId`, present whenever a chain read happens — which log
 *  id was used to make it. `"caller"` when the caller supplied one
 *  (`trust.chain.logId`, or else the receipt coordinates' `logId`);
 *  `"receipt-delegation-certificate"` when the caller supplied neither
 *  and the id came from the receipt's own delegation certificate instead. */
export type LogIdProvenance = {
  source: "caller" | "receipt-delegation-certificate";
  value: string;
};

export type SupportsRow = { question: QuestionName; root: RootName };

export type Supports = { rows: SupportsRow[]; note: string };

export type ToolName =
  | "fetch_scitt_configuration"
  | "query_registration"
  | "fetch_receipt"
  | "fetch_genesis"
  | "fetch_accumulator"
  | "fetch_checkpoint_history"
  | "verify_fetched_receipt";

/** The vocabulary is trust roots and the four questions, never a ranking
 *  or a ladder: what changes with provenance is WHICH questions the
 *  material can support, not how much it is worth. */
export const SUPPORTS: Record<ToolName, Supports> = {
  fetch_receipt: {
    rows: [],
    note: "a receipt is the operator's claim; verify it under a root you hold",
  },
  fetch_genesis: {
    rows: [{ question: "sealing", root: "known-log-key" }],
    note: "keep this copy; a copy obtained at check time is not the genesis root as intended. The chain binding in this copy (contract address, chain id) is likewise the operator's claim today: a chain read under an address obtained at check time answers split-view against the contract the operator named, so keep the copy from registration, or cross-check the address against a source you trust independently",
  },
  fetch_accumulator: {
    rows: [
      { question: "split-view", root: "known-accumulator" },
      { question: "sealing", root: "known-accumulator" },
      { question: "append-authority", root: "known-accumulator" },
    ],
    note: "split-view against the chain rather than the operator; sealing and append-authority by inheritance from the contract's publish-time checks, stated as inheritance, never as a local signature check",
  },
  fetch_checkpoint_history: {
    rows: [
      { question: "split-view", root: "known-accumulator" },
      { question: "sealing", root: "known-accumulator" },
      { question: "append-authority", root: "known-accumulator" },
    ],
    note: "split-view against the chain rather than the operator; sealing and append-authority by inheritance from the contract's publish-time checks, stated as inheritance, never as a local signature check; a kept checkpoint answers split-view later, without another chain read, for any receipt whose peak it contains",
  },
  fetch_scitt_configuration: {
    rows: [],
    note: "operator self-description; evidence for none of the four questions",
  },
  query_registration: {
    rows: [],
    note: "registration status; evidence for none of the four questions",
  },
  verify_fetched_receipt: {
    rows: [],
    note: "the verifier's own questions object, passed through unaltered; diagnostics say where the bytes came from",
  },
};

/** Appended to the verifier's own diagnostics — the first three by
 *  `compose.ts`'s `verifyFetched`: always `receipt_fetched_from_operator`;
 *  `root_read_from_chain` when the root came from a chain read (the
 *  latest `logState`, or a checkpoint selected from history); and
 *  `root_read_from_chain_history` additionally when that
 *  chain read walked published `CheckpointPublished` history rather than
 *  reading `logState` directly. `receipt_log_id_mismatch` is
 *  different: `src/node/tools.ts`'s `verify_fetched_receipt` appends it
 *  directly, not `compose.ts`, when the caller named a log id and the
 *  receipt's own delegation certificate names a different one — the call
 *  still reads the caller's log; the mismatch is the finding. */
export const COURIER_DIAGNOSTIC_CODES = [
  "receipt_fetched_from_operator",
  "root_read_from_chain",
  "root_read_from_chain_history",
  "receipt_log_id_mismatch",
] as const;
