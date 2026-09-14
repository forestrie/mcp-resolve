/**
 * `grantLeafInputs` (plan-2609-06 phase 1 amendment, 2026-09-14), cross-
 * checked against the verifier's own `verifyGrantReceipt` over the SAME
 * bundled golden fixtures `test/core/compose.test.ts` and
 * `@forestrie/mcp-verify`'s `src/node/demo.ts` use. `src/node/fixtures.ts`
 * is not part of the verifier's published exports (only `"."` and
 * `"./server"` are), so the small amount of fixture-rebuilding it does is
 * reproduced in `test/core/grant-fixture.ts` rather than imported — same
 * reproduction as `test/core/compose.test.ts`, not imported from there
 * either.
 *
 * The COSE-branch describe blocks below read
 * `test/fixtures/synthetic/grant-cose/grant.cose` — the verifier's frozen
 * FOR-289 conformance grant (same grant `grant-fixture.ts` rebuilds),
 * wrapped as a Forestrie-Grant COSE Sign1 and signed with a PUBLISHED
 * TEST-ONLY key. See that directory's PROVENANCE.md for why it exists and
 * what is fabricated.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeCoseSign1,
  encodeCoseSign1Raw,
  verifyCoseSign1,
} from "@forestrie/encoding";
import {
  recomputeReceiptPeak,
  verifyGrantReceipt,
  type TrustRoot,
} from "@forestrie/mcp-verify";
import { GrantLeafInputError, grantLeafInputs } from "../../src/core/index.js";
import {
  GOLDEN_MANIFEST,
  RECEIPT,
  fromHex,
  goldenCommittedGrant,
  goldenEntryId,
  knownAccumulatorSnapshot,
} from "./grant-fixture.js";
import { generate } from "../fixtures/synthetic/grant-cose/generate.mjs";

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

  // The COSE-Sign1 branch is exercised separately below, against
  // `test/fixtures/synthetic/grant-cose/grant.cose` — the same grant as
  // above, wrapped as a Forestrie-Grant COSE Sign1.
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

/**
 * Forestrie-Grant COSE Sign1 unprotected header labels
 * (`@forestrie/receipt-verify` 1.0.0 `dist/forest-genesis-labels.js`,
 * confirmed NOT re-exported from that package's `"."` index — only the
 * `.d.ts` source file declares them). Defined locally, matching
 * `test/fixtures/synthetic/grant-cose/generate.mjs`'s own copy with the
 * same citation.
 */
const HEADER_IDTIMESTAMP = -65537;
const HEADER_FORESTRIE_GRANT_V0 = -65538;

const GRANT_COSE_DIR = new URL(
  "../fixtures/synthetic/grant-cose/",
  import.meta.url,
).pathname;

function readGrantCoseFixture(): Uint8Array {
  return new Uint8Array(readFileSync(`${GRANT_COSE_DIR}grant.cose`));
}

type TestKeyJwk = JsonWebKey & { warning: string };

function readTestKeyJwk(): TestKeyJwk {
  return JSON.parse(
    readFileSync(`${GRANT_COSE_DIR}test-key.json`, "utf8"),
  ) as TestKeyJwk;
}

