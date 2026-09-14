# What fetching proves

`@forestrie/mcp-resolve` fetches; `@forestrie/mcp-verify` verifies. This
page says what a fetched thing is evidence for, in the vocabulary of the
public trust model,
[`forestrie/protocol` `spec/receipt-trust-model.md`](https://github.com/forestrie/protocol/blob/main/spec/receipt-trust-model.md):
**four questions** a receipt can answer (sealing, split-view,
append-authority, attribution) and **four trust roots** a caller can verify
under (`genesis`, `known-log-key`, `known-accumulator`, `checkpoint-chain`).
The roots are not ordered. Which one is right depends on what you hold, and
fetching changes what you hold. That is the whole reason this package labels
every result rather than returning bare bytes.

Every tool result carries two fields beside its payload:

- **`provenance`** — for each artefact, `{ source, from, at }`: `fetched`
  from a URL, `chain-read` at an RPC URL and contract, or `supplied` by you.
- **`supports`** — the questions this material can serve as evidence for,
  each with the trust root under which it does, and a one-line note. The
  notes below are the exact strings the package emits
  (`src/core/provenance.ts`, asserted verbatim by
  `test/core/supports-table.test.ts`).

## The table, in prose

### `fetch_receipt` — supports nothing on its own

> a receipt is the operator's claim; verify it under a root you hold

A receipt is a signed statement by the log operator that a leaf is in the
log. Fetched from the operator, it is that operator's claim and nothing
else until it is verified under a trust root the caller holds. The receipt
does not become evidence by being fetched; it becomes evidence when the
arithmetic relates its recomputed peak to something the caller trusts. The
tool returns the bytes and the verifier's decoding so an agent can read
what it fetched, and leaves the verifying to `verify_fetched_receipt` or to
the verifier directly.

### `fetch_genesis` — `sealing`, as `known-log-key`, and only with the copy kept

> keep this copy; a copy obtained at check time is not the genesis root as
> intended. The chain binding in this copy (contract address, chain id) is
> likewise the operator's claim today: a chain read under an address
> obtained at check time answers split-view against the contract the
> operator named, so keep the copy from registration, or cross-check the
> address against a source you trust independently

The genesis document binds a forest's bootstrap key and its chain binding
(the chain id and the univocity contract address). The `genesis` trust root
is meant to be used with a copy captured when you registered with the
forest, which is the known-hosts posture: trust on first use, then pinned.
The verifier's own [`docs/trust-roots.md`](https://github.com/forestrie/mcp-verify/blob/main/docs/trust-roots.md)
records why a copy fetched at check time is different: the operator is then
supplying both the receipt and the root it is checked under, so a pass
proves consistency with a document the operator chose to serve today. That
is `known-log-key` with the key fetched from the operator, which the
reference CLI says never to do.

This package therefore treats `fetch_genesis` as a capture tool. Obtain the
document once, keep it, and pass it as bytes from then on. The composed
tool's schema does not admit a fetched genesis as its root, by construction.

The same reasoning applies to the chain binding the document carries. A
chain read under a contract address you took from the operator at check
time answers split-view against the contract the operator named. Keep the
copy from registration, or cross-check the address against a source you
trust independently, before treating a chain read under it as the
`known-accumulator` root as intended.

### `fetch_accumulator` — `split-view`, `sealing`, `append-authority`, under `known-accumulator`

> split-view against the chain rather than the operator; sealing and
> append-authority by inheritance from the contract's publish-time checks,
> stated as inheritance, never as a local signature check

The accumulator is read from the univocity contract, not from the operator.
A receipt whose recomputed peak matches a published accumulator is in the
history the operator committed to publicly, which is what split-view asks.
The public spec says a state read from the chain inherits the contract's
sealing and authority checks: the contract refuses to publish a checkpoint
whose signature or consistency proof fails. So `sealing` and
`append-authority` are supported by inheritance from what the contract
checked at publish time. This package says so in those words and does not
claim a local signature check took place. The verifier's `known-accumulator`
root evaluates no signature at all, and its result says so in its
`signature` stage note; this package passes that through.

The contract address and chain id are the forest's, bound at genesis. The
tool takes them from a genesis you hold or from explicit arguments, never
from a default, never from the operator inside the call, and never from an
environment variable. The RPC URL is your own chain access; the package
ships no provider.

### `fetch_checkpoint_history` — the same questions as `fetch_accumulator`, for checkpoints you keep

> split-view against the chain rather than the operator; sealing and
> append-authority by inheritance from the contract's publish-time checks,
> stated as inheritance, never as a local signature check; a kept checkpoint
> answers split-view later, without another chain read, for any receipt
> whose peak it contains

The contract keeps only a log's latest state. Every publication, though,
was an event, `CheckpointPublished`, carrying the checkpoint's size and its
full accumulator, and events stay in the chain's history. This tool reads
them back: newest first, in windows of a size you set, one `eth_getLogs`
request per window, stopping at the block or the block count you gave it.
It never scans from the chain's first block.

Why anyone would want an old checkpoint: a receipt's inclusion proof leads
to one peak of the log as it stood when the receipt was issued. Later growth
folds peaks together, so the latest accumulator may no longer contain that
peak even though the entry is still in the log. The verifier reports that
as `peak_not_in_known_accumulator` and asks for a fresh snapshot; a
checkpoint published when the peak was still standing is that snapshot.
`verify_fetched_receipt`'s chain path and `fetch_accumulator` (given
`forReceipt`) do this look-back for you, within the bounds you set in
`history`, and say so with the diagnostic `root_read_from_chain_history`:

