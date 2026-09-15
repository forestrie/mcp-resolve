#!/usr/bin/env node
/**
 * The grant-leaf COSE branch fixture.
 *
 * Wraps the verifier's frozen conformance grant (see
 * `node_modules/@forestrie/mcp-verify/fixtures/golden/manifest.json`) as a
 * Forestrie-Grant COSE Sign1 (Custodian transparent statement profile,
 * `@forestrie/receipt-verify`'s `decodeForestrieGrantCose`), signed with a
 * PUBLISHED TEST-ONLY ES256 key. The grant inside is byte-identical to the
 * frozen fixture — only the COSE wrapper and signature are fabricated. See
 * this directory's PROVENANCE.md.
 *
 * `decodeForestrieGrantCose` does NOT verify the signature; this generator
 * still signs honestly (ECDSA/P-256 via WebCrypto) so the fixture is not a
 * garbage signature, and `test/core/grant-leaf.test.ts` checks it verifies.
 *
 * Deterministic in every byte except the signature: ES256 (ECDSA) signing
 * is randomized (a fresh nonce per signature per RFC 6979 is NOT used here
 * — WebCrypto's ECDSA is randomized, not deterministic), so re-running this
 * script reproduces `grant.cose`'s protected header, unprotected header and
 * payload exactly, but not its signature bytes. `test/core/grant-leaf.test.ts`
 * asserts that (drift test): structural equality plus "the regenerated
 * signature verifies", never a byte-for-byte signature comparison.
 *
 * Imports only `@forestrie/encoding` (a direct dependency) and `node:*` —
 * no new dependency, and dependency-free of this package's own `src/`.
 *
 * Usage: `node generate.mjs [outDir]` (defaults to this file's own
 * directory, the committed location). If `outDir` already has a
 * `test-key.json`, it is read and reused (so the drift test re-signs with
 * the SAME committed test key rather than minting a new one); otherwise a
 * fresh ES256 key pair is generated and written there.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COSE_ALG_ES256,
  encodeCborDeterministic,
  encodeCoseSign1Raw,
  encodeGrantPayloadV0Canonical,
  encodeSigStructure,
} from "@forestrie/encoding";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The verifier's frozen conformance grant fixture manifest —
 *  `@forestrie/mcp-verify` 0.4.0, not part of its published exports, so
 *  read directly the same way `test/core/grant-leaf.test.ts` does. */
const GOLDEN_MANIFEST_PATH = path.join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  "@forestrie",
  "mcp-verify",
  "fixtures",
  "golden",
  "manifest.json",
);

/**
 * Forestrie-Grant COSE Sign1 unprotected header labels
 * (`@forestrie/receipt-verify` 1.0.0
 * `dist/forest-genesis-labels.js` — NOT re-exported from the package
 * index; `test/core/grant-leaf.test.ts` defines the same pair locally with
 * the same citation).
 */
const HEADER_IDTIMESTAMP = -65537;
const HEADER_FORESTRIE_GRANT_V0 = -65538;

