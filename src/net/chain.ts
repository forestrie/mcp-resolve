/**
 * The local three-call JSON-RPC `logState` read (plan-2609-05 N4 amendment
 * B): `eth_chainId`, `eth_getBlockByNumber("latest", false)`, then
 * `eth_call { to: univocity, data: logStateCalldata(logId) }` at that
 * block's number. No `@forestrie/chain-rpc` — its `EthRpcOptions` has no
 * `fetchImpl` injection point (AGENTS.md, N4 amendment B), so this module
 * makes the POSTs itself, each through the injected `fetchImpl`. Also here:
 * `readChainHead` (plan-2609-06 F4), the same first two calls without the
 * `eth_call`, for `fetch_checkpoint_history`, which has no use for `logState`.
 *
 * A JSON-RPC-level `error` member, a non-2xx status, or an unusable result
 * shape is returned as a structured `{ kind: "problem", problem }` — never
 * thrown, per N8 and this step's spec. `NetError` is thrown only when no
 * response was obtained at all for one of the calls.
 */
import {
  buildKnownAccumulator,
  decodeLogStateResult,
  hexToBigint,
  hexToBytes32,
  logStateCalldata,
} from "../core/index.js";
import { rawJsonRpcPost } from "./http.js";
import type { FetchOptions } from "./types.js";

export type ReadLogStateInput = {
  rpcUrl: string;
  univocity: string;
  logId: string;
  expectedChainId?: number;
};

export type LogStateProblem =
  | { code: "rpc_error"; status?: number; message: string }
  | { code: "rpc_chain_id_mismatch"; expected: number; actual: number };

export type ReadLogStateResult =
  | {
      kind: "ok";
      chainId: number;
      blockNumber: bigint;
      blockHash: string;
      resultHex: string;
      at: string;
      rpcUrl: string;
      univocity: string;
    }
  | { kind: "problem"; problem: LogStateProblem };

function jsonRpcRequest(id: number, method: string, params: unknown[]) {
  return { jsonrpc: "2.0", id, method, params };
}

function rpcErrorProblem(
  status: number | undefined,
  message: string,
): { kind: "problem"; problem: LogStateProblem } {
  return {
    kind: "problem",
    problem: {
      code: "rpc_error",
      ...(status !== undefined ? { status } : {}),
      message,
    },
  };
}

export type JsonRpcOutcome =
  | { ok: true; result: unknown }
  | { ok: false; result: { kind: "problem"; problem: LogStateProblem } };

/** One JSON-RPC call, interpreted: an HTTP-level failure, a JSON-RPC
 *  `error` member, or a missing `result` field are all `rpc_error`
 *  problems — never a throw (that is `NetError`'s job, for "no response at
 *  all"). Exported so `history.ts`'s `eth_getLogs` walk shares this
 *  interpretation instead of a second copy. */
