/**
 * Published checkpoint history: decoding the
 * univocity contract's `CheckpointPublished` event data, the backward
 * chunked window arithmetic the net layer walks, and the `known-accumulator`
 * snapshot builder for a checkpoint read from history rather than from
 * `logState`. Pure over bytes — no `fetch`, no `node:*`; `src/net/history.ts`
 * is the only place the `eth_getLogs` calls this decode feeds are made.
 */
import { normalizeAddress, toContractLogId } from "./endpoints.js";
import {
  buildKnownAccumulator,
  hexToBigint,
  hexToBytes32,
  hexToBytesRaw,
  readBytes32,
  readWord,
  stripHexPrefix,
  WORD_BYTES,
} from "./chain.js";

/**
 * keccak256 of `CheckpointPublished(bytes32,bytes32,bytes,address,bytes8,uint8,uint64,bytes32[],uint64,bytes32[])`
 * (univocity `IUnivocityEvents.sol`), cross-checked against `forestrie-cli`'s
 * `verify-eventscan.ts` and against the event declaration.
 */
export const CHECKPOINT_PUBLISHED_TOPIC0 =
  "0x156942b408823cb05a16027962ea485fa7171d99779ee04094280b2569482426";

/** `[topic0, the log's 32-byte contract key]` — an `eth_getLogs` filter
 *  for one log's `CheckpointPublished` events, matching `topics[1]` in the
 *  event declaration (`logId` is the first indexed topic after topic0). */
export function checkpointPublishedTopics(logId: string): [string, string] {
  return [CHECKPOINT_PUBLISHED_TOPIC0, toContractLogId(logId)];
}

/** A pure decode failure over already-fetched log bytes — never thrown for
 *  an RPC error itself, which is `src/net`'s concern. */
export class HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryError";
  }
}

export type PublishedCheckpoint = {
  size: bigint;
  accumulator: Uint8Array[];
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
};

/**
 * Decode one `CheckpointPublished` event's `data` field: the non-indexed
 * tuple `(sender, grantIDTimestampBe, logKind, size, accumulator[],
 * grantIndex, grantPath[])`. `size` is word 3, and word 4 is the byte
 * offset (from the start of `data`) to the `accumulator` array — a length
 * word followed by that many 32-byte peaks — exactly the layout
 * `forestrie-cli`'s `decodeCheckpointPublishedData` reads (verified against
 * the real fixtures in `test/fixtures/chain/history/`). Malformed data throws `HistoryError`,
 * never a fetch-layer error.
 */
export function decodeCheckpointPublishedLog(log: {
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
}): PublishedCheckpoint {
  try {
    const hex = stripHexPrefix(log.data.trim());
    if (hex.length === 0) {
      throw new Error("empty data");
    }
    const bytes = hexToBytesRaw(hex);

    const size = readWord(bytes, WORD_BYTES * 3);
    const arrOffset = Number(readWord(bytes, WORD_BYTES * 4));
    const arrLen = Number(readWord(bytes, arrOffset));

    const accumulator: Uint8Array[] = [];
    for (let i = 0; i < arrLen; i++) {
      accumulator.push(readBytes32(bytes, arrOffset + WORD_BYTES * (1 + i)));
    }

    return {
      size,
      accumulator,
      blockNumber: hexToBigint(log.blockNumber),
      blockHash: log.blockHash,
      txHash: log.transactionHash,
      logIndex: Number(hexToBigint(log.logIndex)),
    };
  } catch (err) {
    throw new HistoryError(
      `malformed CheckpointPublished log: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Newest block first, then newest log index first within a block. Does
 *  not mutate its input. */
export function sortNewestFirst(
  checkpoints: PublishedCheckpoint[],
): PublishedCheckpoint[] {
  return [...checkpoints].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber > b.blockNumber ? -1 : 1;
    }
    if (a.logIndex !== b.logIndex) {
      return a.logIndex > b.logIndex ? -1 : 1;
    }
    return 0;
  });
}

export type HistoryWindow = { from: bigint; to: bigint };

/**
 * Backward, chunked scan windows, newest first. Lowest block scanned
 * is `max(fromBlock ?? 0, latestBlock - maxBlocks + 1, 0)`. Window k:
 * `to_0 = latestBlock`, `from_k = max(to_k - chunkBlocks + 1, lowest)`,
 * `to_{k+1} = from_k - 1`; stops when `from_k == lowest`. Total coverage is
 * never more than `maxBlocks`. Never produces the string `"earliest"` —
 * every bound here is a concrete block number, and `src/net/history.ts`
 * hex-encodes it directly.
 */
export function historyWindows(input: {
  latestBlock: bigint;
  fromBlock?: bigint;
  maxBlocks?: bigint;
  chunkBlocks?: bigint;
}): HistoryWindow[] {
  const { latestBlock } = input;
  const maxBlocks = input.maxBlocks ?? 200_000n;
  const chunkBlocks = input.chunkBlocks ?? 10_000n;
  const requestedFrom = input.fromBlock ?? 0n;
  const maxBlocksFloor = latestBlock - maxBlocks + 1n;

  let lowest = requestedFrom > maxBlocksFloor ? requestedFrom : maxBlocksFloor;
  if (lowest < 0n) lowest = 0n;

  const windows: HistoryWindow[] = [];
  let to = latestBlock;
  // A latestBlock already below `lowest` (a degenerate/empty range) yields
  // no windows at all rather than an inverted one.
  while (to >= lowest) {
    let from = to - chunkBlocks + 1n;
    if (from < lowest) from = lowest;
    windows.push({ from, to });
    if (from === lowest) break;
    to = from - 1n;
  }
  return windows;
}

/**
 * The `known-accumulator` snapshot for one published checkpoint, byte-
 * compatible with `chain.ts`'s `buildKnownAccumulator` (which this calls
 * directly — no duplicated hex/CBOR logic), bound to the event's own block
 * number and hash rather than the caller's `logState` read.
 */
export function toKnownAccumulator(
  cp: PublishedCheckpoint,
  binding: { chainId: number; univocity: string; logId: string },
): Uint8Array {
  return buildKnownAccumulator({
    chainId: BigInt(binding.chainId),
    univocity: normalizeAddress(binding.univocity),
    logId: binding.logId,
    size: cp.size,
    accumulator: cp.accumulator,
    blockNumber: cp.blockNumber,
    blockHash: hexToBytes32(cp.blockHash),
  });
}

/**
 * Newest-first, first accepted wins — "compare the recomputed peak to
 * every peak" done by `accepts` (the verifier's own check), never
 * reimplemented here.
 */
export async function selectCheckpoint(
  checkpoints: PublishedCheckpoint[],
  accepts: (cp: PublishedCheckpoint) => Promise<boolean>,
): Promise<PublishedCheckpoint | null> {
  for (const cp of sortNewestFirst(checkpoints)) {
    if (await accepts(cp)) return cp;
  }
  return null;
}
