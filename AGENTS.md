# AGENTS.md — conventions for this repo

Read this before changing anything. Most of it is not style; it is the set of
invariants that make the package's claims checkable, and each one is enforced
by something that will go red.

This repo is the courier: it fetches receipts, genesis documents and
accumulator snapshots for `@forestrie/mcp-verify` to verify. It has no
verification arithmetic of its own: the composed tool runs the verifier's
published core and passes its answers through unaltered. See plan-2609-05
(`devdocs/plans/plan-2609-05-mcp-verify-online/`, orchestrator-side) for the
decisions (`N1`–`N9`) this file implements.

## The layer boundary

This is the most important thing in the repo. Three layers, not two, because
the thing this package exists to do — fetch — is the thing a pure verifier
core forbids.

|              | `src/core/`                                                                                                                           | `src/net/`                                                                                                                             | `src/node/`                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| What it is   | Pure over bytes: URL construction, response classification, provenance/supports labelling, compose logic over already-fetched bytes.  | The ONLY place `fetch` is called: thin functions over `@forestrie/scrapi-client` and the local chain reader (see below).               | The adapter: MCP SDK, stdio, filesystem.        |
| Exported as  | `"."`                                                                                                                                 | `"./net"`                                                                                                                              | `"./server"`                                    |
| **Must not** | import `node:*`, call `fetch`, read a file, touch the MCP SDK, or take a path or a base64 string as a parameter                       | call `fetch` without going through a `fetchImpl` parameter                                                                             | leak back into `src/core` or `src/net`          |
| May          | take and return `Uint8Array`                                                                                                          | take and return `Uint8Array`; every function takes `fetchImpl` defaulting to `globalThis.fetch`                                        | do anything Node can                            |
| Enforced by  | `pnpm run check:browser-safe` — esbuild bundles `src/core/index.ts` for `platform: "browser"` and fails on any edge to a node builtin | the unit test project's forbidden-fetch global (below); no automated proof that every call site injects `fetchImpl` — reviewed by hand | the same browser-safe gate, from the other side |

Every core signature takes `Uint8Array`, never a path and never a base64
string. That is what makes the browser-safe gate satisfiable at all. Base64
decoding and `{path}` resolution live in `src/node/`, which together with
`src/net/` is the **only** place `node:fs` and `fetch` appear.

## The six gates (N6)

All CI-blocking, checked before every merge:

1. **`check:browser-safe`** — esbuild bundles `src/core/index.ts` for
   `platform: "browser"` and fails on any `node:*` edge.
2. **No fetch in core, no un-injected fetch in net** — the vitest `unit`
   project replaces `globalThis.fetch` with a thrower for the whole run
   (`test/setup/forbid-fetch.ts`); `src/net` is tested only through injected
   fakes. Any real fetch in a unit test is a red test, not a slow one.
3. **`check:encoding-single-copy`** — exactly one copy each of every
   `@forestrie/*` wire package this repo pins (`encoding`, `scrapi-client`,
   `receipt-verify`, `chain-rpc`, `mcp-verify`) in the tree, run on the repo
   and on a scratch `npm i` of the packed tarball.
4. **`check:reverse-dependency`** (F5, plan-2609-06 3.1) — `@forestrie/mcp-verify`
   must never depend back on `@forestrie/mcp-resolve`: walks the repo's own
   `node_modules/@forestrie/mcp-verify` for a nested `@forestrie/mcp-resolve`,
   and separately does a scratch `npm i @forestrie/mcp-verify@<pin>` and
   checks that tree too (`npm ls @forestrie/mcp-resolve` plus the same
   filesystem walk) — npm's flat resolver is what an `npm i`/`npx` user of
   mcp-verify actually gets, not pnpm's isolated store. Fails closed (never
   silently passes) if the scratch install itself cannot run, e.g. offline.
5. **`check:stdio-clean`** — the real bin writes exactly one `initialize`
   response to stdout and nothing else.
6. **`check:server-json`** — `server.json` validates with ajv against the
   registry schema vendored at `tools/registry-schema/2025-12-11.json` (the
   exact `$schema` `server.json` names, fetched once and committed so the
   check is hermetic) and matches `package.json#mcpName` and `#version`
   (plan-2609-06 F6 — closes the v0.1.1 gap where npm published a
   server.json the registry then rejected).
