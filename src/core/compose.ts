/**
 * Compose logic over already-fetched bytes: run the verifier's own core
 * (`verifyReceipt` / `verifyGrantReceipt`) and append the honesty rule's
 * courier diagnostics. This package has NO
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
import { entryIdHexToIdtimestampBe8 } from "@forestrie/receipt-verify";
import { COURIER } from "./version.js";
import type { CourierDiagnostic, FetchedVerifyResult } from "./result.js";

export type VerifyFetchedInput = {
  receipt: Uint8Array;
  /** Where the root came from: bytes the caller supplied, an accumulator
   *  this call read from the chain's latest `logState`,
   *  or a checkpoint this call selected from published
   *  `CheckpointPublished` history because the latest state no longer
   *  held the receipt's peak. */
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

/** Fixed wording, quoted in docs/what-fetching-proves.md. Appended
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
 * identity, alongside the verifier's).
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
 * other failure. This is the one case the history fallback applies to; every
 * other failure (a bad signature, a stale snapshot, a malformed receipt)
 * is returned as is, with no history scan.
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

/** SHA-256 of the exact registered payload — the leaf's inner ContentHash
 *  for a payload receipt, exactly the value `@forestrie/mcp-verify`'s own
 *  `verifyReceipt` computes before calling `recomputeReceiptPeak` (its
 *  `innerHash`, not exported, is this same WebCrypto digest — no
 *  verification arithmetic is reimplemented here, only the platform's own
 *  hash primitive, same as every other leaf-input caller). */
async function payloadInnerHash(payload: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(payload)),
  );
}

/**
 * `fetch_accumulator`'s `forReceipt` check: recompute the receipt's MMR peak from its real leaf inputs
 * via the verifier's own `recomputeReceiptPeak`. No verification
 * arithmetic of its own: the peak recompute and the leaf-input derivation
 * are both the verifier stack's, never reimplemented here. `kind:
 * "payload"` derives `idtimestampBe8`/`inner` from `entryId`
 * (`@forestrie/receipt-verify`'s `entryIdHexToIdtimestampBe8`) and the
 * exact registered payload (`payloadInnerHash` above); `kind: "grant"`
 * takes them already derived — see `grant-leaf.ts`'s `grantLeafInputs`,
 * which mirrors the verifier's private COSE-vs-raw-grant decode dispatch.
 */
export async function recomputePeakForReceipt(
  input:
    | {
        kind: "payload";
        receipt: Uint8Array;
        payload: Uint8Array;
        entryId: string;
      }
    | {
        kind: "grant";
        receipt: Uint8Array;
        idtimestampBe8: Uint8Array;
        inner: Uint8Array;
      },
): Promise<Uint8Array> {
  const { idtimestampBe8, inner } =
    input.kind === "payload"
      ? {
          idtimestampBe8: entryIdHexToIdtimestampBe8(input.entryId),
          inner: await payloadInnerHash(input.payload),
        }
      : { idtimestampBe8: input.idtimestampBe8, inner: input.inner };
  const { peak } = await recomputeReceiptPeak({
    receiptCbor: input.receipt,
    idtimestampBe8,
    inner,
  });
  return peak;
}

/** Is `peak` one of `accumulator`'s peaks? Pure byte comparison —
 *  "compare the recomputed peak to every peak", over a peak recomputed
 *  once by `recomputePeakForReceipt` and compared against as many
 *  candidate accumulators as the history scan needs. */
export function peakHeldIn(
  peak: Uint8Array,
  accumulator: Uint8Array[],
): boolean {
  return accumulator.some((p) => bytesEqual(p, peak));
}

/**
 * The text summary: the provenance line, then the verifier's own
 * `summarize()` output, unaltered.
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
