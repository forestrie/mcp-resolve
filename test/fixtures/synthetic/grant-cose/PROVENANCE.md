# SYNTHESISED — plan-2609-06 grant-leaf COSE branch fixture

These bytes are FABRICATED, not a real Custodian-issued grant. Generated
by `generate.mjs` (deterministic except for the ECDSA signature — see
below).

## Why

`grantLeafInputs` (`src/core/grant-leaf.ts`) mirrors the verifier's
private grant decoder: try a Forestrie-Grant COSE Sign1 first, fall back
to a raw grant payload. The verifier's own frozen FOR-289 conformance
grant fixture is a raw grant payload, so `test/core/grant-leaf.test.ts`
had no fixture to exercise the COSE branch against. This directory
supplies one.

## What is real

The grant inside `grant.cose` is byte-identical to the verifier's frozen
FOR-289 conformance grant (`@forestrie/mcp-verify`'s
`fixtures/golden/manifest.json`, re-encoded here with
`encodeGrantPayloadV0Canonical` exactly as
`test/core/grant-leaf.test.ts`'s `goldenCommittedGrant()` does): same
`logId`/`ownerLogId`, same grant flags, same `grantData`, same
idtimestamp (`0202020202020202`).

## What is fabricated

Only the COSE Sign1 wrapper and its signature:

- `test-key.json` is a PUBLISHED TEST-ONLY ES256 (P-256) key pair, as a
  JWK. TEST ONLY. This private key is published in a public repository to sign a synthetic test fixture. It must never be trusted, registered, or used to sign anything else.
- `grant.cose` wraps the grant above as a Forestrie-Grant COSE Sign1
  (Custodian transparent statement profile,
  `@forestrie/receipt-verify`'s `decodeForestrieGrantCose`):
  - protected header `{ alg: ES256 }`;
  - unprotected header carries the raw grant CBOR at label `-65538`
    (`HEADER_FORESTRIE_GRANT_V0`) and the idtimestamp
    (`0202020202020202`) at label `-65537` (`HEADER_IDTIMESTAMP`);
  - payload is the 32-byte SHA-256 digest of the embedded grant bytes;
  - the signature is a genuine ES256 signature from `test-key.json` over
    the standard COSE Sig_structure — honestly signed, even though
    `decodeForestrieGrantCose` itself does not check it.

`decodeForestrieGrantCose` does not verify signatures, so this fixture
could have carried a garbage signature and still exercised the COSE
branch. It is signed honestly anyway so
`test/core/grant-leaf.test.ts` can also assert the signature verifies
under the committed public key, matching how a real Forestrie-Grant COSE
Sign1 would be produced.

## Regeneration

`generate.mjs` is committed. Re-running it against a directory that
already has `test-key.json` reuses that key (reads, does not overwrite)
and reproduces `grant.cose`'s protected header, unprotected header and
payload byte-for-byte. Its signature bytes will differ on every run — ES256
(ECDSA) signing is randomized, not deterministic — so the drift check
(`test/core/grant-leaf.test.ts`) compares those three fields and
verifies the regenerated signature, rather than comparing the file
byte-for-byte.