7. **Recorded-exchange fixtures, frozen** (phase 2 onward) — live lane
   responses are captured once by a runner into `test/fixtures/lane-a/` with
   a `PROVENANCE.md` and a sha256 manifest; unit tests replay them. The
   `live` vitest project (`vitest --project live`) is opt-in by
   `FORESTRIE_LIVE=1` and never a required check — see N8 (quota) and the
   comment in `vitest.config.ts`.

## All relative imports end in `.js`

`tsconfig.json` uses `moduleResolution: "bundler"` for typechecking, but
`tsconfig.build.json` overrides it to `NodeNext` for emit. That is deliberate:
`bundler` resolution lets you write extensionless relative imports that Node's
ESM loader then rejects at runtime — a failure that only appears _after
publish_. Under `NodeNext`, `pnpm build` fails instead.

So: `import { x } from "./thing.js"`, always, even from a `.ts` file.

## Dependencies are exact, and bumped deliberately

`@forestrie/*` and the MCP SDK are pinned to exact versions (N4). There is no
Renovate and no Dependabot in this estate, so exact pins are a manual-bump
discipline, not accidental staleness.

**Never add `pnpm.overrides` for any `@forestrie/*` wire package** —
`@forestrie/encoding`, `@forestrie/scrapi-client`,
`@forestrie/receipt-verify`, `@forestrie/chain-rpc` or
`@forestrie/mcp-verify`. An override would _silence_ the exact skew
`scripts/check-encoding-single-copy.mjs` exists to detect, by rewriting a
transitive dependency to a version its parent was never tested against. Two
copies of a wire-type package means two disagreeing implementations of the
same bytes.

Today every pin is naturally satisfiable — `mcp-verify` 0.4.1 depends on
`receipt-verify` 1.1.0 exactly, matching this package's own direct pin, and
`receipt-verify` 1.1.0 in turn depends on `chain-rpc` 0.3.0 and `encoding`
0.7.0 exactly, also matching this package's own pins; `scrapi-client` 0.2.2
depends on `encoding` 0.7.0 exactly too — so there is exactly one copy of
each without any coercion. This was not always true: `mcp-verify` 0.4.0
pinned `receipt-verify` 1.0.0 (which pinned `chain-rpc` 0.2.0), a second
copy of each this package did not control, until `mcp-verify` 0.4.1
re-pinned to `receipt-verify` 1.1.0 (plan-2609-06 F7). If a future
dependency drags in a second copy again, fix or drop that dependency, or
wait for its bump — never an override.

**`@forestrie/chain-rpc` (plan-2609-06 F7).** No longer absent: its 0.3.0
`EthRpcOptions` gained `fetchImpl?: typeof fetch` (default
`globalThis.fetch`), closing the injection gap plan-2609-05 N4 amendment B
noted (`EthRpcOptions` used to be `{ timeoutMs?: number }` only, with
`ethRpc` calling the global `fetch` directly). `src/net/chain.ts` now makes
its three JSON-RPC calls (`eth_chainId`, `eth_getBlockByNumber`, `eth_call`)
through `ethRpc`, always passing an explicit `fetchImpl` wrapped in
`http.ts`'s `withNetErrors` (gate 2's timeout/`NetError` guarantee is drawn
there now, not inside `ethRpc`, which enforces no timeout of its own against
a signal-ignoring `fetchImpl`); `history.ts`'s `eth_getLogs` scan shares the
same `callJsonRpc`, unchanged. Before bumping `chain-rpc` again, re-check
that `EthRpcOptions.fetchImpl` is still honoured by every call this package
uses.

When you bump a version, update `src/core/version.ts` in the same commit.
`test/core/version.test.ts` asserts every `*_VERSION` constant equals the
matching exact pin in `package.json#dependencies`, and the MCP smoke test
asserts `PACKAGE_VERSION === package.json#version`, so a forgotten bump is a
red test rather than a silent lie.

**`@forestrie/mcp-verify` is a dependency, never a sibling.** This package
imports only its `"."` export (`verifyReceipt`, `verifyGrantReceipt`,
`decodeReceipt`, `summarize`, result types, `VERIFIER`) — never `./server`.
No step in this repo, or in plan-2609-05, edits `forestrie/mcp-verify`; a
missing export is a finding for the orchestrator to file against the
verifier, and this repo waits for the bump.

## Nothing writes to stdout in stdio mode except the transport

A stray `console.log` in `src/node/**` does not produce a warning. It produces
a malformed JSON-RPC frame and an MCP client that mysteriously fails to
initialise. All logging goes to **stderr**.

`pnpm run check:stdio-clean` spawns the real bin and asserts stdout carries
exactly one well-formed `initialize` response and nothing else. The in-memory
smoke test cannot catch this; only a real process can.