async function importTestPublicKey(jwk: TestKeyJwk): Promise<CryptoKey> {
  const { warning: _warning, d: _d, ...pub } = jwk;
  return crypto.subtle.importKey(
    "jwk",
    { ...pub, key_ops: ["verify"] },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
}

describe("grantLeafInputs — COSE branch (synthetic, honestly-signed fixture)", () => {
  it("the committed grant.cose signature verifies under the committed test key", async () => {
    const coseBytes = readGrantCoseFixture();
    const jwk = readTestKeyJwk();
    expect(jwk.warning).toMatch(/TEST ONLY/);
    const publicKey = await importTestPublicKey(jwk);
    const ok = await verifyCoseSign1(coseBytes, publicKey);
    expect(ok).toBe(true);
  });

  it("without entryId, derives idtimestampBe8 from the embedded header and the same inner as the raw grant", async () => {
    const cose = readGrantCoseFixture();
    const fromCose = await grantLeafInputs(cose);
    expect(fromCose.idtimestampBe8).toEqual(
      fromHex(GOLDEN_MANIFEST.idtimestampBe8Hex),
    );

    const fromRaw = await grantLeafInputs(
      goldenCommittedGrant(),
      goldenEntryId(),
    );
    expect(fromCose.inner).toEqual(fromRaw.inner);
  });

  it("with an entryId whose idtimestamp differs, the entryId wins (mirrors the verifier)", async () => {
    const cose = readGrantCoseFixture();
    const differentEntryId = "03030303030303030000000000000001";
    const { idtimestampBe8 } = await grantLeafInputs(cose, differentEntryId);
    expect(idtimestampBe8).toEqual(fromHex("0303030303030303"));
    expect(idtimestampBe8).not.toEqual(
      fromHex(GOLDEN_MANIFEST.idtimestampBe8Hex),
    );
  });

  it("cross-check against the verifier: verifyGrantReceipt passes with committedGrant: grantCose and no entryId, fails when the peak is tampered", async () => {
    const receipt = RECEIPT();
    const committedGrant = readGrantCoseFixture();

    const { idtimestampBe8, inner } = await grantLeafInputs(committedGrant);
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
      trust: tamperedTrust,
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("peak_not_in_known_accumulator");
  });

  it("a copy with one byte of the embedded grant changed is refused by both the COSE decoder and the raw fallback (undecodable)", async () => {
    const coseBytes = readGrantCoseFixture();
    const decoded = decodeCoseSign1(coseBytes);
    if (!decoded) throw new Error("test setup: grant.cose failed to decode");
    const unprotected = decoded.unprotected as Map<number, unknown>;
    const embedded = unprotected.get(HEADER_FORESTRIE_GRANT_V0);
    if (!(embedded instanceof Uint8Array)) {
      throw new Error("test setup: embedded grant CBOR missing");
    }
    const tamperedEmbedded = new Uint8Array(embedded);
    const lastIndex = tamperedEmbedded.length - 1;
    tamperedEmbedded[lastIndex] = (tamperedEmbedded[lastIndex] ?? 0) ^ 0xff;

    const tamperedUnprotected = new Map(unprotected);
    tamperedUnprotected.set(HEADER_FORESTRIE_GRANT_V0, tamperedEmbedded);
    // The digest in the payload no longer matches the (tampered) embedded
    // grant, so decodeForestrieGrantCose rejects it; the tampered bytes
    // are not a valid raw grant payload either, so the fallback also
    // rejects it — both fail, mirroring GrantLeafInputError's contract.
    const tampered = encodeCoseSign1Raw(
      decoded.protectedBstr,
      tamperedUnprotected,
      decoded.payloadBstr,
      decoded.signature,
    );

    let caught: unknown;
    try {
      await grantLeafInputs(tampered);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GrantLeafInputError);
    expect((caught as GrantLeafInputError).kind).toBe("undecodable");
  });

  it("drift: regenerating into a temp dir with the committed test key reproduces the protected header, unprotected header and payload, and the regenerated signature verifies", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "mcp-resolve-grant-cose-"));
    try {
      const committedKeyBytes = readFileSync(`${GRANT_COSE_DIR}test-key.json`);
      writeFileSync(path.join(tmp, "test-key.json"), committedKeyBytes);

      const regenerated = await generate(tmp);

      const committedCose = readGrantCoseFixture();
      const committedDecoded = decodeCoseSign1(committedCose);
      if (!committedDecoded) {
        throw new Error("test setup: committed grant.cose failed to decode");
      }
      const regeneratedDecoded = decodeCoseSign1(regenerated.coseBytes);
      if (!regeneratedDecoded) {
        throw new Error("regenerated grant.cose failed to decode");
      }

      expect(Buffer.from(regeneratedDecoded.protectedBstr)).toEqual(
        Buffer.from(committedDecoded.protectedBstr),
      );
      expect(Buffer.from(regeneratedDecoded.payloadBstr)).toEqual(
        Buffer.from(committedDecoded.payloadBstr),
      );
      const committedUnprotected = committedDecoded.unprotected as Map<
        number,
        unknown
      >;
      const regeneratedUnprotected = regeneratedDecoded.unprotected as Map<
        number,
        unknown
      >;
      for (const label of [HEADER_FORESTRIE_GRANT_V0, HEADER_IDTIMESTAMP]) {
        const committedValue = committedUnprotected.get(label);
        const regeneratedValue = regeneratedUnprotected.get(label);
        expect(committedValue).toBeInstanceOf(Uint8Array);
        expect(regeneratedValue).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(regeneratedValue as Uint8Array)).toEqual(
          Buffer.from(committedValue as Uint8Array),
        );
      }

      // Signature bytes are NOT compared — ES256 signing is randomized, so
      // a fresh regeneration signs different signature bytes over the same
      // Sig_structure. Instead, the regenerated signature must itself
      // verify under the same (committed, reused) test key.
      const jwk = readTestKeyJwk();
      const publicKey = await importTestPublicKey(jwk);
      const ok = await verifyCoseSign1(regenerated.coseBytes, publicKey);
      expect(ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
