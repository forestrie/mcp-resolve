/**
 * `src/core/history.ts` over the FROZEN real fixtures
 * (`test/fixtures/chain/history/<logId>/`, plan-2609-06 step 1.2) plus
 * synthetic `PublishedCheckpoint` values for the pure arithmetic
 * (`historyWindows`, `selectCheckpoint`) that don't need real bytes.
 */
import { decodeKnownAccumulator } from "@forestrie/receipt-verify";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HistoryError,
  checkpointPublishedTopics,
  decodeCheckpointPublishedLog,
  historyWindows,
  selectCheckpoint,
  sortNewestFirst,
  toKnownAccumulator,
  type PublishedCheckpoint,
} from "../../src/core/index.js";

const repoRoot = new URL("../../", import.meta.url).pathname;
const HISTORY_DIR = `${repoRoot}test/fixtures/chain/history/e8345800-a747-4e62-9409-61622b836f1f`;
const LOG_ID = "e8345800-a747-4e62-9409-61622b836f1f";
const UNIVOCITY = "0x678768643B4667aEDcB313cC81624aA560b7f0Ca";
const CHAIN_ID = 84532;

type RawLog = {
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
};

function readGetLogs(name: string): RawLog[] {
  const raw = JSON.parse(readFileSync(`${HISTORY_DIR}/${name}`, "utf8")) as {
    response: { result: RawLog[] };
  };
  return raw.response.result;
}

/** Every real `CheckpointPublished` log in the frozen fixture directory,
 *  oldest first, with the values PROVENANCE.md records by hand. */
const REAL_LOGS: RawLog[] = [
  ...readGetLogs("getLogs.46732186-46735144.json"), // size 1, size 3
  ...readGetLogs("getLogs.46735145-46745144.json"), // size 4
  ...readGetLogs("getLogs.46755145-46765144.json"), // size 8, size 10, size 11
];

const EXPECTED = [
  { blockNumber: 46734813n, size: 1n, peaks: 1 },
  { blockNumber: 46734839n, size: 3n, peaks: 1 },
  { blockNumber: 46736245n, size: 4n, peaks: 2 },
  { blockNumber: 46764135n, size: 8n, peaks: 2 },
  { blockNumber: 46764156n, size: 10n, peaks: 2 },
  { blockNumber: 46764680n, size: 11n, peaks: 3 },
];

describe("decodeCheckpointPublishedLog", () => {
  it("decodes size and accumulator length for every real checkpoint", () => {
    expect(REAL_LOGS).toHaveLength(EXPECTED.length);
    const decoded = REAL_LOGS.map((log) => decodeCheckpointPublishedLog(log));
    for (let i = 0; i < EXPECTED.length; i++) {
      const cp = decoded[i]!;
      const want = EXPECTED[i]!;
      expect(cp.blockNumber).toBe(want.blockNumber);
      expect(cp.size).toBe(want.size);
      expect(cp.accumulator).toHaveLength(want.peaks);
      for (const peak of cp.accumulator) {
        expect(peak).toBeInstanceOf(Uint8Array);
        expect(peak).toHaveLength(32);
      }
    }
  });

  it("carries blockHash, txHash and logIndex through unchanged", () => {
    const log = REAL_LOGS[0]!;
    const cp = decodeCheckpointPublishedLog(log);
    expect(cp.blockHash).toBe(log.blockHash);
    expect(cp.txHash).toBe(log.transactionHash);
    expect(cp.logIndex).toBe(Number(BigInt(log.logIndex)));
  });

  it("throws HistoryError on empty data", () => {
    expect(() =>
      decodeCheckpointPublishedLog({
        data: "0x",
        blockNumber: "0x1",
        blockHash: "0x" + "00".repeat(32),
        transactionHash: "0x" + "11".repeat(32),
        logIndex: "0x0",
      }),
    ).toThrow(HistoryError);
  });

  it("throws HistoryError on truncated data", () => {
    expect(() =>
      decodeCheckpointPublishedLog({
        data: "0x00",
        blockNumber: "0x1",
        blockHash: "0x" + "00".repeat(32),
        transactionHash: "0x" + "11".repeat(32),
        logIndex: "0x0",
      }),
    ).toThrow(HistoryError);
  });
});

describe("checkpointPublishedTopics", () => {
  it("matches the real fixture's recorded topics[0..1]", () => {
    const [topic0, topic1] = checkpointPublishedTopics(LOG_ID);
    const fixtureRaw = JSON.parse(
      readFileSync(`${HISTORY_DIR}/getLogs.46755145-46765144.json`, "utf8"),
    ) as { request: { params: [{ topics: string[] }] } };
    const recordedTopics = fixtureRaw.request.params[0].topics;
    expect(topic0).toBe(recordedTopics[0]);
    expect(topic1).toBe(recordedTopics[1]);
  });
});