function fromHex(hex) {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function uuidToBytes(uuid) {
  return fromHex(uuid.replace(/-/g, ""));
}

/** `@forestrie/mcp-verify`'s `src/node/fixtures.ts` `goldenGrant()`,
 *  reproduced in plain JS (duplicated from `test/core/grant-leaf.test.ts`'s
 *  own TS copy, because this generator cannot import TS): owner and target
 *  are the same log, flag byte 3 is 0x03 and byte 7 is 0x01, heights are
 *  zero, `grantData` is the manifest's 64 bytes. */
function goldenGrant(manifest) {
  const owner = uuidToBytes(manifest.logId);
  const flags = new Uint8Array(8);
  flags[3] = 0x03;
  flags[7] = 0x01;
  return {
    logId: owner,
    ownerLogId: owner,
    grant: flags,
    maxHeight: 0,
    minGrowth: 0,
    grantData: fromHex(manifest.grantDataHex),
  };
}

const TEST_KEY_WARNING =
  "TEST ONLY. This private key is published in a public repository to " +
  "sign a synthetic test fixture. It must never be trusted, registered, " +
  "or used to sign anything else.";

/** Read `test-key.json` from `outDir` if present, else generate a fresh
 *  ES256 (P-256) key pair and write it there. Either way returns both the
 *  JWK (as committed, `warning` field included) and the imported signing
 *  `CryptoKey`. */
async function loadOrCreateKey(outDir) {
  const keyPath = path.join(outDir, "test-key.json");
  if (existsSync(keyPath)) {
    const jwk = JSON.parse(readFileSync(keyPath, "utf8"));
    const { warning: _warning, ...jwkForImport } = jwk;
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      jwkForImport,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    return { jwk, privateKey };
  }
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  void publicKey; // coordinates ride in the private JWK's x/y — no separate export needed
  const exported = await crypto.subtle.exportKey("jwk", privateKey);
  const jwk = { ...exported, warning: TEST_KEY_WARNING };
  writeFileSync(keyPath, `${JSON.stringify(jwk, null, 2)}\n`);
  return { jwk, privateKey };
}

export async function generate(outDir) {
  mkdirSync(outDir, { recursive: true });

  const manifest = JSON.parse(readFileSync(GOLDEN_MANIFEST_PATH, "utf8"));
  const rawGrantBytes = encodeGrantPayloadV0Canonical(goldenGrant(manifest));
  const idtimestampBe8 = fromHex(manifest.idtimestampBe8Hex);

  const { jwk, privateKey } = await loadOrCreateKey(outDir);

  const digestBuffer = await crypto.subtle.digest("SHA-256", rawGrantBytes);
  const digest = new Uint8Array(digestBuffer);

  // Protected header: { 1 (alg): ES256 } — a canonical CBOR map with a
  // single integer key, via the package's own deterministic writer.
  const protectedMapBytes = encodeCborDeterministic(
    new Map([[1, COSE_ALG_ES256]]),
  );

  const unprotected = new Map([
    [HEADER_FORESTRIE_GRANT_V0, rawGrantBytes],
    [HEADER_IDTIMESTAMP, idtimestampBe8],
  ]);

  const sigStructureBytes = encodeSigStructure(
    protectedMapBytes,
    new Uint8Array(0),
    digest,
  );

  const signatureBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    sigStructureBytes,
  );
  const signature = new Uint8Array(signatureBuffer);

  const coseBytes = encodeCoseSign1Raw(
    protectedMapBytes,
    unprotected,
    digest,
    signature,
  );

  writeFileSync(path.join(outDir, "grant.cose"), coseBytes);

  const provenance = `# SYNTHESISED — grant-leaf COSE branch fixture

These bytes are FABRICATED, not a real Custodian-issued grant. Generated
by \`generate.mjs\` (deterministic except for the ECDSA signature — see
below).

## Why

\`grantLeafInputs\` (\`src/core/grant-leaf.ts\`) mirrors the verifier's
private grant decoder: try a Forestrie-Grant COSE Sign1 first, fall back
to a raw grant payload. The verifier's own frozen conformance
grant fixture is a raw grant payload, so \`test/core/grant-leaf.test.ts\`
had no fixture to exercise the COSE branch against. This directory
supplies one.

## What is real

The grant inside \`grant.cose\` is byte-identical to the verifier's frozen
conformance grant (\`@forestrie/mcp-verify\`'s
\`fixtures/golden/manifest.json\`, re-encoded here with
\`encodeGrantPayloadV0Canonical\` exactly as
\`test/core/grant-leaf.test.ts\`'s \`goldenCommittedGrant()\` does): same
\`logId\`/\`ownerLogId\`, same grant flags, same \`grantData\`, same
idtimestamp (\`0202020202020202\`).

## What is fabricated

Only the COSE Sign1 wrapper and its signature:

- \`test-key.json\` is a PUBLISHED TEST-ONLY ES256 (P-256) key pair, as a
  JWK. ${TEST_KEY_WARNING}
- \`grant.cose\` wraps the grant above as a Forestrie-Grant COSE Sign1
  (Custodian transparent statement profile,
  \`@forestrie/receipt-verify\`'s \`decodeForestrieGrantCose\`):
  - protected header \`{ alg: ES256 }\`;
  - unprotected header carries the raw grant CBOR at label \`-65538\`
    (\`HEADER_FORESTRIE_GRANT_V0\`) and the idtimestamp
    (\`0202020202020202\`) at label \`-65537\` (\`HEADER_IDTIMESTAMP\`);
  - payload is the 32-byte SHA-256 digest of the embedded grant bytes;
  - the signature is a genuine ES256 signature from \`test-key.json\` over
    the standard COSE Sig_structure — honestly signed, even though
    \`decodeForestrieGrantCose\` itself does not check it.

\`decodeForestrieGrantCose\` does not verify signatures, so this fixture
could have carried a garbage signature and still exercised the COSE
branch. It is signed honestly anyway so
\`test/core/grant-leaf.test.ts\` can also assert the signature verifies
under the committed public key, matching how a real Forestrie-Grant COSE
Sign1 would be produced.

## Regeneration

\`generate.mjs\` is committed. Re-running it against a directory that
already has \`test-key.json\` reuses that key (reads, does not overwrite)
and reproduces \`grant.cose\`'s protected header, unprotected header and
payload byte-for-byte. Its signature bytes will differ on every run — ES256
(ECDSA) signing is randomized, not deterministic — so the drift check
(\`test/core/grant-leaf.test.ts\`) compares those three fields and
verifies the regenerated signature, rather than comparing the file
byte-for-byte.
`;

  writeFileSync(path.join(outDir, "PROVENANCE.md"), provenance);

  const keyHash = toHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        readFileSync(path.join(outDir, "test-key.json")),
      ),
    ),
  );
  const coseHash = toHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        readFileSync(path.join(outDir, "grant.cose")),
      ),
    ),
  );
  const manifestOut = {
    generatedBy: "generate.mjs",
    files: {
      "test-key.json": keyHash,
      "grant.cose": coseHash,
    },
  };
  writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifestOut, null, 2)}\n`,
  );

  return {
    outDir,
    files: ["test-key.json", "grant.cose", "PROVENANCE.md", "manifest.json"],
    protectedMapBytes,
    unprotected,
    payload: digest,
    coseBytes,
    jwk,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const outDir = process.argv[2] ?? HERE;
  const result = await generate(outDir);
  console.error(`wrote ${result.files.length} files to ${result.outDir}`);
}
