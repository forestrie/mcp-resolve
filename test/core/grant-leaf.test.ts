/**
 * `grantLeafInputs` (plan-2609-06 phase 1 amendment, 2026-09-14), cross-
 * checked against the verifier's own `verifyGrantReceipt` over the SAME
 * bundled golden fixtures `test/core/compose.test.ts` and
 * `@forestrie/mcp-verify`'s `src/node/demo.ts` use. `src/node/fixtures.ts`
 * is not part of the verifier's published exports (only `"."` and
 * `"./server"` are), so the small amount of fixture-rebuilding it does is
 * reproduced here rather than imported — same reproduction as
 * `test/core/compose.test.ts`, not imported from there either, so this
 * file stays a standalone pin on `grantLeafInputs`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodeGrantPayloadV0Canonical,
  type Grant,
} from "@forestrie/encoding";
import { encodeKnownAccumulator } from "@forestrie/receipt-verify";
import {
  recomputeReceiptPeak,
  verifyGrantReceipt,
  type TrustRoot,
} from "@forestrie/mcp-verify";
import {
  GrantLeafInputError,
  grantLeafInputs,
  toContractLogId,
} from "../../src/core/index.js";

const repoRoot = new URL("../../", import.meta.url).pathname;
const FIXTURES_DIR = `${repoRoot}node_modules/@forestrie/mcp-verify/fixtures`;

function readFixture(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURES_DIR}/${relative}`));
}

type GoldenManifest = {
  logId: string;
  grantDataHex: string;
  idtimestampBe8Hex: string;
};

const GOLDEN_MANIFEST = JSON.parse(
  readFileSync(`${FIXTURES_DIR}/golden/manifest.json`, "utf8"),
) as GoldenManifest;

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function uuidToBytes(uuid: string): Uint8Array {
  return fromHex(uuid.replace(/-/g, ""));
}

/** `@forestrie/mcp-verify`'s `src/node/fixtures.ts` `goldenGrant()`,
 *  reproduced: owner and target are the same log, flag byte 3 is 0x03 and
 *  byte 7 is 0x01, heights are zero, `grantData` is the manifest's 64
 *  bytes. */
function goldenGrant(): Grant {
  const owner = uuidToBytes(GOLDEN_MANIFEST.logId);
  const flags = new Uint8Array(8);
  flags[3] = 0x03;
  flags[7] = 0x01;
  return {
    logId: owner,
    ownerLogId: owner,
    grant: flags,
    maxHeight: 0,
    minGrowth: 0,
    grantData: fromHex(GOLDEN_MANIFEST.grantDataHex),
  };
}

/** The golden committed grant as raw Forestrie-Grant v0 payload CBOR — NOT
 *  a Forestrie-Grant COSE Sign1. This is what `goldenCommittedGrant()`
 *  builds in the verifier's own fixtures (`encodeGrantPayloadV0Canonical`,
 *  no COSE wrapping), confirmed by `verify-grant-receipt.test.ts` always
 *  supplying `entryId` alongside it — a raw payload carries no embedded
 *  idtimestamp. Test (b) below pins that fact for `grantLeafInputs`. */
function goldenCommittedGrant(): Uint8Array {
  return encodeGrantPayloadV0Canonical(goldenGrant());
}

function goldenEntryId(): string {
  return `${GOLDEN_MANIFEST.idtimestampBe8Hex}0000000000000001`;
}

const RECEIPT = () => readFixture("golden/grant-receipt.cbor");

/** A SYNTHETIC known-accumulator snapshot binding (chainId 84532n — Base
 *  Sepolia, matching the rest of this package's fixtures; 20 zero bytes
 *  for univocity; the golden manifest's log id as bytes32 via
 *  `toContractLogId`; blockNumber 1n; 32 zero bytes for blockHash) around
 *  whatever peak/size the test derives — not a real chain read. */
function knownAccumulatorSnapshot(peak: Uint8Array, leafIndex: bigint) {
  return encodeKnownAccumulator({
    version: 1,
    chainId: 84532n,
    univocity: new Uint8Array(20),
    logId: fromHex(toContractLogId(GOLDEN_MANIFEST.logId)),
    size: leafIndex + 1n,
    accumulator: [peak],
    blockNumber: 1n,
    blockHash: new Uint8Array(32),
  });
}

describe("grantLeafInputs — cross-check against the verifier", () => {
  it("derives leaf inputs that make the verifier's own verifyGrantReceipt pass at a known-accumulator built from the recomputed peak, and fail when the peak is tampered", async () => {
    const receipt = RECEIPT();
    const committedGrant = goldenCommittedGrant();
    const entryId = goldenEntryId();

    const { idtimestampBe8, inner } = await grantLeafInputs(
      committedGrant,
      entryId,
    );
    const { peak, leafIndex } = await recomputeReceiptPeak({
      receiptCbor: receipt,
      idtimestampBe8,
      inner,
    });

    const trust: TrustRoot = {
      root: "known-accumulator",
      accumulator: knownAccumulatorSnapshot(peak, leafIndex),
    };
    const ok = await verifyGrantReceipt({
      receipt,
      committedGrant,
      entryId,
      trust,
    });
    expect(ok.ok).toBe(true);

    const tamperedPeak = new Uint8Array(peak);
    const lastIndex = tamperedPeak.length - 1;
    tamperedPeak[lastIndex] = (tamperedPeak[lastIndex] ?? 0) ^ 0xff;
    const tamperedTrust: TrustRoot = {
      root: "known-accumulator",
      accumulator: knownAccumulatorSnapshot(tamperedPeak, leafIndex),
    };
    const bad = await verifyGrantReceipt({
      receipt,
      committedGrant,
      entryId,
      trust: tamperedTrust,
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("peak_not_in_known_accumulator");
  });
});

describe("grantLeafInputs — which form the golden fixture grant is", () => {
  it("is a raw grant payload (not COSE): without entryId it throws missing_entry_id", async () => {
    const committedGrant = goldenCommittedGrant();
    await expect(grantLeafInputs(committedGrant)).rejects.toMatchObject({
      kind: "missing_entry_id",
    });
  });

  it("with entryId, derives the same leaf inputs the cross-check above uses", async () => {
    const committedGrant = goldenCommittedGrant();
    const entryId = goldenEntryId();
    const { idtimestampBe8 } = await grantLeafInputs(committedGrant, entryId);
    expect(idtimestampBe8).toEqual(fromHex(GOLDEN_MANIFEST.idtimestampBe8Hex));
  });

  // The COSE-Sign1 form is not trivially buildable from the same grant in
  // this package: wrapping a grant as a Forestrie-Grant COSE Sign1 needs a
  // signing key (`@forestrie/grant-builder`), which is not a dependency
  // here. Not tested — the fixture grant is raw, and that is the branch
  // covered above.
});

describe("grantLeafInputs — undecodable committedGrant", () => {
  it("throws undecodable with a non-empty detail", async () => {
    let caught: unknown;
    try {
      await grantLeafInputs(new Uint8Array([1, 2]));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GrantLeafInputError);
    const err = caught as GrantLeafInputError;
    expect(err.kind).toBe("undecodable");
    expect(err.detail).toBeTruthy();
  });
});
