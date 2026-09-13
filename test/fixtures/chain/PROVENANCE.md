# chain fixtures — one `logState` read, frozen

Captured 2026-09-13 by the plan-2609-05 orchestrator for step 2.2. Three
JSON-RPC 2.0 calls, each made exactly once, to the RPC URL the owner supplied
for the task (Doppler `cicd-forestrie-log/dev` `RPC_URL`; never recorded
here, never in the package): `eth_chainId`, `eth_getBlockByNumber("latest",
false)`, then `eth_call { to: <univocity>, data: 0xeecac1b7 ‖ bytes32(logId) }`
at the block the second call returned. The request bodies and the responses
are verbatim in `logState.<block>.json`; the block response is trimmed to
`number`, `hash`, `parentHash`, `timestamp`.

| Field | Value |
|---|---|
| chain id (`eth_chainId`) | `84532` (Base Sepolia), equal to the chain id bound in lane A's genesis document (label `-68013`) |
| univocity contract | `0x678768643b4667aedcb313cc81624aa560b7f0ca`, equal to the address bound in lane A's genesis (label `-68011`) |
| log id | `e8345800-a747-4e62-9409-61622b836f1f`, the publications log the verifier's own release receipt was registered on (lane A's forest, bootstrap log `67876864-3b46-67ae-dcb3-13cc81624aa5`) |
| block | `46770471`, hash `0x713c531b734b5c1edb5c89e0182fdd6b52d0b9c80fd2bf0a395847b39091e170` |

The univocity address and chain id are the forest's, bound at genesis (N2
amendment A); they are public and appear here only as the captured `to`
field of the call. The chain binding was supplied explicitly for this
capture and cross-checked against the genesis document before the
`eth_call` (the script refuses to call if `eth_chainId` disagrees).

These bytes are FROZEN. Unit tests replay them through a fake `fetch` (N6
gate 2). A new snapshot is a new orchestrator capture step, never a worker
fetch (execution-model item 10). `manifest.json` carries the sha256.
