/**
 * Published checkpoint history (plan-2609-06 F1/F2): the only place the
 * `eth_getLogs` calls for `CheckpointPublished` are made. Every window is
 * ONE JSON-RPC call, through `chain.ts`'s `callJsonRpc` (shared
 * interpretation, no second copy), backward from `latestBlock`, newest
 * window first — never an unbounded scan, and never the string
 * `"earliest"` (core's `historyWindows` only ever produces concrete block
 * numbers).
 */
import {
  checkpointPublishedTopics,
  decodeCheckpointPublishedLog,
  historyWindows,
  sortNewestFirst,
  type PublishedCheckpoint,
} from "../core/index.js";
import { callJsonRpc, type LogStateProblem } from "./chain.js";
import type { FetchOptions } from "./types.js";

export type ScanCheckpointHistoryInput = {
  rpcUrl: string;
  univocity: string;
  logId: string;
  latestBlock: bigint;
  fromBlock?: bigint;
  maxBlocks?: bigint;
  chunkBlocks?: bigint;
};

/** The only problem shape either function here returns — an RPC-level
 *  failure (HTTP, JSON-RPC `error`, or an unusable `eth_getLogs` result),
 *  or a decode failure over what came back. Never a throw (same posture as
 *  `chain.ts`'s `readLogState`); never a retry. */
export type CheckpointHistoryProblem = {
  code: "rpc_error";
  status?: number;
  message: string;
};

export type ScanCheckpointHistoryResult =
  | {
      kind: "match";
      checkpoint: PublishedCheckpoint;
      scannedFrom: bigint;
      scannedTo: bigint;
      requests: number;
      checkpointsSeen: number;
    }
  | {
      kind: "exhausted";
      scannedFrom: bigint;
      scannedTo: bigint;
      requests: number;
      checkpointsSeen: number;
    }
  | {
      kind: "problem";
      problem: CheckpointHistoryProblem;
      scannedFrom: bigint;
      scannedTo: bigint;
      requests: number;
    };

export type FetchCheckpointHistoryResult =
  | {
      kind: "ok";
      checkpoints: PublishedCheckpoint[];
      scannedFrom: bigint;
      scannedTo: bigint;
      requests: number;
    }
  | {
      kind: "problem";
      problem: CheckpointHistoryProblem;
      scannedFrom: bigint;
      scannedTo: bigint;
      requests: number;
    };

function toHex(n: bigint): string {
  return `0x${n.toString(16)}`;
}

/** `historyWindows` over one `ScanCheckpointHistoryInput`, respecting
 *  `exactOptionalPropertyTypes` (an explicit `undefined` is not the same
 *  as an absent key). */
function windowsFor(input: ScanCheckpointHistoryInput) {
  return historyWindows({
    latestBlock: input.latestBlock,
    ...(input.fromBlock !== undefined ? { fromBlock: input.fromBlock } : {}),
    ...(input.maxBlocks !== undefined ? { maxBlocks: input.maxBlocks } : {}),
    ...(input.chunkBlocks !== undefined
      ? { chunkBlocks: input.chunkBlocks }
      : {}),
  });
}

type WindowOutcome =
  | { ok: true; checkpoints: PublishedCheckpoint[] }
  | { ok: false; problem: CheckpointHistoryProblem };

