#!/usr/bin/env node
/**
 * The SYNTHESISED buried-peak fixture.
 *
 * The real history in
 * `test/fixtures/chain/history/e8345800-a747-4e62-9409-61622b836f1f/` was
 * captured before lane A's publications log grew past a fold, so its latest
 * state still holds the verifier's own receipt's peak (mmr index 9). This
 * generator fabricates a "latest" state one checkpoint newer than that
 * history, at a size that does NOT hold the peak, so the buried-peak
 * fallback has something real to walk back through.
 *
 * Deterministic and dependency-free (Node's `node:crypto` only). Every
 * fabricated value is derived from a fixed ASCII string via SHA-256, never
 * a random number, so re-running this script reproduces the committed
 * bytes exactly — `test/core/synthetic-history-fixture.test.ts` asserts
 * that (drift is red). The six real checkpoints this reads are FROZEN
 * and are never modified by this script.
 *
 * Usage: `node generate.mjs [outDir]` (defaults to this file's own
 * directory, the committed location).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_DIR = path.join(
  HERE,
  "..",
  "..",
  "chain",
  "history",
  "e8345800-a747-4e62-9409-61622b836f1f",
);

const LOG_ID = "e8345800-a747-4e62-9409-61622b836f1f";
const UNIVOCITY = "0x678768643B4667aEDcB313cC81624aA560b7f0Ca";
const CHAIN_ID = "84532";

// The real, frozen size-11 checkpoint (block 46764680) this fabricates a
// successor of. Its own peak (mmr index 9's fold) is what the synthetic
// state must NOT hold.
const REAL_LATEST_BLOCK = 46785144;
const SYNTHETIC_BLOCK_NUMBER = REAL_LATEST_BLOCK + 10_000; // 46795144

function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** A deterministic, distinct hash for each fabricated block number. */
function blockHashFor(blockNumber) {
  return `0x${sha256Hex(`plan-2609-06 synthetic block ${blockNumber}`)}`;
}

