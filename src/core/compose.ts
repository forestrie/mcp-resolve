/**
 * Compose logic over already-fetched bytes: run the verifier's own core
 * (`verifyReceipt` / `verifyGrantReceipt`) and append exactly the honesty
 * rule's two diagnostics (plan-2609-05 N3). This package has NO
 * verification arithmetic of its own — every field but `diagnostics` and
 * `courier` is the verifier's object, untouched.
 */
import {
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
  /** Where the root came from: bytes the caller supplied, or an
   *  accumulator this call read from the chain (N2 amendment A). */
  rootProvenance: "supplied" | "chain-read";
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

/**
 * Run the verifier's `verifyReceipt` / `verifyGrantReceipt` and return its
 * result unaltered except for `diagnostics` (the verifier's, followed by
 * `receipt_fetched_from_operator` always, then `root_read_from_chain` only
 * for a chain-read root) and `courier` (this package's identity, alongside
 * the verifier's — N1).
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

  const diagnostics: FetchedVerifyResult["diagnostics"] = [
    ...result.diagnostics,
    RECEIPT_FETCHED_FROM_OPERATOR,
    ...(input.rootProvenance === "chain-read" ? [ROOT_READ_FROM_CHAIN] : []),
  ];

  return { ...result, diagnostics, courier: COURIER };
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