describe("sortNewestFirst", () => {
  const cp = (blockNumber: bigint, logIndex: number): PublishedCheckpoint => ({
    size: 1n,
    accumulator: [],
    blockNumber,
    blockHash: "0x0",
    txHash: "0x0",
    logIndex,
  });

  it("orders by blockNumber desc, then logIndex desc", () => {
    const input = [cp(1n, 0), cp(3n, 5), cp(3n, 1), cp(2n, 0)];
    expect(sortNewestFirst(input)).toEqual([
      cp(3n, 5),
      cp(3n, 1),
      cp(2n, 0),
      cp(1n, 0),
    ]);
  });

  it("does not mutate its input", () => {
    const input = [cp(1n, 0), cp(3n, 0)];
    const copy = [...input];
    sortNewestFirst(input);
    expect(input).toEqual(copy);
  });
});

describe("historyWindows", () => {
  const LATEST = 46785144n;

  it("defaults: 10_000-block windows, 200_000-block budget, newest first", () => {
    const windows = historyWindows({ latestBlock: LATEST });
    expect(windows[0]).toEqual({ from: 46775145n, to: 46785144n });
    // Coverage never exceeds maxBlocks (200_000 default).
    const lowest = windows[windows.length - 1]!.from;
    expect(LATEST - lowest + 1n).toBeLessThanOrEqual(200_000n);
    // Newest first: `to` strictly decreases window over window.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.to).toBeLessThan(windows[i - 1]!.to);
    }
  });

  it("matches the real fixture's windows exactly given the deploy block as fromBlock", () => {
    const windows = historyWindows({
      latestBlock: LATEST,
      fromBlock: 46732186n,
      maxBlocks: 200_000n,
      chunkBlocks: 10_000n,
    });
    expect(windows).toEqual([
      { from: 46775145n, to: 46785144n },
      { from: 46765145n, to: 46775144n },
      { from: 46755145n, to: 46765144n },
      { from: 46745145n, to: 46755144n },
      { from: 46735145n, to: 46745144n },
      { from: 46732186n, to: 46735144n },
    ]);
  });

  it("maxBlocks smaller than one chunk: a single, narrower window", () => {
    const windows = historyWindows({
      latestBlock: LATEST,
      maxBlocks: 100n,
      chunkBlocks: 10_000n,
    });
    expect(windows).toEqual([{ from: LATEST - 99n, to: LATEST }]);
  });

  it("clamps the lowest block at 0", () => {
    const windows = historyWindows({
      latestBlock: 50n,
      maxBlocks: 200_000n,
      chunkBlocks: 10_000n,
    });
    expect(windows).toEqual([{ from: 0n, to: 50n }]);
  });

  it("never produces the string 'earliest'", () => {
    const windows = historyWindows({ latestBlock: LATEST, fromBlock: 0n });
    for (const w of windows) {
      expect(String(w.from)).not.toBe("earliest");
      expect(String(w.to)).not.toBe("earliest");
    }
  });
});

describe("toKnownAccumulator", () => {
  it("round-trips through decodeKnownAccumulator", () => {
    const log = REAL_LOGS[REAL_LOGS.length - 1]!; // size 11, block 46764680
    const cp = decodeCheckpointPublishedLog(log);

    const snapshot = toKnownAccumulator(cp, {
      chainId: CHAIN_ID,
      univocity: UNIVOCITY,
      logId: LOG_ID,
    });
    const decoded = decodeKnownAccumulator(snapshot);

    expect(decoded.version).toBe(1);
    expect(decoded.chainId).toBe(BigInt(CHAIN_ID));
    expect(decoded.size).toBe(cp.size);
    expect(decoded.accumulator).toHaveLength(cp.accumulator.length);
    for (let i = 0; i < cp.accumulator.length; i++) {
      expect(Buffer.from(decoded.accumulator[i]!)).toEqual(
        Buffer.from(cp.accumulator[i]!),
      );
    }
    expect(decoded.blockNumber).toBe(cp.blockNumber);
    expect(Buffer.from(decoded.blockHash).toString("hex")).toBe(
      cp.blockHash.slice(2),
    );
  });
});

describe("selectCheckpoint", () => {
  const cp = (blockNumber: bigint): PublishedCheckpoint => ({
    size: blockNumber,
    accumulator: [],
    blockNumber,
    blockHash: "0x0",
    txHash: "0x0",
    logIndex: 0,
  });

  it("tries newest first and returns the first accepted", async () => {
    const visited: bigint[] = [];
    const checkpoints = [cp(1n), cp(3n), cp(2n)]; // deliberately unsorted
    const selected = await selectCheckpoint(checkpoints, async (c) => {
      visited.push(c.blockNumber);
      return c.blockNumber === 2n;
    });
    expect(visited).toEqual([3n, 2n]); // stops as soon as 2n accepts
    expect(selected).toEqual(cp(2n));
  });

  it("returns null when nothing is accepted", async () => {
    const selected = await selectCheckpoint(
      [cp(1n), cp(2n)],
      async () => false,
    );
    expect(selected).toBeNull();
  });
});