function wordHex(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function wordAt(hex, index) {
  return hex.slice(index * 64, (index + 1) * 64);
}

/** Re-encode a `CheckpointPublished` event's data with a different `size`
 *  and a different (shorter) `accumulator`, keeping `sender`,
 *  `grantIDTimestampBe`, `logKind`, `grantIndex` and the (empty)
 *  `grantPath` from a real event byte-for-byte, and recomputing the
 *  `grantPath` offset for the new accumulator length — never overwriting
 *  words in place, which would leave a stale offset that fails to decode. */
function reencodeCheckpointData(realDataHex, size, accumulatorHex) {
  const hex = realDataHex.startsWith("0x")
    ? realDataHex.slice(2)
    : realDataHex;
  const sender = wordAt(hex, 0);
  const grantIdTimestampBe = wordAt(hex, 1);
  const logKind = wordAt(hex, 2);
  const grantIndex = wordAt(hex, 5);
  const realGrantPathOffsetBytes = Number(BigInt(`0x${wordAt(hex, 6)}`));
  const grantPathLenWord = wordAt(hex, realGrantPathOffsetBytes / 32);

  const HEAD_WORDS = 7; // words 0..6, fixed regardless of array length
  const headBytes = HEAD_WORDS * 32;
  const accumulatorTailWords = 1 + accumulatorHex.length; // length word + peaks
  const grantPathOffsetBytes = headBytes + accumulatorTailWords * 32;

  const words = [
    sender,
    grantIdTimestampBe,
    logKind,
    wordHex(size),
    wordHex(headBytes), // accumulator offset: fixed, head size unchanged
    grantIndex,
    wordHex(grantPathOffsetBytes), // grantPath offset: recomputed
    wordHex(accumulatorHex.length),
    ...accumulatorHex,
    grantPathLenWord,
  ];
  return `0x${words.join("")}`;
}

/** Re-encode an `eth_call` `logState(bytes32)` result with a different
 *  size and accumulator, same tuple-offset layout as the real capture
 *  (`decodeLogStateResult`'s contract). */
function reencodeLogStateResult(size, accumulatorHex) {
  const words = [
    wordHex(32), // outer tuple offset
    wordHex(64), // accumulator offset, relative to tuple base
    wordHex(size),
    wordHex(accumulatorHex.length),
    ...accumulatorHex,
  ];
  return `0x${words.join("")}`;
}

export function generate(outDir) {
  mkdirSync(outDir, { recursive: true });

  const realLogState = JSON.parse(
    readFileSync(path.join(REAL_DIR, "logState.46785144.json"), "utf8"),
  );
  const realGetLogs = JSON.parse(
    readFileSync(
      path.join(REAL_DIR, "getLogs.46755145-46765144.json"),
      "utf8",
    ),
  );
  // The real size-11 checkpoint, block 46764680 — the newest real one,
  // whose peak the synthetic size-15 state must not hold.
  const realSize11Log = realGetLogs.response.result[2];

  const syntheticPeak = sha256Hex("plan-2609-06 synthetic peak");
  const syntheticLatestBlockHash = blockHashFor(SYNTHETIC_BLOCK_NUMBER);
  const syntheticTxHash = `0x${sha256Hex("plan-2609-06 synthetic tx")}`;

  const SYNTHETIC_SIZE = 15;

  /* ---- logState.46795144.json: same shape as the real logState file ---- */

  const logStateEthCallResult = reencodeLogStateResult(SYNTHETIC_SIZE, [
    syntheticPeak,
  ]);

  const logState = {
    capturedAt: realLogState.capturedAt,
    note:
      "SYNTHESISED — buried-peak fixture. Not a " +
      "real chain read: fabricated by test/fixtures/synthetic/history/generate.mjs " +
      "from the frozen real checkpoints in " +
      "test/fixtures/chain/history/e8345800-a747-4e62-9409-61622b836f1f/. " +
      "See this directory's PROVENANCE.md.",
    logId: LOG_ID,
    univocity: UNIVOCITY,
    chainId: CHAIN_ID,
    calls: {
      eth_chainId: realLogState.calls.eth_chainId,
      eth_getBlockByNumber: {
        request: {
          jsonrpc: "2.0",
          id: 2,
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        },
        status: 200,
        response: {
          jsonrpc: "2.0",
          result: {
            number: `0x${SYNTHETIC_BLOCK_NUMBER.toString(16)}`,
            hash: syntheticLatestBlockHash,
          },
          id: 2,
        },
      },
      eth_call: {
        request: {
          jsonrpc: "2.0",
          id: 3,
          method: "eth_call",
          params: [
            {
              // Lowercase, matching the older lane-A capture
              // (test/fixtures/chain/logState.46770471.json) and every
              // test's own `UNIVOCITY` constant — the address's letter
              // case is calldata-routing convenience for this fabricated
              // "latest" read, not part of the real, frozen checkpoint
              // data being fabricated a successor of.
              to: UNIVOCITY.toLowerCase(),
              data: realLogState.calls.eth_call.request.params[0].data,
            },
            `0x${SYNTHETIC_BLOCK_NUMBER.toString(16)}`,
          ],
        },
        status: 200,
        response: {
          jsonrpc: "2.0",
          result: logStateEthCallResult,
          id: 3,
        },
      },
    },
    blockNumber: String(SYNTHETIC_BLOCK_NUMBER),
    blockHash: syntheticLatestBlockHash,
  };

  writeFileSync(
    path.join(outDir, "logState.46795144.json"),
    `${JSON.stringify(logState, null, 2)}\n`,
  );

  /* ---- getLogs.46785145-46795144.json: one fabricated checkpoint ---- */

  const syntheticData = reencodeCheckpointData(realSize11Log.data, SYNTHETIC_SIZE, [
    syntheticPeak,
  ]);
  const FABRICATED_BLOCK_NUMBER = REAL_LATEST_BLOCK + 4_856; // 46790000
  const fabricatedBlockNumberHex = `0x${FABRICATED_BLOCK_NUMBER.toString(16)}`;
  const fabricatedBlockHash = blockHashFor(FABRICATED_BLOCK_NUMBER);

  const syntheticLog = {
    address: realSize11Log.address,
    blockHash: fabricatedBlockHash,
    blockNumber: fabricatedBlockNumberHex,
    blockTimestamp: realSize11Log.blockTimestamp,
    data: syntheticData,
    logIndex: "0x0",
    removed: false,
    topics: realSize11Log.topics,
    transactionHash: syntheticTxHash,
    transactionIndex: "0x0",
  };

  const windowFrom = REAL_LATEST_BLOCK + 1; // 46785145
  const windowTo = SYNTHETIC_BLOCK_NUMBER; // 46795144
  const getLogs = {
    request: {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [
        {
          address: UNIVOCITY,
          topics: realSize11Log.topics.slice(0, 2),
          fromBlock: `0x${windowFrom.toString(16)}`,
          toBlock: `0x${windowTo.toString(16)}`,
        },
      ],
    },
    status: 200,
    response: {
      jsonrpc: "2.0",
      result: [syntheticLog],
      id: 1,
    },
  };

  writeFileSync(
    path.join(outDir, `getLogs.${windowFrom}-${windowTo}.json`),
    `${JSON.stringify(getLogs, null, 2)}\n`,
  );

  /* ---- PROVENANCE.md ---- */

  const provenance = `# SYNTHESISED — buried-peak fixture

These bytes are FABRICATED, not a chain capture. Generated by
\`generate.mjs\` (deterministic, no external input) from the real, frozen
checkpoints in
\`test/fixtures/chain/history/e8345800-a747-4e62-9409-61622b836f1f/\`.

## Why

When the real history was captured (2026-09-13), lane A's publications log
had not grown past a fold: the verifier's own receipt (mmr index 8) leads to
the peak at mmr index 9, which is present in the real size-10 and size-11
checkpoints and in the real latest state (see the real directory's
PROVENANCE.md, "Buried-peak status"). This fixture fabricates one fold
further: a "latest" state whose accumulator does NOT hold that peak, so the
buried-peak fallback has a real gap to walk back through in tests, whatever
the live log does.

## What is real

The six checkpoints \`historyWindows\` walks back through before reaching
the fabricated window are the real, frozen fixture directory's events,
unmodified:

| Block | Size | Peaks |
|---|---|---|
| 46734813 | 1 | 1 |
| 46734839 | 3 | 1 |
| 46736245 | 4 | 2 |
| 46764135 | 8 | 2 |
| 46764156 | 10 | 2 |
| 46764680 | 11 | 3 |

## What is fabricated

| Field | Value | Derivation |
|---|---|---|
| Synthetic latest block | ${SYNTHETIC_BLOCK_NUMBER} | real latest (${REAL_LATEST_BLOCK}) + 10 000 |
| Synthetic latest size | ${SYNTHETIC_SIZE} | one fold past the real size-11 state |
| Synthetic peak | 0x${syntheticPeak} | sha256("plan-2609-06 synthetic peak") |
| Synthetic latest block hash | ${syntheticLatestBlockHash} | sha256("plan-2609-06 synthetic block ${SYNTHETIC_BLOCK_NUMBER}") |
| Fabricated checkpoint block | ${fabricatedBlockNumberHex} (${FABRICATED_BLOCK_NUMBER}) | real latest + 4 856, inside the first scan window |
| Fabricated checkpoint block hash | ${fabricatedBlockHash} | sha256("plan-2609-06 synthetic block ${FABRICATED_BLOCK_NUMBER}") |
| Fabricated checkpoint tx hash | ${syntheticTxHash} | sha256("plan-2609-06 synthetic tx") |
| Fabricated checkpoint log index | 0x0 | fixed |

\`logState.46795144.json\` mirrors the real \`logState.46785144.json\`'s
shape exactly, with the synthetic values above. Its single
\`CheckpointPublished\` event, in \`getLogs.46785145-46795144.json\`, reuses
the real size-11 event's \`topics\` (same log, same grant log, same root
key) and \`sender\`/\`grantIDTimestampBe\`/\`logKind\`/\`grantIndex\`/\`grantPath\`
words verbatim, re-encoding only \`size\` and \`accumulator\` — and the
\`grantPath\` offset that shift moves — so the event still decodes
correctly (\`test/core/history.test.ts\` and
\`test/core/synthetic-history-fixture.test.ts\` both exercise this).

## Windows from the synthetic latest

Backward from ${SYNTHETIC_BLOCK_NUMBER} in 10 000-block chunks:

1. [${windowFrom}, ${windowTo}] — synthetic, 1 checkpoint (this fixture's fabricated one, not accepted: peak not held)
2. [46775145, 46785144] — real, 0 checkpoints
3. [46765145, 46775144] — real, 0 checkpoints
4. [46755145, 46765144] — real, 3 checkpoints (sizes 8, 10, 11 — size 11 accepted: it holds the receipt's peak)

Four \`eth_getLogs\` requests total before the buried-peak scan stops.

## Regeneration

\`generate.mjs\` is committed and deterministic: re-running it reproduces
these files byte-for-byte (asserted by
\`test/core/synthetic-history-fixture.test.ts\`). It never modifies the
real, frozen fixture directory it reads from.
`;

  writeFileSync(path.join(outDir, "PROVENANCE.md"), provenance);

  /* ---- manifest.json ---- */

  const files = [
    "PROVENANCE.md",
    "logState.46795144.json",
    `getLogs.${windowFrom}-${windowTo}.json`,
  ];
  const manifest = {
    generatedBy: "generate.mjs",
    files: Object.fromEntries(
      files.map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(path.join(outDir, name)))
          .digest("hex"),
      ]),
    ),
  };
  writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return { outDir, files: [...files, "manifest.json"] };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const outDir = process.argv[2] ?? HERE;
  const result = generate(outDir);
  console.error(`wrote ${result.files.length} files to ${result.outDir}`);
}