> the accumulator was selected from published checkpoint history in this
> call, at the caller's RPC URL

The trust root is the same, `known-accumulator`, and so are the questions
it supports and the reason it supports them: the checkpoint was read from
the chain, not from the operator, and the contract refused to publish it
unless its signature and consistency proof passed. What the event scan adds
is reach, not a different kind of evidence. The result reports how many
requests the reach cost, and running out of range is a structured problem,
`history_scan_exhausted`, that tells you where the scan started and
stopped, so you can decide whether to widen it.

Each checkpoint comes back both decoded and as a `known-accumulator`
snapshot you can keep and later pass to `verify_fetched_receipt` as
supplied bytes. That is the capture use, the same as `fetch_genesis`:
obtain once, keep, reuse. A kept checkpoint of size _S_ holds the peaks of
the log at _S_; it answers split-view for any receipt whose peak is among
them, and for no other, which is why the tool returns the history rather
than one state.

### `fetch_scitt_configuration` — supports none of the four questions

> operator self-description; evidence for none of the four questions

The well-known document says what the service calls itself and what it
supports. It is useful for discovery and for building URLs. It is evidence
for none of the four questions.

### `query_registration` — supports none of the four questions

> registration status; evidence for none of the four questions

A registration status says whether the operator has issued a receipt for a
statement yet, and where. It is a single request; the package never polls.
It is evidence for none of the four questions.

### `verify_fetched_receipt` — the verifier's own answers, unaltered

> the verifier's own questions object, passed through unaltered;
> diagnostics say where the bytes came from

The composed tool fetches a receipt and hands the bytes to the verifier's
pure core under a trust root the caller supplies as bytes, or under an
accumulator read from the chain in the same call. The result is the
verifier's result: `stages[]`, `questions`, `diagnostics[]`, `anchor`,
`verifier`. This package adds nothing to `questions` and removes nothing.
It appends two diagnostics of its own:

- `receipt_fetched_from_operator` — always: _the receipt bytes were fetched
  from the operator's API in this call_.
- `root_read_from_chain` — when the chain path was taken: _the accumulator
  was read from the chain in this call, at the caller's RPC URL_.

The text summary is the verifier's own summary line, prefixed with where
the bytes came from. `not_answered_by_this_root` is a real answer and
reaches the caller unchanged.

## Why the roots are not ranked here

A fetched receipt verified under a held genesis answers sealing and
attribution and not split-view. The same receipt verified under a chain-read
accumulator answers split-view and not, locally, the signature. Neither
result is more true than the other; they answer different questions, and
the caller chooses the root by what they hold. What provenance changes is
which questions the material can support, not how much it is worth. This
package's job is to keep that visible after the bytes have travelled.
