/**
 * Compose logic over already-fetched bytes: run the verifier's own core
 * (`verifyReceipt` / `verifyGrantReceipt`) and append exactly the honesty
 * rule's two diagnostics (plan-2609-05 N3). This package has NO
 * verification arithmetic of its own — every field but `diagnostics` and
 * `courier` is the verifier's object, untouched.
 */
import {
  recomputeReceiptPeak,
  summarize,
  verifyGrantReceipt,
  verifyReceipt,
  type TrustRoot,
  type VerifyResult,
} from "@forestrie/mcp-verify";
import { COURIER } from "./version.js";
import type { CourierDiagnostic, FetchedVerifyResult } from "./result.js";

export type VerifyFetchedInput = {
  receipt: Uint8Array;
  /** Where the root came from: bytes the caller supplied, an accumulator
   *  this call read from the chain's latest `logState` (N2 amendment A),
   *  or a checkpoint this call selected from published
   *  `CheckpointPublished` history because the latest state no longer
   *  held the receipt's peak (plan-2609-06 F1). */
  rootProvenance: "supplied" | "chain-read" | "chain-read-history";
} & (
  | {
      kind: "payload";
      /** The EXACT registered payload whose SHA-256 is the leaf ContentHash. */
      payload: Uint8Array;
      entryId: string;
      trust: TrustRoot;
    }
  | {
      kind: "grant";
      /** Forestrie-Grant COSE Sign1, or raw grant payload CBOR. */
      committedGrant: Uint8Array;
      /** Required when the grant is raw rather than COSE. */
      entryId?: string;
      trust: TrustRoot;
    }
);

const RECEIPT_FETCHED_FROM_OPERATOR: CourierDiagnostic = {
  code: "receipt_fetched_from_operator",
  message:
    "the receipt bytes were fetched from the operator's API in this call",
};

const ROOT_READ_FROM_CHAIN: CourierDiagnostic = {
  code: "root_read_from_chain",
  message:
    "the accumulator was read from the chain in this call, at the caller's RPC URL",
};

/** F1, verbatim (plan-2609-06 01-phase-1-history.md 1.5.2). Appended
 *  alongside `root_read_from_chain` — never instead of it — when the root
 *  came from a checkpoint selected out of published history rather than
 *  the latest `logState`. */
const ROOT_READ_FROM_CHAIN_HISTORY: CourierDiagnostic = {
  code: "root_read_from_chain_history",
  message:
    "the accumulator was selected from published checkpoint history in this call, at the caller's RPC URL",
};

/**
 * Run the verifier's `verifyReceipt` / `verifyGrantReceipt` and return its
 * result unaltered except for `diagnostics` (the verifier's, followed by
 * `receipt_fetched_from_operator` always, `root_read_from_chain` for
 * either chain-read root, and `root_read_from_chain_history` additionally
 * when the root was selected from history) and `courier` (this package's
 * identity, alongside the verifier's — N1).
 */
export async function verifyFetched(
  input: VerifyFetchedInput,
): Promise<FetchedVerifyResult> {
  const result: VerifyResult =
    input.kind === "payload"
      ? await verifyReceipt({
          receipt: input.receipt,
          payload: input.payload,
          entryId: input.entryId,
          trust: input.trust,
        })
      : await verifyGrantReceipt({
          receipt: input.receipt,
          committedGrant: input.committedGrant,
          ...(input.entryId !== undefined ? { entryId: input.entryId } : {}),
          trust: input.trust,
        });

  const isChainRead =
    input.rootProvenance === "chain-read" ||
    input.rootProvenance === "chain-read-history";
  const diagnostics: FetchedVerifyResult["diagnostics"] = [
    ...result.diagnostics,
    RECEIPT_FETCHED_FROM_OPERATOR,
    ...(isChainRead ? [ROOT_READ_FROM_CHAIN] : []),
    ...(input.rootProvenance === "chain-read-history"
      ? [ROOT_READ_FROM_CHAIN_HISTORY]
      : []),
  ];

  return { ...result, diagnostics, courier: COURIER };
}

/**
 * Whether a `verifyFetched` result failed specifically because the
 * receipt's recomputed peak is not among the accumulator's peaks —
 * `@forestrie/receipt-verify`'s `known-accumulator.js` `stage: "signature",
 * reason: "peak_not_in_known_accumulator"` (surfaced unaltered through
 * `@forestrie/mcp-verify`'s `VerifyResult.reason`) — as opposed to any
 * other failure. This is the one case F1's fallback applies to; every
 * other failure (a bad signature, a stale snapshot, a malformed receipt)
 * is answered as today, with no history scan.
 */
export function isPeakNotInKnownAccumulator(result: {
  ok: boolean;
  reason?: string;
}): boolean {
  return (
    result.ok === false && result.reason === "peak_not_in_known_accumulator"
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * `fetch_accumulator`'s `forReceipt` check: is this receipt's MMR peak one
 * of `accumulator`'s peaks? Uses the verifier's own `recomputeReceiptPeak`
 * — no hashing of our own (AGENTS.md: no verification arithmetic of its
 * own).
 *
 * A caveat this package's `forReceipt` input cannot avoid: `fetch_accumulator`
 * carries no `payload`/`entryId` (unlike `verify_fetched_receipt`), so an
 * ATTACHED-payload receipt (its COSE Sign1 payload is the peak itself,
 * `recomputeReceiptPeak`'s `explicitPeak` branch) is checked correctly, but
 * a DETACHED-payload receipt — whose peak can only be recomputed from the
 * leaf (`idtimestamp` + the registered payload's content hash) — cannot be,
 * since neither is available here. The zero-filled placeholders below are
 * inert in the explicit-peak branch and, for a detached receipt, yield a
 * peak that (harmlessly) will not match any real checkpoint: `held` comes
 * back `false` and the caller falls through to the history scan, which may
 * then report `history_scan_exhausted` for a peak that a payload-aware
 * caller (`verify_fetched_receipt`) could in fact have found. Never a false
 * "held".
 */
export async function receiptPeakHeld(
  receipt: Uint8Array,
  accumulator: Uint8Array[],
): Promise<boolean> {
  const { peak } = await recomputeReceiptPeak({
    receiptCbor: receipt,
    idtimestampBe8: new Uint8Array(8),
    inner: new Uint8Array(32),
  });
  return accumulator.some((p) => bytesEqual(p, peak));
}

/**
 * The text summary: the provenance line, then the verifier's own
 * `summarize()` output, unaltered (N3).
 */
export function summarizeFetched(
  verb: string,
  result: FetchedVerifyResult,
  provenanceLine: string,
): string {
  // `summarize` only reads ok/stage/reason/root/questions (verify-shared.ts)
  // — none of which `diagnostics` or `courier` touch — so a VerifyResult
  // is reconstructed from those fields rather than widening-casting
  // `result` itself past its widened `diagnostics` type.
  const verifierResult: VerifyResult = {
    ok: result.ok,
    root: result.root,
    stage: result.stage,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    stages: result.stages,
    ...(result.anchor !== undefined ? { anchor: result.anchor } : {}),
    questions: result.questions,
    diagnostics: [],
    verifier: result.verifier,
  };
  return `${provenanceLine}\n${summarize(verb, verifierResult)}`;
}
