# @forestrie/mcp-resolve

An MCP server that fetches the material
[`@forestrie/mcp-verify`](https://www.npmjs.com/package/@forestrie/mcp-verify)
verifies: a receipt, a genesis document, an accumulator snapshot, a
registration status, a service configuration. Every result says where its
bytes came from and which of the four questions of the trust model they can
support. Listed in the MCP registry as `dev.forestrie/resolve`.

The verifier runs entirely in your process with no network, no account,
no key and no backend, and its own rule is that installing it can never imply a
network dependency. So anything that fetches lives here.

## Use

```json
{
  "mcpServers": {
    "forestrie-resolve": {
      "command": "npx",
      "args": ["-y", "@forestrie/mcp-resolve"],
      "env": {
        "FORESTRIE_BASE_URL": "https://api-a.forest-2.forestrie.dev",
        "FORESTRIE_RPC_URL": "https://<your-chain-rpc-endpoint>"
      }
    }
  }
}
```

Both environment variables are optional and both are yours. `baseUrl` is
any SCRAPI base URL and `rpcUrl` is your own chain access; a call may pass
either explicitly, and the environment values are used only when a call
omits them. The package ships no default operator and no default chain
provider, and names none.

Two public lanes exist and are examples, not defaults:

| Lane | Base URL                               | Service id      |
| ---- | -------------------------------------- | --------------- |
| A    | `https://api-a.forest-2.forestrie.dev` | `canopy-dev-1`  |
| B    | `https://api-b.forest-2.forestrie.dev` | `canopy-prod-1` |

Requires Node 20.11 or later.

## A worked example: one receipt, end to end

Every value below is public, and the ones that change per release come
from the verifier's own tarball. `@forestrie/mcp-verify` registers each
release in a Forestrie log and ships the receipt under `fixtures/self/`
(`docs/self-registration.md` there), so the published package is a
statement, a receipt, a genesis document and a log owner key that this
package can fetch and verify against the live lane. The run below takes
about four seconds and ends in `split-view ok` from a public RPC
endpoint, with no key and no account.

| Coordinate       | Value                                                                           | Where it comes from                                              |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| base URL         | `https://api-a.forest-2.forestrie.dev`                                          | lane A above (an example, not a default)                         |
| bootstrap log    | `e22c8d55-3f88-b2b5-f225-5d2c2441bcdd`                                          | the forest root; also decoded from the genesis document          |
| publications log | `da6f297c-4a0c-4c9a-b2ae-e701e558721d`                                          | the log the verifier registers releases on                       |
| content hash     | `sha256(fixtures/self/statement.cose)`                                          | the tarball; `fixtures/self/manifest.json` lists the same digest |
| entry id         | `fixtures/self/entry-id.txt`                                                    | the tarball; `query_registration` returns it too                 |
| massif height    | never typed                                                                     | inside the `receiptUrl` that `query_registration` returns        |
| log owner key    | `fixtures/self/log-key.xy.b64` (base64 text)                                    | the tarball                                                      |
| chain            | id 84532 (Base Sepolia), univocity `0xe22c8d553f88b2b5f2255d2c2441bcdd0d50cd58` | bound in the genesis document; `fetch_genesis` decodes it        |

To have the tarball at hand in an empty directory:

```
npm i @forestrie/mcp-verify
ls node_modules/@forestrie/mcp-verify/fixtures/self/
shasum -a 256 node_modules/@forestrie/mcp-verify/fixtures/self/statement.cose
```

The sequence, with the arguments as JSON and the one-line result each
call returned when run on 2026-09-22 against the published 0.5.0 bundle
(its entry id is `a0caa672b7030b000000000000000001`; yours is whatever
`entry-id.txt` says):

1. `fetch_scitt_configuration {"baseUrl": "https://api-a.forest-2.forestrie.dev"}`
   → `fetched SCITT configuration (serviceId canopy-dev-1) from …/.well-known/scitt-configuration`
2. `query_registration {"baseUrl": …, "bootstrapLogId": "e22c8d55-3f88-b2b5-f225-5d2c2441bcdd", "logId": "da6f297c-4a0c-4c9a-b2ae-e701e558721d", "contentHash": "<sha256 of statement.cose>"}`
   → `registration complete; receipt at https://api-a.forest-2.forestrie.dev/logs/e22c8d55-…/da6f297c-…/14/entries/a0caa672b7030b000000000000000001/receipt`
   — `status: "receipt-available"`, the `receiptUrl` (with the massif
   height, 14, inside it) and `entryId`.
3. `fetch_receipt {"receiptUrl": "<from step 2>"}`
   → `fetched receipt (438 B) from …/receipt` — `receipt.sha256` equals
   the digest of the tarball's `receipt.cbor`; `receiptLogId` names the
   publications log.
4. `fetch_genesis {"baseUrl": …, "logId": "e22c8d55-3f88-b2b5-f225-5d2c2441bcdd"}`
   → `fetched genesis (160 B) from …/api/forest/e22c8d55-…/genesis: univocity 0xe22c8d553f88b2b5f2255d2c2441bcdd0d50cd58 on chain 84532`
   — byte-identical to the tarball's `genesis.cbor`. Keep it: the calls
   below pass it back as bytes, never fetched in the same call.
5. `verify_fetched_receipt {"receiptUrl": …, "entryId": "<entry-id.txt>", "payload": {"path": "…/fixtures/self/statement.cose"}, "trust": {"root": "known-log-key", "keyXy": {"b64": "<contents of log-key.xy.b64>"}}}`
   → `verify: PASS · root=known-log-key · sealing ok, split-view not answered at this root, append-authority not answered at this root, attribution ok`
6. The same call with `"trust": {"root": "genesis", "genesis": {"path": "…/fixtures/self/genesis.cbor"}}`
   → `verify: FAILED at signature (delegation_invalid) · root=genesis · …`
   **This is expected**, not tampering: the genesis root's offline walk
   resolves one delegation hop from the forest root, and the publications
   log is a grandchild. The result carries
   `genesis_root_reaches_direct_delegates_only` saying exactly that.
   Verify this receipt under a key or an accumulator, as in 5 and 7.
7. `verify_fetched_receipt {"receiptUrl": …, "entryId": …, "payload": …, "trust": {"root": "known-accumulator", "chain": {"genesis": {"path": "…/fixtures/self/genesis.cbor"}, "rpcUrl": "https://sepolia.base.org", "logId": "da6f297c-4a0c-4c9a-b2ae-e701e558721d"}}}`
   → `verify: PASS · root=known-accumulator · sealing ok, split-view ok, append-authority not answered at this root, attribution ok`
   — `anchor.blockNumber`, `anchor.matchedPeak` and
   `provenance.root.from.rpcUrl` say which chain state answered. If the
   log has grown past the receipt's peak since, the same call looks back
   through published checkpoints and adds `root_read_from_chain_history`.
8. Optional: `fetch_accumulator {"chain": {…as in 7…}, "forReceipt": {"receipt": …, "payload": …, "entryId": …}}`
   returns the snapshot as bytes to keep; later, `@forestrie/mcp-verify`'s
   `verify_receipt` under `{"root": "known-accumulator", "accumulator":
<those bytes>}` answers split-view again, offline.

**The chain, and where to read it.** Step 7 needs JSON-RPC access to
chain 84532 (Base Sepolia). This package ships no provider and names
none as a default; `rpcUrl` (or `FORESTRIE_RPC_URL`) is yours. The
endpoints below are third-party public services, listed only as examples
of what answered unauthenticated when this example was written; use your
own provider for anything beyond a first try.

| Endpoint                                     | On 2026-09-22 |
| -------------------------------------------- | ------------- |
| `https://sepolia.base.org`                   | answered      |
| `https://base-sepolia-rpc.publicnode.com`    | answered      |
| `https://base-sepolia.drpc.org`              | answered      |
| `https://base-sepolia.gateway.tenderly.co`   | answered      |
| `https://1rpc.io/base-sepolia`               | HTTP 400      |
| `https://rpc.ankr.com/base_sepolia`          | HTTP 403      |
| `https://base-sepolia.g.alchemy.com/v2/demo` | HTTP 429      |

**Two traps.** `keyXy: {"path": "log-key.xy.b64"}` fails: that file is
base64 _text_, and `path` inputs are read as raw bytes — pass its
contents as `b64`. And the byte-field name is `b64` in both servers
(`base64` is accepted here as an alias), so the shapes you learn from the
verifier work here unchanged.

`test/core/readme-example.test.ts` asserts the coordinates in this
section against the recorded lane-A fixtures, so a fixture re-capture
cannot silently invalidate the example.

## The seven tools

| Tool                        | Provenance                           | What it does                                                                        | Supports                                    |
| --------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| `fetch_scitt_configuration` | fetched                              | `GET {baseUrl}/.well-known/scitt-configuration`                                     | none                                        |
| `query_registration`        | fetched                              | one registration-status request for a statement; never polls                        | none                                        |
| `fetch_receipt`             | fetched                              | fetches a receipt, decodes it, and reports the log its certificate names            | none on its own                             |
| `fetch_genesis`             | fetched                              | fetches the forest's genesis document, with its chain binding and bootstrap key     | `sealing`, only for a copy you keep         |
| `fetch_accumulator`         | chain-read                           | reads the log's published accumulator; looks back through history for a buried peak | `split-view`, `sealing`, `append-authority` |
| `fetch_checkpoint_history`  | chain-read                           | reads published checkpoints back, newest first, within your block budget            | as `fetch_accumulator`                      |
| `verify_fetched_receipt`    | fetched, plus supplied or chain-read | fetches a receipt and verifies it under a root you supply or read from the chain    | the verifier's own answers, unaltered       |

Every tool is annotated read-only, idempotent and open-world, because every
one of them talks to something outside your process. What each `supports`
entry means, and why, is in
[docs/what-fetching-proves.md](docs/what-fetching-proves.md).

## What a fetched thing proves

A receipt fetched from the operator is the operator's claim until it is
verified under a trust root you hold. The public trust model,
[`spec/receipt-trust-model.md`](https://github.com/forestrie/protocol/blob/main/spec/receipt-trust-model.md)
in `forestrie/protocol`, names four questions a receipt can answer
(sealing, split-view, append-authority, attribution) and four trust roots a
caller can verify under (`genesis`, `known-log-key`, `known-accumulator`,
`checkpoint-chain`). The roots are not ordered. Which one is right depends
on what you hold, and fetching changes what you hold.

That is why every result here carries `provenance` (for each artefact:
fetched from a URL, read from a chain, or supplied by you, and when) and
`supports` (which questions the material can serve as evidence for, under
which root, with a one-line note). The notes are fixed strings the tests
assert verbatim; they are listed and explained in
[docs/what-fetching-proves.md](docs/what-fetching-proves.md).

Three consequences are built into the tool surface rather than left to
documentation:

- **A fetched genesis is never a root.** `verify_fetched_receipt` takes its
  root as bytes you supply or as an accumulator read from the chain; its
  schema has no form that fetches a genesis and verifies under it in the
  same call. A genesis obtained from the operator at check time makes the
  operator the supplier of both the receipt and the root, which proves
  consistency with a document the operator chose to serve today and
  nothing more. `fetch_genesis` exists so you can obtain the document once,
  keep it, and pass it as bytes from then on.
- **The chain binding is the forest's, never the operator's.** The
  univocity contract address and chain id are bound in a forest's genesis
  document. `fetch_accumulator` and the chain path of
  `verify_fetched_receipt` take them from a genesis you hold, or
  explicitly, never from a default, never from a genesis fetched inside the
  call, and never from an environment variable.
- **Buried peaks are answered from published history, under the same
  root.** When later growth has folded a receipt's peak into a bigger one,
  the chain path looks back through published checkpoints, within the block
  budget you set, and says so (`root_read_from_chain_history`). It never
  scans without a bound.

The verifier's own [`TRANSPARENCY.md`](https://github.com/forestrie/mcp-verify/blob/main/TRANSPARENCY.md)
(shipped in its tarball) explains what a transparency log is and what a
receipt contains; this package does not repeat it. Its
[`docs/trust-roots.md`](https://github.com/forestrie/mcp-verify/blob/main/docs/trust-roots.md)
explains the roots in depth.

## What this package never does

- Never writes: no registration, no grants, no keys.
- Never polls: `query_registration` is one request, and you decide whether
  to call it again. An HTTP 429 comes back as a structured `problem` with
  `retryAfterMs`, not as an error.
- Never chooses an operator or a chain provider for you.
- Never caches a fetched genesis or accumulator across calls: every result
  carries a fresh `at`.
- Never edits the verifier's answers. `verify_fetched_receipt` returns the
  verifier's `stages`, `questions` and `diagnostics` unaltered and appends
  two diagnostics of its own that say where the bytes came from.
  `not_answered_by_this_root` is a real answer and reaches you unchanged.

## Layout and gates

```
src/core/   pure over bytes: URL construction, response classification,
            provenance and supports labelling, the compose logic.
            No node:*, no fetch, no fs. Exported as ".".
src/net/    the ONLY place fetch is called; every function takes fetchImpl.
            Exported as "./net".
src/node/   the MCP adapter: SDK, stdio, {path}/base64 inputs, env defaults.
            Exported as "./server".
```

CI blocks on the purity and packaging gates described in
[AGENTS.md](AGENTS.md). Unit tests run under a `fetch` that throws and replay
exchanges recorded under `test/fixtures/`. A live project against a real lane
exists, is opt-in, and is never a required check.

```
pnpm test        # purity gates + unit tests
pnpm typecheck
pnpm build
pnpm test:live   # FORESTRIE_LIVE=1 plus FORESTRIE_BASE_URL, FORESTRIE_RPC_URL, UNIVOCITY_ADDRESS, CHAIN_ID and GENESIS_CBOR_B64
```

Conventions, invariants and the release path are in [AGENTS.md](AGENTS.md).

## Dependencies

Exact pins in `package.json`, bumped deliberately. Of
`@forestrie/mcp-verify`, only the `"."` core export is used. Every request,
the chain reads included, goes through an injected `fetchImpl`.

## License

MIT.
