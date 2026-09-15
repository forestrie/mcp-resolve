# CheckpointPublished history — frozen

Captured 2026-09-13 (UTC 2026-09-13T22:29:37.551Z).

| Field | Value |
|---|---|
| Chain ID | 84532 |
| Univocity address | 0x678768643B4667aEDcB313cC81624aA560b7f0Ca |
| Publications log ID | e8345800-a747-4e62-9409-61622b836f1f |
| Latest block | 46785144, hash 0xa87e46f4d01526fd0f67ee1cf120734b8047875dbc8496f02220130c9bb1684b |
| Deploy block | 46732186 |
| Checkpoint topic0 | 0x156942b408823cb05a16027962ea485fa7171d99779ee04094280b2569482426 |
| eth_call result hex length | 450 |

## Requests

Total: 11 JSON-RPC 2.0 calls, each made exactly once.

1. `eth_chainId` → 0x14a34 (verified against 0x14a34)
2. `eth_getBlockByNumber(["latest", false])` → block 46785144, hash 0xa87e46f4d01526fd0f67ee1cf120734b8047875dbc8496f02220130c9bb1684b
3. `eth_call { to: 0x678768643B4667aEDcB313cC81624aA560b7f0Ca, data: 0xeecac1b7‖bytes32(e8345800-a747-4e62-9409-61622b836f1f) }` at block 46785144
4. `eth_getTransactionReceipt(0x349a60482b1503325b906001ecb6a422a9acfe436f81afc9425b1cf1345af718)` → block 46732186
5. `eth_getLogs` windows [deploy=46732186, latest=46785144], newest-first with 10000-block windows:
  - [46775145, 46785144]: 0 logs
  - [46765145, 46775144]: 0 logs
  - [46755145, 46765144]: 3 logs
  - [46745145, 46755144]: 0 logs
  - [46735145, 46745144]: 1 logs
  - [46732186, 46735144]: 2 logs
6. `eth_getLogs` all `CheckpointPublished` in [46775145, 46785144]:
   - 0 logs
   - Distinct log IDs (topics[1]):


## Buried-peak status

**No real buried peak on this log at capture** (2026-09-13). The latest
`logState` at block 46785144 decodes as size 11 with 3 peaks and equals the
newest `CheckpointPublished` (block 46764680, size 11); the log had not grown
since the earlier `logState` capture at block 46770471. The six checkpoints found are,
oldest first (block, size, peaks): 46734813 / 1 / 1; 46734839 / 3 / 1;
46736245 / 4 / 2; 46764135 / 8 / 2; 46764156 / 10 / 2; 46764680 / 11 / 3.
The verifier's own receipt (mmr index 8) leads to the peak at mmr index 9,
present in the size-10 and size-11 checkpoints and in the latest state, so
against these bytes split-view answers `ok` from the latest state alone.
The live log grew past a fold on 2026-09-14; these bytes still record the
state at capture.

The buried-peak test fixture is therefore SYNTHESISED, in
`test/fixtures/synthetic/history/`, by a committed generator that takes these
frozen events and adds one fabricated later checkpoint of size 15 (a single
peak that is not `0xa032e477…`) as the "latest" state, so the receipt's peak
is absent from the latest and present in a real earlier checkpoint. Its own
`PROVENANCE.md` says which bytes are real and which are made up. The real
history here is also used as-is: the scan over it finds the peak in the
size-11 checkpoint, and the live gate runs against the real chain.

## RPC URL

The RPC URL was supplied by the maintainer; it is never recorded here or in the package. These bytes are FROZEN.
