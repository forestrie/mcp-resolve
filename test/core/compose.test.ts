/**
 * `verifyFetched` / `summarizeFetched` against the verifier's own
 * `verifyGrantReceipt`, over the SAME bundled golden fixtures
 * `@forestrie/mcp-verify`'s `src/node/demo.ts` uses (genesis root, and a
 * known-accumulator root derived from the receipt's own recomputed peak —
 * see that file's `deriveSnapshot`). `src/node/fixtures.ts` is not part of
 * the verifier's published exports (only `"."` and `"./server"` are), so
 * the small amount of fixture-rebuilding it does is reproduced here rather
 * than imported.
 */
import {
  encodeGrantPayloadV0Canonical,
  decodeGrantPayload,
  type Grant,
} from "@forestrie/encoding";
import {
  encodeKnownAccumulator,
  entryIdHexToIdtimestampBe8,
  grantCommitmentHashFromGrant,
} from "@forestrie/receipt-verify";
import {
  recomputeReceiptPeak,
  summarize,
  verifyGrantReceipt,
  type TrustRoot,
  type VerifyResult,
} from "@forestrie/mcp-verify";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  summarizeFetched,
  verifyFetched,
  type FetchedVerifyResult,
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

function goldenCommittedGrant(): Uint8Array {
  return encodeGrantPayloadV0Canonical(goldenGrant());
}

function goldenEntryId(): string {
  return `${GOLDEN_MANIFEST.idtimestampBe8Hex}0000000000000001`;
}

const GENESIS = () => readFixture("golden/grant-genesis.cbor");
const RECEIPT = () => readFixture("golden/grant-receipt.cbor");

/** `demo.ts`'s `deriveSnapshot`, reproduced exactly: a known-accumulator
 *  snapshot built from the clean receipt's own recomputed peak, so this
 *  test needs no network and no fixture beyond what ships. */
async function deriveSnapshot(): Promise<Uint8Array> {
  const { peak, leafIndex } = await recomputeReceiptPeak({
    receiptCbor: RECEIPT(),
    idtimestampBe8: entryIdHexToIdtimestampBe8(goldenEntryId()),
    inner: await grantCommitmentHashFromGrant(
      decodeGrantPayload(goldenCommittedGrant()),
    ),
  });
  return encodeKnownAccumulator({
    version: 1,
    chainId: 84532n,
    univocity: new Uint8Array(20).fill(0xab),
    logId: new Uint8Array(32).fill(0xcd),
    size: leafIndex + 1n,
    accumulator: [peak],
    blockNumber: 1_234_567n,
    blockHash: new Uint8Array(32).fill(0xef),
  });
}

function assertSameVerifierFields(
  fetched: FetchedVerifyResult,
  direct: VerifyResult,
): void {
  expect(fetched.questions).toEqual(direct.questions);
  expect(fetched.stages).toEqual(direct.stages);
  expect(fetched.ok).toBe(direct.ok);
  expect(fetched.root).toBe(direct.root);
  expect(fetched.stage).toBe(direct.stage);
  expect(fetched.reason).toBe(direct.reason);
  expect(fetched.anchor).toEqual(direct.anchor);
  expect(fetched.verifier).toEqual(direct.verifier);
}

describe("verifyFetched — genesis root, supplied", () => {
  it("passes the verifier's fields through unaltered and appends one diagnostic", async () => {
    const receipt = RECEIPT();
    const committedGrant = goldenCommittedGrant();
    const entryId = goldenEntryId();
    const trust: TrustRoot = { root: "genesis", genesis: GENESIS() };

    const direct = await verifyGrantReceipt({
      receipt,
      committedGrant,
      entryId,
      trust,
    });
    const fetched = await verifyFetched({
      kind: "grant",
      receipt,
      committedGrant,
      entryId,
      trust,
      rootProvenance: "supplied",
    });

    assertSameVerifierFields(fetched, direct);
    expect(fetched.diagnostics).toEqual([
      ...direct.diagnostics,
      {
        code: "receipt_fetched_from_operator",
        message:
          "the receipt bytes were fetched from the operator's API in this call",
      },
    ]);
    expect(fetched.courier).toEqual({
      package: "@forestrie/mcp-resolve",
      version: expect.any(String),
      verifier: "@forestrie/mcp-verify",
      verifierVersion: expect.any(String),
    });
  });
});

describe("verifyFetched — known-accumulator root, chain-read", () => {
  it("appends both courier diagnostics, in order", async () => {
    const receipt = RECEIPT();
    const committedGrant = goldenCommittedGrant();
    const entryId = goldenEntryId();
    const trust: TrustRoot = {
      root: "known-accumulator",
      accumulator: await deriveSnapshot(),
    };

    const direct = await verifyGrantReceipt({
      receipt,
      committedGrant,
      entryId,
      trust,
    });
    const fetched = await verifyFetched({
      kind: "grant",
      receipt,
      committedGrant,
      entryId,
      trust,
      rootProvenance: "chain-read",
    });

    assertSameVerifierFields(fetched, direct);
    expect(fetched.diagnostics).toEqual([
      ...direct.diagnostics,
      {
        code: "receipt_fetched_from_operator",
        message:
          "the receipt bytes were fetched from the operator's API in this call",
      },
      {
        code: "root_read_from_chain",
        message:
          "the accumulator was read from the chain in this call, at the caller's RPC URL",
      },
    ]);
  });

  it("summarizeFetched starts with the provenance line and ends with the verifier's summary", async () => {
    const receipt = RECEIPT();
    const committedGrant = goldenCommittedGrant();
    const entryId = goldenEntryId();
    const trust: TrustRoot = {
      root: "known-accumulator",
      accumulator: await deriveSnapshot(),
    };

    const direct = await verifyGrantReceipt({
      receipt,
      committedGrant,
      entryId,
      trust,
    });
    const fetched = await verifyFetched({
      kind: "grant",
      receipt,
      committedGrant,
      entryId,
      trust,
      rootProvenance: "chain-read",
    });

    const provenanceLine =
      "receipt: fetched from https://example.com/… at 2026-09-13T00:00:00.000Z";
    const text = summarizeFetched("verify-grant", fetched, provenanceLine);

    expect(text.startsWith(provenanceLine)).toBe(true);
    expect(text.endsWith(summarize("verify-grant", direct))).toBe(true);
  });
});
