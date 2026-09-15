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