export async function callJsonRpc(
  rpcUrl: string,
  id: number,
  method: string,
  params: unknown[],
  opts: FetchOptions | undefined,
): Promise<JsonRpcOutcome> {
  const raw = await rawJsonRpcPost(
    rpcUrl,
    jsonRpcRequest(id, method, params),
    opts,
  );
  if (raw.status < 200 || raw.status >= 300) {
    return {
      ok: false,
      result: rpcErrorProblem(
        raw.status,
        `HTTP ${raw.status} calling ${method}`,
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw.body));
  } catch (err) {
    return {
      ok: false,
      result: rpcErrorProblem(
        raw.status,
        `response to ${method} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  if (parsed === null || typeof parsed !== "object") {
    return {
      ok: false,
      result: rpcErrorProblem(
        raw.status,
        `response to ${method} is not an object`,
      ),
    };
  }

  if ("error" in parsed) {
    const error = (parsed as { error: unknown }).error;
    const message =
      error !== null && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : `JSON-RPC error calling ${method}`;
    return { ok: false, result: rpcErrorProblem(raw.status, message) };
  }

  if (!("result" in parsed)) {
    return {
      ok: false,
      result: rpcErrorProblem(
        raw.status,
        `response to ${method} has no result`,
      ),
    };
  }

  return { ok: true, result: (parsed as { result: unknown }).result };
}

type ChainHeadOutcome =
  | {
      kind: "ok";
      chainId: number;
      blockNumber: bigint;
      blockHash: string;
      blockNumberHex: string;
    }
  | { kind: "problem"; problem: LogStateProblem };

/**
 * `eth_chainId` -> (if `expectedChainId` given and it differs, RETURN a
 * `rpc_chain_id_mismatch` problem before any further call, N2 amendment A)
 * -> `eth_getBlockByNumber("latest", false)`. Ids 1, 2 — shared by
 * `readLogState` below (which continues with `eth_call` at id 3) and
 * `readChainHead` (plan-2609-06 F4), which stops here:
 * `fetch_checkpoint_history` needs only the latest block, never `logState`.
 */
async function readChainIdAndLatestBlock(
  rpcUrl: string,
  expectedChainId: number | undefined,
  opts: FetchOptions | undefined,
): Promise<ChainHeadOutcome> {
  const chainIdCall = await callJsonRpc(rpcUrl, 1, "eth_chainId", [], opts);
  if (!chainIdCall.ok) return chainIdCall.result;
  if (typeof chainIdCall.result !== "string") {
    return rpcErrorProblem(
      undefined,
      "eth_chainId result is not a hex string",
    );
  }
  const chainId = Number(hexToBigint(chainIdCall.result));
  if (expectedChainId !== undefined && chainId !== expectedChainId) {
    return {
      kind: "problem",
      problem: {
        code: "rpc_chain_id_mismatch",
        expected: expectedChainId,
        actual: chainId,
      },
    };
  }

  const blockCall = await callJsonRpc(
    rpcUrl,
    2,
    "eth_getBlockByNumber",
    ["latest", false],
    opts,
  );
  if (!blockCall.ok) return blockCall.result;
  const block = blockCall.result as { number?: unknown; hash?: unknown };
  if (typeof block.number !== "string" || typeof block.hash !== "string") {
    return rpcErrorProblem(
      undefined,
      "eth_getBlockByNumber result missing number/hash",
    );
  }

  return {
    kind: "ok",
    chainId,
    blockNumber: hexToBigint(block.number),
    blockHash: block.hash,
    blockNumberHex: block.number,
  };
}

/**
 * `eth_chainId` -> (if `expectedChainId` given and it differs, RETURN a
 * `rpc_chain_id_mismatch` problem before any further call, N2 amendment A)
 * -> `eth_getBlockByNumber("latest", false)` -> `eth_call` for `logState`
 * at that block. Ids 1, 2, 3.
 */
export async function readLogState(
  input: ReadLogStateInput,
  opts?: FetchOptions,
): Promise<ReadLogStateResult> {
  const head = await readChainIdAndLatestBlock(
    input.rpcUrl,
    input.expectedChainId,
    opts,
  );
  if (head.kind === "problem") return head;

  const callResult = await callJsonRpc(
    input.rpcUrl,
    3,
    "eth_call",
    [
      { to: input.univocity, data: logStateCalldata(input.logId) },
      head.blockNumberHex,
    ],
    opts,
  );
  if (!callResult.ok) return callResult.result;
  if (typeof callResult.result !== "string") {
    return rpcErrorProblem(undefined, "eth_call result is not a hex string");
  }

  const at = new Date().toISOString();
  return {
    kind: "ok",
    chainId: head.chainId,
    blockNumber: head.blockNumber,
    blockHash: head.blockHash,
    resultHex: callResult.result,
    at,
    rpcUrl: input.rpcUrl,
    univocity: input.univocity,
  };
}

export type ReadChainHeadInput = {
  rpcUrl: string;
  expectedChainId?: number;
};

export type ReadChainHeadResult =
  | {
      kind: "ok";
      chainId: number;
      blockNumber: bigint;
      blockHash: string;
      at: string;
      rpcUrl: string;
    }
  | { kind: "problem"; problem: LogStateProblem };

/**
 * `eth_chainId` -> `eth_getBlockByNumber("latest", false)`, and nothing
 * else — no `eth_call` (plan-2609-06 F4). `fetch_checkpoint_history` scans
 * `CheckpointPublished` history from the latest block; it never reads
 * `logState` itself. `@forestrie/chain-rpc` has no `fetchImpl` injection
 * point (AGENTS.md, N4 amendment B), so — as with the rest of this module —
 * this is a small function making only the two calls this tool needs
 * through the injected `fetchImpl`, rather than a call to `readLogState`
 * that would always make the third, unneeded, `eth_call`.
 */
export async function readChainHead(
  input: ReadChainHeadInput,
  opts?: FetchOptions,
): Promise<ReadChainHeadResult> {
  const head = await readChainIdAndLatestBlock(
    input.rpcUrl,
    input.expectedChainId,
    opts,
  );
  if (head.kind === "problem") return head;

  return {
    kind: "ok",
    chainId: head.chainId,
    blockNumber: head.blockNumber,
    blockHash: head.blockHash,
    at: new Date().toISOString(),
    rpcUrl: input.rpcUrl,
  };
}

export type FetchAccumulatorSnapshotResult =
  | {
      kind: "ok";
      snapshot: Uint8Array;
      accumulator: Uint8Array[];
      size: bigint;
      chainId: number;
      blockNumber: bigint;
      blockHash: string;
      at: string;
      rpcUrl: string;
      univocity: string;
    }
  | {
      kind: "problem";
      problem:
        LogStateProblem | { code: "log_state_undecodable"; message: string };
    };

/**
 * `readLogState` then core's `decodeLogStateResult` + `buildKnownAccumulator`
 * — the byte-compatible `known-accumulator` snapshot `forestrie
 * fetch-accumulator` writes. A decode or encode failure over the returned
 * bytes is `log_state_undecodable`, not a throw.
 */
export async function fetchAccumulatorSnapshot(
  input: ReadLogStateInput,
  opts?: FetchOptions,
): Promise<FetchAccumulatorSnapshotResult> {
  const state = await readLogState(input, opts);
  if (state.kind === "problem") return state;

  let decoded: { accumulator: Uint8Array[]; size: bigint };
  try {
    decoded = decodeLogStateResult(state.resultHex);
  } catch (err) {
    return {
      kind: "problem",
      problem: {
        code: "log_state_undecodable",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  let snapshot: Uint8Array;
  try {
    snapshot = buildKnownAccumulator({
      chainId: BigInt(state.chainId),
      univocity: input.univocity,
      logId: input.logId,
      size: decoded.size,
      accumulator: decoded.accumulator,
      blockNumber: state.blockNumber,
      blockHash: hexToBytes32(state.blockHash),
    });
  } catch (err) {
    return {
      kind: "problem",
      problem: {
        code: "log_state_undecodable",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  return {
    kind: "ok",
    snapshot,
    accumulator: decoded.accumulator,
    size: decoded.size,
    chainId: state.chainId,
    blockNumber: state.blockNumber,
    blockHash: state.blockHash,
    at: state.at,
    rpcUrl: state.rpcUrl,
    univocity: state.univocity,
  };
}
