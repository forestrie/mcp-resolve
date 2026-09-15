/**
 * Grant-receipt leaf inputs:
 * the `idtimestampBe8` / `inner` pair `recomputeReceiptPeak` needs for a
 * grant receipt, derived without any verification arithmetic of this
 * package's own — only the COSE-vs-raw-grant decode dispatch, mirrored
 * because `@forestrie/mcp-verify` 0.4.0 keeps it private.
 *
 * No `node:*` here — this module is reachable from `src/core/index.ts`,
 * which the browser-safety gate bundles for `platform: "browser"`.
 */
import {
  decodeForestrieGrantCose,
  entryIdHexToIdtimestampBe8,
  grantCommitmentHashFromGrant,
} from "@forestrie/receipt-verify";
import { decodeGrantPayload, type Grant } from "@forestrie/encoding";

/** Thrown by `grantLeafInputs` for a `committedGrant` it cannot derive leaf
 *  inputs from. `kind` names which of the two verifier-mirrored failures
 *  this is; `detail` (only set for `"undecodable"`) is the raw-payload
 *  decoder's own error message, unwrapped from the verifier's sentence so
 *  `src/node/tools.ts` can quote it inline in its own problem message. */
export class GrantLeafInputError extends Error {
  readonly kind: "missing_entry_id" | "undecodable";
  readonly detail?: string;

  constructor(
    kind: "missing_entry_id" | "undecodable",
    message: string,
    detail?: string,
  ) {
    super(message);
    this.name = "GrantLeafInputError";
    this.kind = kind;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Mirrors `@forestrie/mcp-verify` 0.4.0's `decodeCommittedGrant`
 * (`src/core/verify-grant-receipt.ts`), which is not exported, in the same
 * order and fallback as `forestrie-cli`'s `verify-inputs.ts`
 * `decodeGrantBytes`: try Forestrie-Grant COSE Sign1 first, fall back to
 * raw grant payload CBOR, which requires `entryId` because it carries no
 * embedded idtimestamp.
 *
 * `test/core/grant-leaf.test.ts` pins this to the verifier's own
 * `verifyGrantReceipt`, so a change in the verifier's dispatch is a red
 * test, not a silent drift. Delete this copy if the verifier ever exports
 * `decodeCommittedGrant` (or an equivalent) — see that file's header.
 */
function decodeCommittedGrant(
  bytes: Uint8Array,
  entryId?: string,
): { grant: Grant; idtimestampBe8: Uint8Array } {
  try {
    const decoded = decodeForestrieGrantCose(bytes);
    return {
      grant: decoded.grant,
      idtimestampBe8:
        entryId !== undefined
          ? entryIdHexToIdtimestampBe8(entryId)
          : decoded.idtimestampBe8,
    };
  } catch {
    // Not a Forestrie-Grant COSE Sign1 — fall through to raw payload CBOR.
  }
  let grant: Grant;
  try {
    grant = decodeGrantPayload(bytes);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new GrantLeafInputError(
      "undecodable",
      `committedGrant is neither a Forestrie-Grant COSE Sign1 nor a raw grant payload: ${detail}`,
      detail,
    );
  }
  if (entryId === undefined) {
    throw new GrantLeafInputError(
      "missing_entry_id",
      "committedGrant is a raw grant payload (no embedded idtimestamp) — supply entryId",
    );
  }
  return { grant, idtimestampBe8: entryIdHexToIdtimestampBe8(entryId) };
}

/**
 * The grant leaf's `idtimestampBe8` / `inner` — the same pair
 * `recomputeReceiptPeak` takes for a payload receipt, derived here from a
 * committed grant (COSE or raw) instead of a registered payload. `inner`
 * is the verifier's own `grantCommitmentHashFromGrant(grant)` — no
 * verification arithmetic of this package's own, only the decode
 * dispatch above.
 */
export async function grantLeafInputs(
  committedGrant: Uint8Array,
  entryId?: string,
): Promise<{ idtimestampBe8: Uint8Array; inner: Uint8Array }> {
  const { grant, idtimestampBe8 } = decodeCommittedGrant(
    committedGrant,
    entryId,
  );
  const inner = await grantCommitmentHashFromGrant(grant);
  return { idtimestampBe8, inner };
}