/** One window's `eth_getLogs`, decoded and sorted newest-first. */
async function fetchWindow(
  input: {
    rpcUrl: string;
    univocity: string;
    logId: string;
    from: bigint;
    to: bigint;
  },
  requestId: number,
  opts: FetchOptions | undefined,
): Promise<WindowOutcome> {
  const outcome = await callJsonRpc(
    input.rpcUrl,
    requestId,
    "eth_getLogs",
    [
      {
        address: input.univocity,
        topics: checkpointPublishedTopics(input.logId),
        fromBlock: toHex(input.from),
        toBlock: toHex(input.to),
      },
    ],
    opts,
  );
  if (!outcome.ok) {
    const problem = outcome.result.problem as LogStateProblem;
    return {
      ok: false,
      problem: {
        code: "rpc_error",
        ...("status" in problem && problem.status !== undefined
          ? { status: problem.status }
          : {}),
        message: "message" in problem ? problem.message : "eth_getLogs failed",
      },
    };
  }
  if (!Array.isArray(outcome.result)) {
    return {
      ok: false,
      problem: {
        code: "rpc_error",
        message: "eth_getLogs result is not an array",
      },
    };
  }
  try {
    const decoded = (
      outcome.result as Array<{
        data: string;
        blockNumber: string;
        blockHash: string;
        transactionHash: string;
        logIndex: string;
      }>
    ).map((log) => decodeCheckpointPublishedLog(log));
    return { ok: true, checkpoints: sortNewestFirst(decoded) };
  } catch (err) {
    return {
      ok: false,
      problem: {
        code: "rpc_error",
        message: `eth_getLogs result undecodable: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Walk `historyWindows` backward from `latestBlock`, newest window first,
 * calling `stopWhen` with each window's decoded checkpoints (newest
 * first); stop as soon as it returns non-null. Exhausts the budget (never
 * throws, never retries, never unbounded) if nothing is accepted.
 */
export async function scanCheckpointHistory(
  input: ScanCheckpointHistoryInput,
  stopWhen: (
    checkpoints: PublishedCheckpoint[],
  ) => Promise<PublishedCheckpoint | null>,
  opts?: FetchOptions,
): Promise<ScanCheckpointHistoryResult> {
  const windows = windowsFor(input);

  let requests = 0;
  let checkpointsSeen = 0;
  let scannedFrom = input.latestBlock;

  for (const window of windows) {
    requests += 1;
    const outcome = await fetchWindow(
      {
        rpcUrl: input.rpcUrl,
        univocity: input.univocity,
        logId: input.logId,
        from: window.from,
        to: window.to,
      },
      requests,
      opts,
    );
    if (!outcome.ok) {
      return {
        kind: "problem",
        problem: outcome.problem,
        scannedFrom: window.from,
        scannedTo: input.latestBlock,
        requests,
      };
    }
    checkpointsSeen += outcome.checkpoints.length;
    scannedFrom = window.from;

    const match = await stopWhen(outcome.checkpoints);
    if (match !== null) {
      return {
        kind: "match",
        checkpoint: match,
        scannedFrom,
        scannedTo: input.latestBlock,
        requests,
        checkpointsSeen,
      };
    }
  }

  return {
    kind: "exhausted",
    scannedFrom,
    scannedTo: input.latestBlock,
    requests,
    checkpointsSeen,
  };
}

/**
 * The same backward, chunked walk as `scanCheckpointHistory`, with no
 * early exit: every checkpoint in the budgeted range, newest first.
 * `fetch_checkpoint_history` (step 1.4) exposes this as a tool; this step
 * only implements and exports it.
 */
export async function fetchCheckpointHistory(
  input: ScanCheckpointHistoryInput,
  opts?: FetchOptions,
): Promise<FetchCheckpointHistoryResult> {
  const windows = windowsFor(input);

  let requests = 0;
  let scannedFrom = input.latestBlock;
  const checkpoints: PublishedCheckpoint[] = [];

  for (const window of windows) {
    requests += 1;
    const outcome = await fetchWindow(
      {
        rpcUrl: input.rpcUrl,
        univocity: input.univocity,
        logId: input.logId,
        from: window.from,
        to: window.to,
      },
      requests,
      opts,
    );
    if (!outcome.ok) {
      return {
        kind: "problem",
        problem: outcome.problem,
        scannedFrom: window.from,
        scannedTo: input.latestBlock,
        requests,
      };
    }
    checkpoints.push(...outcome.checkpoints);
    scannedFrom = window.from;
  }

  return {
    kind: "ok",
    checkpoints,
    scannedFrom,
    scannedTo: input.latestBlock,
    requests,
  };
}
