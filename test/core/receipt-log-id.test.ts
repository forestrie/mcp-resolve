import { encodeCborDeterministic } from "@forestrie/encoding";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeReceiptLogId } from "../../src/core/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE_A_RECEIPT_PATH = path.join(
  HERE,
  "..",
  "fixtures",
  "lane-a",
  "receipt-self.cbor",
);

/** e8345800-a747-4e62-9409-61622b836f1f — the UUID form of claim `1` in
 *  lane-A's frozen receipt's delegation certificate (runner 2.1 facts). */
const EXPECTED_UUID = "e8345800-a747-4e62-9409-61622b836f1f";

/** A minimal 4-element COSE_Sign1-shaped array, no unprotected label 1000
 *  — enough to exercise the "no certificate" path without a real receipt. */
function receiptWithoutCertificate(): Uint8Array {
  return encodeCborDeterministic([
    encodeCborDeterministic(new Map()), // protected header bytes
    new Map([[396, new Map()]]), // unprotected header, no label 1000
    null, // detached payload
    new Uint8Array(4), // signature
  ]);
}

describe("decodeReceiptLogId", () => {
  it("decodes the lane-A receipt's delegation-certificate log id as a dashed UUID", () => {
    const receipt = new Uint8Array(readFileSync(LANE_A_RECEIPT_PATH));
    expect(decodeReceiptLogId(receipt)).toEqual({ logId: EXPECTED_UUID });
  });

  it("returns undefined for a receipt with no unprotected label 1000", () => {
    expect(decodeReceiptLogId(receiptWithoutCertificate())).toBeUndefined();
  });

  it("returns undefined, never throws, for bytes that aren't CBOR at all", () => {
    expect(
      decodeReceiptLogId(new Uint8Array([0xff, 0xff, 0xff])),
    ).toBeUndefined();
  });
});
