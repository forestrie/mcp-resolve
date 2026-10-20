/**
 * Shared helpers for the verifier's frozen conformance grant
 * fixture (`@forestrie/mcp-verify`'s `fixtures/golden/`), used by both
 * `test/core/grant-leaf.test.ts` (the raw-grant branch and the cross-check
 * against `verifyGrantReceipt`) and its COSE-branch companion describe
 * blocks in the same file. Moved here so the two stay in sync rather than
 * each keeping its own copy — see `test/core/grant-leaf.test.ts`'s header
 * for why this reproduction (not an import from the verifier) exists at
 * all: `@forestrie/mcp-verify`'s `src/node/fixtures.ts` is not part of its
 * published exports (only `"."` and `"./server"` are).
 */
import { readFileSync } from "node:fs";
import {
  encodeGrantPayloadV0Canonical,
  type Grant,
} from "@forestrie/encoding";
import { indexHeight } from "@forestrie/merklelog";
import {
  encodeKnownAccumulator,
  parseReceipt,
  peakMMRIndexes,
} from "@forestrie/receipt-verify";
import { toContractLogId } from "../../src/core/index.js";

const repoRoot = new URL("../../", import.meta.url).pathname;
const FIXTURES_DIR = `${repoRoot}node_modules/@forestrie/mcp-verify/fixtures`;

export function readFixture(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURES_DIR}/${relative}`));
}

export type GoldenManifest = {
  logId: string;
  grantDataHex: string;
  idtimestampBe8Hex: string;
};

export const GOLDEN_MANIFEST = JSON.parse(
  readFileSync(`${FIXTURES_DIR}/golden/manifest.json`, "utf8"),
) as GoldenManifest;

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function uuidToBytes(uuid: string): Uint8Array {
  return fromHex(uuid.replace(/-/g, ""));
}

/** `@forestrie/mcp-verify`'s `src/node/fixtures.ts` `goldenGrant()`,
 *  reproduced: owner and target are the same log, flag byte 3 is 0x03 and
 *  byte 7 is 0x01, heights are zero, `grantData` is the manifest's 64
 *  bytes. */
export function goldenGrant(): Grant {
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
 *  idtimestamp. */
export function goldenCommittedGrant(): Uint8Array {
  return encodeGrantPayloadV0Canonical(goldenGrant());
}

export function goldenEntryId(): string {
  return `${GOLDEN_MANIFEST.idtimestampBe8Hex}0000000000000001`;
}

export const RECEIPT = () => readFixture("golden/grant-receipt.cbor");

/**
 * The MMR index of the node an inclusion path of `pathLength` siblings
 * reaches from `leafMmrIndex` — the peak the receipt's path proves. Mirrors
 * `inclusionWalkEndIndex` in @forestrie/receipt-verify (not exported), which
 * mirrors merklelog's `calculateRoot` position arithmetic.
 */
function inclusionWalkEnd(leafMmrIndex: bigint, pathLength: number): bigint {
  let h = indexHeight(leafMmrIndex);
  let pos = leafMmrIndex + 1n;
  for (let i = 0; i < pathLength; i++) {
    pos += indexHeight(pos) > h ? 1n : 2n << BigInt(h);
    h += 1;
  }
  return pos - 1n;
}

/** A SYNTHETIC known-accumulator snapshot binding (chainId 84532n — Base
 *  Sepolia, matching the rest of this package's fixtures; 20 zero bytes
 *  for univocity; the golden manifest's log id as bytes32 via
 *  `toContractLogId`; blockNumber 1n; 32 zero bytes for blockHash) around
 *  whatever peak the test derives — not a real chain read.
 *
 *  The accumulator is a VALID MMR shape: receipt-verify ≥3.2.0 binds a
 *  matched peak's position, so the snapshot's size is the node the
 *  receipt's inclusion walk reaches plus one (that node is always a peak of
 *  that size), `peak` sits at its position, and every other position holds
 *  a distinct dummy value. */
export function knownAccumulatorSnapshot(
  peak: Uint8Array,
  receipt: Uint8Array,
) {
  const { proof } = parseReceipt(receipt);
  const leafMmrIndex = proof.mmrIndex ?? proof.leafIndex ?? 0n;
  const node = inclusionWalkEnd(leafMmrIndex, proof.path.length);
  const size = node + 1n;
  const accumulator = peakMMRIndexes(size - 1n).map((i) =>
    i === node ? peak : new Uint8Array(32).fill(Number(i % 251n) + 1),
  );
  return encodeKnownAccumulator({
    version: 1,
    chainId: 84532n,
    univocity: new Uint8Array(20),
    logId: fromHex(toContractLogId(GOLDEN_MANIFEST.logId)),
    size,
    accumulator,
    blockNumber: 1n,
    blockHash: new Uint8Array(32),
  });
}
