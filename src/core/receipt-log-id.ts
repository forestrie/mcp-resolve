/**
 * Decode the log id a receipt's own delegation certificate names: claim
 * `1` of the nested COSE_Sign1 the
 * outer receipt's unprotected header carries at label `1000` — the
 * delegation certificate the operator attached when it delegated signing
 * authority for this receipt. That claim is the certificate's own
 * statement of which log it was issued for, decoded from the same bytes
 * the receipt itself is, so it costs no extra request.
 *
 * `@forestrie/delegation-cose` owns both labels (the unprotected header
 * label `1000` for the nested certificate, and payload claim `1` for the
 * log id within it) but is not a dependency of this package — kept out of
 * the browser-safe core deliberately, and not in this package's lockfile
 * — so both are redefined locally below, exactly as `genesis-binding.ts`
 * redefines the `FOREST_GENESIS_LABEL_*` constants it cannot import.
 *
 * Never throws: a receipt with no certificate at label `1000`, a
 * certificate that isn't a decodable COSE_Sign1, a certificate payload
 * with no claim `1`, or a claim `1` that isn't 32 or 64 hex characters,
 * all return `undefined` rather than an error — this is a cross-check and a
 * fallback default, not a validation gate on receipts that predate it or
 * never carry a certificate.
 */
import {
  decodeCborDeterministic,
  decodeCborUnwrapCose,
} from "@forestrie/encoding";
import { toContractLogId } from "./endpoints.js";

/** `@forestrie/delegation-cose`'s unprotected-header label for the nested
 *  delegation-certificate COSE_Sign1, mirrored here (see this file's
 *  docstring). */
export const RECEIPT_DELEGATION_CERTIFICATE_LABEL = 1000;

/** `@forestrie/delegation-cose`'s payload claim for the log id the
 *  delegation certificate was issued for, mirrored here (see this file's
 *  docstring). */
export const RECEIPT_DELEGATION_CERTIFICATE_LOG_ID_CLAIM = 1;

function formatUuid(hex32: string): string {
  return [
    hex32.slice(0, 8),
    hex32.slice(8, 12),
    hex32.slice(12, 16),
    hex32.slice(16, 20),
    hex32.slice(20, 32),
  ].join("-");
}

/** Decode a receipt's raw bytes, without throwing on anything malformed
 *  along the way — every step below returns `undefined` on the first
 *  thing that doesn't hold, rather than propagating a decode error. */
export function decodeReceiptLogId(
  receipt: Uint8Array,
): { logId: string } | undefined {
  let outer: unknown;
  try {
    outer = decodeCborUnwrapCose(receipt);
  } catch {
    return undefined;
  }
  if (!Array.isArray(outer) || outer.length < 2) return undefined;

  const unprotected = outer[1];
  if (!(unprotected instanceof Map)) return undefined;
  const certificateBytes = unprotected.get(
    RECEIPT_DELEGATION_CERTIFICATE_LABEL,
  );
  if (!(certificateBytes instanceof Uint8Array)) return undefined;

  let certificate: unknown;
  try {
    certificate = decodeCborUnwrapCose(certificateBytes);
  } catch {
    return undefined;
  }
  if (!Array.isArray(certificate) || certificate.length < 3) return undefined;

  const certificatePayloadBytes = certificate[2];
  if (!(certificatePayloadBytes instanceof Uint8Array)) return undefined;

  let certificatePayload: unknown;
  try {
    certificatePayload = decodeCborDeterministic(certificatePayloadBytes);
  } catch {
    return undefined;
  }
  if (!(certificatePayload instanceof Map)) return undefined;

  const claim = certificatePayload.get(
    RECEIPT_DELEGATION_CERTIFICATE_LOG_ID_CLAIM,
  );
  if (typeof claim !== "string") return undefined;

  let contractForm: string;
  try {
    contractForm = toContractLogId(claim);
  } catch {
    return undefined;
  }

  return { logId: formatUuid(contractForm.slice(-32)) };
}
