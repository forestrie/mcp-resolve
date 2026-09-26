# lane-a fixtures — five recorded exchanges, frozen

Captured 2026-09-13. Each URL was
requested exactly once with `curl` (no redirect following); the raw response
headers are in `<name>.headers.txt`, the body (where there was one) in the
body file named below, and `<name>.meta.json` holds the URL, method, time,
status, headers as an object, body sha256 and byte count. Lane A
(`https://api-a.forest-2.forestrie.dev`, service id `canopy-dev-1`) is an
example lane, not a default. The publications log
`e8345800-a747-4e62-9409-61622b836f1f` under the forest bootstrap log
`67876864-3b46-67ae-dcb3-13cc81624aa5` is where `@forestrie/mcp-verify`
0.4.0 registered its own release provenance.

| Name | URL | Date header | Status | Content-Type | Body | sha256 |
|---|---|---|---|---|---|---|
| well-known | `/.well-known/scitt-configuration` | 2026-09-13T14:22:38Z | 200 | `application/json` | `well-known.json` (552 B) | `10ad04ae5bc8bbac551fe871987d7f80bc22a4fcb9ce4fe18256eef1dfed08a8` |
| genesis | `/api/forest/67876864-3b46-67ae-dcb3-13cc81624aa5/genesis` | 2026-09-13T14:22:52Z | 200 | `application/cbor` | `genesis.cbor` (160 B) | `c6183184d805bf23652a265d7f533101eec5c97e1939dd90c7f142e6d502da68` |
| status-self | `/logs/67876864-…/e8345800-…/entries/7c29bb57bae35044f722f4842c91a38b6fae51a5405a95caf9b27c9b894e2166` | 2026-09-13T14:22:52Z | 303 | — (empty) | none | — |
| receipt-self | `/logs/67876864-…/e8345800-…/14/entries/a09a6337ee0009000000000000000008/receipt` | 2026-09-13T14:23:08Z | 200 | `application/scitt-receipt+cbor` | `receipt-self.cbor` (438 B) | `55e7edf2a65c39681cb01fc1d6b5b6bf9273b82bd741954be63c8d6f2ef85fbe` |
| status-unknown | `/logs/67876864-…/e8345800-…/entries/0000…0000` (64 zero hex) | 2026-09-13T14:23:08Z | 303 | — (empty) | none | — |
| receipt-404 | `/logs/67876864-…/e8345800-…/13/entries/a09a6337ee0009000000000000000008/receipt` (massif height 13, one below the real 14) | 2026-09-19T11:50:27Z | 404 | `application/cbor` | `receipt-404.cbor` (80 B) | `4170be41d9c901a05cf9d0d70e858f34744b755bb080c489d526aaae6863f567` |

(`67876864-…` = `67876864-3b46-67ae-dcb3-13cc81624aa5`; `e8345800-…` =
`e8345800-a747-4e62-9409-61622b836f1f`.)

## What the exchanges show

- **status-self.** The content hash is the hex sha256 of the verifier's
  signed statement bytes (`fixtures/self/statement.cose` in a scratch
  `npm i @forestrie/mcp-verify@0.4.0`; `manifest.json` there lists the same
  hash). The lane answered 303 with `Location` = the receipt URL at massif
  height 14 for entry `a09a6337ee0009000000000000000008`, which is exactly
  the installed verifier's `fixtures/self/entry-id.txt`.
- **receipt-self.** The receipt for that entry. Its bytes are NOT identical
  to the installed verifier's `fixtures/self/receipt.cbor`
  (`b34af78730992b3ffa82734687b0575313a9db8e9a4703f1ca92bc3701c5f419`):
  `cmp -l` shows exactly the last 64 bytes differ, offsets 375–438, which is
  the COSE Sign1 signature. Protected header, `kid`, the inclusion proof
  (mmr index 8, one path element), and the delegation certificate are
  byte-identical; the operator signs afresh when serving a receipt (ECDSA is
  randomised). Both copies verify identically with the installed verifier's
  `verifyReceipt` under `known-log-key` with `fixtures/self/log-key.xy.b64`,
  `statement.cose` as payload and the entry id: PASS, sealing ok, attribution
  ok, split-view and append-authority not answered by that root. So the
  live tests assert structural identity plus identical verification, not
  byte identity. The content type is `application/scitt-receipt+cbor`.
- **status-unknown.** For a content hash that was never registered the lane
  does NOT answer a problem-details 404: it answers 303 with `Location`
  pointing back at the same status URL and `retry-after: 1`, i.e. the same
  shape as "pending". `src/core/classify.ts` maps a 303 whose `Location` is
  not a receipt URL to `pending`, so this fixture is the `pending` case;
  there is no captured 404 on this route. A 429 cannot be captured on demand
  either; `../synthetic/` holds one synthesised from the 2026-09-12
  `error code: 1027` body shape, marked as such.
- **genesis.** 160 bytes, the same bytes as the installed verifier's
  `fixtures/self/genesis.cbor` and its `test/fixtures/self-bundle/genesis.cbor`.
  The chain binding it carries (label `-68011` contract address, `-68013`
  chain id) is the forest's; see `../chain/PROVENANCE.md`.
- **well-known.** `serviceId: canopy-dev-1`, `scrapiVersion:
  draft-ietf-scitt-scrapi-05`, `baseUrl` = the lane.

No `ratelimit-*` headers were present; every response carried `cf-ray`. No
request returned 429.

`statement.cose` and `log-key.xy.b64` are copied byte-for-byte from the
published `@forestrie/mcp-verify` 0.4.0 tarball's `fixtures/self/`, the
release self-registration of which `receipt-self.cbor` is a served copy.
Tests read them from here, never from the installed mcp-verify, whose
`fixtures/self/` is regenerated at every release.

These files are FROZEN. `manifest.json` carries the sha256 of every file here
except itself. A new capture replaces them in a commit of its own; tests never
fetch.

## receipt-404 — captured 2026-09-19 (plan-2609-08 phase 3)

A sixth exchange, recorded the same way six days after the first five:
the receipt route with the massif height one below the real one. The lane
answered **404** with an 80-byte CBOR problem document
(`{type: "about:blank", title: "Entry receipt not found (checkpoint
missing)", status: 404}`) served as `application/cbor` — not the
`application/problem+cbor` canopy's own API doc specifies, and with the
operator's message in `title` and no `detail`. It is the exchange
`test/core/classify.test.ts` and `test/node/tools.test.ts` replay to
assert that a receipt-route 404 is reported as `not_found` carrying that
title, never as `pending` (the registration route's 303 is the only
pending signal), and that a CBOR problem body is decoded whatever CBOR
media type it arrives under. Cloudflare's `report-to` / `nel` headers are
in `receipt-404.headers.txt` as received; `receipt-404.meta.json` carries
the parsed header set.
