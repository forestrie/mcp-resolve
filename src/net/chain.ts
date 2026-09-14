/**
 * The three-call JSON-RPC `logState` read (plan-2609-05 N4 amendment B):
 * `eth_chainId`, `eth_getBlockByNumber("latest", false)`, then `eth_call {
 * to: univocity, data: logStateCalldata(logId) }` at that block's number.
 * The POSTs themselves go through `@forestrie/chain-rpc`'s `ethRpc`
 * (plan-2609-06 F7 — its 0.3.0 `EthRpcOptions` gained the `fetchImpl`
 * injection point AGENTS.md's N4 amendment B noted was missing); this
 * module keeps the three-call sequencing, the `rpc_chain_id_mismatch`
 * short-circuit, and the `never throw for a response actually obtained`
 * interpretation exactly as before — only the transport underneath
 * `callJsonRpc` changed. Also here: `readChainHead` (plan-2609-06 F4), the
 * same first two calls without the `eth_call`, for
 * `fetch_checkpoint_history`, which has no use for `logState`.
 *
 * A JSON-RPC-level `error` member, a non-2xx status, or an unusable result
 * shape is returned as a structured `{ kind: "problem", problem }` — never
 * thrown, per N8 and this step's spec. `NetError` is thrown only when no
 * response was obtained at all for one of the calls.
 */
import { ethRpc } from "@forestrie/chain-rpc";
import {
  buildKnownAccumulator,
  decodeLogStateResult,
  hexToBigint,
  hexToBytes32,
  logStateCalldata,
} from "../core/index.js";
import { DEFAULT_TIMEOUT_MS, withNetErrors } from "./http.js";
import { NetError, type FetchOptions } from "./types.js";

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

/**
 * One JSON-RPC call, interpreted: an HTTP-level failure or a JSON-RPC
 * `error` member is an `rpc_error` problem — never a throw (that is
 * `NetError`'s job, for "no response at all"). Exported so `history.ts`'s
 * `eth_getLogs` walk shares this interpretation instead of a second copy.
 *
 * `id` is accepted for call-site compatibility (`history.ts` passes an
 * incrementing request counter) but unused: `@forestrie/chain-rpc`'s
 * `ethRpc` (F7) builds its own JSON-RPC envelope, always with `id: 1` —
 * nothing here reads the outgoing `id` back off a response, so this is a
 * cosmetic difference only.
 *
 * `ethRpc` itself throws rather than returning a structured result: an
 * `Error("RPC {method} failed: {status}")` when `!res.ok`, or a plain
 * `Error(json.error.message)` for a JSON-RPC-level `error` member
 * (`dist/eth-rpc.js`, 0.3.0, exact pin) — and in the second case the
 * thrown message carries no status at all, even though a response (2xx)
 * was in fact obtained. Rather than parse the status back out of the first
 * message shape (fragile, and useless for the second), the `fetchImpl`
 * `ethRpc` is given here is wrapped twice: once in `withNetErrors`
 * (http.ts, for the timeout/`NetError` guarantee), and again just to
 * record the real `Response.status` of the one request this makes, in
 * `lastStatus`, before `ethRpc` parses the body — so every `rpc_error`
 * problem below carries the actual HTTP status regardless of which of
 * ethRpc's two failure shapes it hit, exactly as this package's own
 * pre-F7 JSON-RPC POST always did.
 *
 * A genuine transport failure or timeout still surfaces as `NetError`:
 * `ethRpc`'s own `catch` only special-cases `AbortError`, so a `NetError`
 * `withNetErrors` already raised is rethrown unchanged, and
 * `if (err instanceof NetError) throw err;` below always fires for it
 * before `lastStatus` (never set in that case, since no response was
 * obtained) is consulted.
 */
export async function callJsonRpc(
  rpcUrl: string,
  id: number,
  method: string,
  params: unknown[],
  opts: FetchOptions | undefined,
): Promise<JsonRpcOutcome> {
  void id;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const netErrorFetch = withNetErrors(fetchImpl, timeoutMs);

  let lastStatus: number | undefined;
  const recordingFetch = (async (input, init) => {
    const res = await netErrorFetch(input, init);
    lastStatus = res.status;
    return res;
  }) as typeof fetch;

  let result: unknown;
  try {
    result = await ethRpc(rpcUrl, method, params, {
      timeoutMs,
      fetchImpl: recordingFetch,
    });
  } catch (err) {
    if (err instanceof NetError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const httpFailed =
      lastStatus !== undefined && (lastStatus < 200 || lastStatus >= 300);
    return {
      ok: false,
      result: rpcErrorProblem(
        lastStatus,
        httpFailed ? `HTTP ${lastStatus} calling ${method}` : message,
      ),
    };
  }
  return { ok: true, result };
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
