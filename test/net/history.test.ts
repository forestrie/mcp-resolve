/**
 * `src/net/history.ts` over the frozen real + synthetic `eth_getLogs`
 * fixtures. `test/net/replay.ts`'s `createChainHistoryReplay` asserts the
 * incoming request's `address`/`topics` match what each fixture recorded.
 */
import { describe, expect, it } from "vitest";
import {
  fetchCheckpointHistory,
  scanCheckpointHistory,
  type ScanCheckpointHistoryInput,
} from "../../src/net/index.js";
import type { PublishedCheckpoint } from "../../src/core/index.js";
import { createChainHistoryReplay } from "./replay.js";

const RPC_URL = "https://rpc.example/anything";
const LOG_ID = "e8345800-a747-4e62-9409-61622b836f1f";
const UNIVOCITY = "0x678768643B4667aEDcB313cC81624aA560b7f0Ca";

// The synthetic fixture's fabricated "latest" state: 46785144 (real) + 10 000.
const SYNTHETIC_LATEST_BLOCK = 46795144n;

function baseInput(
  overrides?: Partial<ScanCheckpointHistoryInput>,
): ScanCheckpointHistoryInput {
  return {
    rpcUrl: RPC_URL,
    univocity: UNIVOCITY,
    logId: LOG_ID,
    latestBlock: SYNTHETIC_LATEST_BLOCK,
    ...overrides,
  };
}

/** Accepts the first checkpoint of size 11 — the real newest checkpoint,
 *  standing in for "the verifier's known-accumulator check on this
 *  receipt under this checkpoint is ok" without depending on the verifier
 *  in a net-layer test. */
async function acceptsSize11(
  checkpoints: PublishedCheckpoint[],
): Promise<PublishedCheckpoint | null> {
  for (const cp of checkpoints) {
    if (cp.size === 11n) return cp;
  }
  return null;
}

describe("scanCheckpointHistory", () => {
  it("finds the size-11 checkpoint from the synthetic latest in exactly 4 requests", async () => {
    const replay = await createChainHistoryReplay();

    const result = await scanCheckpointHistory(baseInput(), acceptsSize11, {
      fetchImpl: replay.fetch,
    });

    expect(result.kind).toBe("match");
    if (result.kind !== "match") throw new Error("unreachable");
    expect(result.requests).toBe(4);
    expect(result.checkpoint.size).toBe(11n);
    expect(result.checkpoint.blockNumber).toBe(46764680n);
    expect(result.scannedFrom).toBe(46755145n);
    expect(result.scannedTo).toBe(SYNTHETIC_LATEST_BLOCK);
    expect(result.checkpointsSeen).toBe(4); // 1 (synthetic) + 0 + 0 + 3 (real)
  });

  it("exhausts after exactly 2 requests when maxBlocks is too small to reach the peak", async () => {
    const replay = await createChainHistoryReplay();

    const result = await scanCheckpointHistory(
      baseInput({ maxBlocks: 20_000n }),
      acceptsSize11,
      { fetchImpl: replay.fetch },
    );

    expect(result.kind).toBe("exhausted");
    if (result.kind !== "exhausted") throw new Error("unreachable");
    expect(result.requests).toBe(2);
    expect(result.checkpointsSeen).toBe(1);
    expect(result.scannedFrom).toBe(46775145n);
    expect(result.scannedTo).toBe(SYNTHETIC_LATEST_BLOCK);
  });

  it("never sends fromBlock/toBlock 'earliest'", async () => {
    const replay = await createChainHistoryReplay();
    await scanCheckpointHistory(baseInput(), acceptsSize11, {
      fetchImpl: replay.fetch,
    });
    for (const call of replay.calls) {
      const body = JSON.parse(String(call.init?.body)) as {
        params: [{ fromBlock: string; toBlock: string }];
      };
      expect(body.params[0].fromBlock).not.toBe("earliest");
      expect(body.params[0].toBlock).not.toBe("earliest");
    }
  });

  it("returns a problem, never a throw, for a JSON-RPC error body", async () => {
    const replay = await createChainHistoryReplay([
      {
        fromBlock: "0x2c9e279",
        toBlock: "0x2ca0988",
        status: 200,
        response: {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "boom" },
        },
      },
    ]);

    const result = await scanCheckpointHistory(baseInput(), acceptsSize11, {
      fetchImpl: replay.fetch,
    });

    expect(result.kind).toBe("problem");
    if (result.kind !== "problem") throw new Error("unreachable");
    expect(result.problem).toEqual({
      code: "rpc_error",
      status: 200,
      message: "boom",
    });
    expect(result.requests).toBe(1);
  });

  it("stops immediately (1 request) when fromBlock equals latestBlock's window floor and nothing matches", async () => {
    const replay = await createChainHistoryReplay();
    const result = await scanCheckpointHistory(
      baseInput({ fromBlock: SYNTHETIC_LATEST_BLOCK - 9_999n }),
      async () => null,
      { fetchImpl: replay.fetch },
    );
    expect(result.kind).toBe("exhausted");
    expect(replay.calls).toHaveLength(1);
  });
});

describe("fetchCheckpointHistory", () => {
  it("collects every checkpoint in the budget, newest first, with no early exit", async () => {
    const replay = await createChainHistoryReplay();

    const result = await fetchCheckpointHistory(
      baseInput({ maxBlocks: 20_000n }),
      { fetchImpl: replay.fetch },
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.requests).toBe(2);
    expect(result.checkpoints).toHaveLength(1); // the fabricated size-15 checkpoint
    expect(result.checkpoints[0]?.size).toBe(15n);
    expect(result.scannedFrom).toBe(46775145n);
    expect(result.scannedTo).toBe(SYNTHETIC_LATEST_BLOCK);
  });

  it("carries through a problem unchanged, never a throw", async () => {
    const replay = await createChainHistoryReplay([
      {
        fromBlock: "0x2c9e279",
        toBlock: "0x2ca0988",
        status: 500,
        response: "internal error",
      },
    ]);

    const result = await fetchCheckpointHistory(baseInput(), {
      fetchImpl: replay.fetch,
    });

    expect(result.kind).toBe("problem");
  });
});