Related: `main()` returns an exit code and does **not** call `process.exit`.
A hard exit truncates whatever the transport had buffered.

## The honesty rule

Every tool result (phase 2 onward) carries `provenance` and `supports` in
the four-questions vocabulary. `provenance` says where every fetched or
chain-read artefact came from and when. `supports` says which of the four
trust questions (`split-view`, `sealing`, `append-authority`, `attribution`
— the verifier's `QuestionName` vocabulary and the public spec's) the
fetched material can serve as evidence for, and under which trust root. The
composed `verify_fetched_receipt` tool's `questions` pass through the
verifier's own answers **unaltered** — this package adds a row about where
the bytes came from and never edits the verifier's answers.

The vocabulary is trust roots and the four questions, never a ranking or a
ladder: what changes with provenance is which questions the material can
support, not how much it is worth. The exact wording of `supports` notes,
`instructions` strings and `server.json`'s description is orchestrator
prose (plan-2609-05 execution-model.md item 12) — implement the rows as
tests and code; do not rephrase them.

## Tests

```
pnpm test              # check:browser-safe && check:encoding-single-copy && check:reverse-dependency && check:server-json && unit
pnpm test:unit          # vitest --project unit
pnpm test:live          # vitest --project live (opt-in, FORESTRIE_LIVE=1, never required — N8)
pnpm typecheck
pnpm format:check
pnpm build
```

The `unit` project runs under a global forbidden `fetch` that throws
(`test/setup/forbid-fetch.ts`). A stack trace ending there is telling you
that `src/core` reached the network, or that a `src/net` test used the real
`globalThis.fetch` default instead of injecting a fake through `fetchImpl`.

All three purity gates are chained into `test` and are release gates, not
advisory.

## Releasing

The whole policy for one package: merge a version-bump PR, then
`git tag v<version> && git push --tags`. `scripts/assert-publish-version.sh`
makes a mistyped tag fail closed, and CI self-tests both its pass and fail
paths on every PR.

1. Bump `version` in `package.json` **and** `PACKAGE_VERSION` in
   `src/core/version.ts` in the same PR. The MCP smoke test asserts they
   agree, so a forgotten bump is a red test rather than a lie in `initialize`.
2. Bump `version` (and `packages[0].version`) in `server.json` to match, in
   the same PR. `scripts/assert-server-json.mjs` — chained into `pnpm test`
   — fails closed if `server.json` and `package.json` disagree on version,
   or if `server.json#name` no longer matches `package.json#mcpName`.
3. Merge to `main`.
4. `git tag v<version> && git push --tags`.
5. `.github/workflows/publish.yml` asserts the tag matches `package.json`,
   runs the full gate, builds, packs, and publishes to npm via OIDC trusted
   publishing with provenance, then lists `dev.forestrie/resolve` with the
   official MCP registry the same way the verifier's `publish.yml` does. It
   has no self-registration step (plan-2609-05 N2: this package registers
   nothing) — the verifier's release registers its own provenance, this
   one does not.

**The first publish was by hand**, exactly as it was for the verifier:
npm's trusted-publisher registration cannot be created for a package that
does not exist yet. `@forestrie/mcp-resolve@0.1.0` was published unattested
on 2026-09-13 (`npm publish --provenance=false`), and the trusted publisher
(GitHub Actions, org `forestrie`, repo `mcp-resolve`, workflow
`publish.yml`, environment `npm-publish`, publish permission — not
stage-only, see the verifier's AGENTS.md for why that distinction matters)
was registered immediately after. Consequence: `publish.yml`'s first
attested release is `0.1.1`, not `0.1.0`.

The MCP registry listing needs the same owner-side DNS and secret setup the
verifier's does: the apex TXT record on `forestrie.dev` (already in place
for `dev.forestrie/verify` and authorising every name under
`dev.forestrie/*`, so no new DNS work for this package) and
`MCP_PUBLISHER_DNS_PRIVATE_KEY` in the `npm-publish` GitHub environment.

## Links must resolve without org access

This repo is public from the first commit and its pitch is that its claims
are checkable. Every link in the README, in `--help` text, and in
`server.json`, must resolve for someone with no GitHub org membership.

That means **no links into** `forestrie/devdocs`, `forestrie/forestrie-agents`,
`forestrie/thinker`, or `forestrie/product`. Where an internal document is the
source, inline what is needed and cite it by name, not by URL.
`forestrie-cli`, `canopy` and `forestrie/mcp-verify` are public and may be
linked.
