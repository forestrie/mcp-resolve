# CheckpointPublished history — plan-2609-06 step 1.2

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

TBD by the orchestrator (real or SYNTHESISED).

## RPC URL

The RPC URL is the owner-supplied one for the task (Doppler `cicd-forestrie-log/dev` `RPC_URL`); never recorded here, never in the package. These bytes are FROZEN (execution-model item 10).
