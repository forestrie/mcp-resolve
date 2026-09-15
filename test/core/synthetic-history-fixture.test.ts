/**
 * The SYNTHESISED buried-peak fixture (`test/fixtures/synthetic/history/`):
 * its committed generator must be deterministic
 * (re-running it into a fresh directory reproduces the committed bytes
 * exactly — drift is red), and the fabricated `CheckpointPublished` event
 * and `logState` it writes must decode the way the real ones do.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeCheckpointPublishedLog,
  decodeLogStateResult,
} from "../../src/core/index.js";
import { generate } from "../fixtures/synthetic/history/generate.mjs";

const repoRoot = new URL("../../", import.meta.url).pathname;
const COMMITTED_DIR = path.join(
  repoRoot,
  "test",
  "fixtures",
  "synthetic",
  "history",
);

type RawLog = {
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
};

describe("the synthetic history fixture generator", () => {
  it("reproduces the committed files byte-for-byte", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "mcp-resolve-synth-"));
    try {
      generate(tmp);

      const committedFiles = readdirSync(COMMITTED_DIR).filter(
        (name) => name !== "generate.mjs" && name !== "generate.d.mts",
      );
      const generatedFiles = readdirSync(tmp).sort();
      expect(generatedFiles).toEqual(committedFiles.sort());

      for (const name of committedFiles) {
        const committed = readFileSync(path.join(COMMITTED_DIR, name));
        const generated = readFileSync(path.join(tmp, name));
        expect(generated.equals(committed)).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the synthetic fixture's bytes decode correctly", () => {
  const getLogs = JSON.parse(
    readFileSync(
      path.join(COMMITTED_DIR, "getLogs.46785145-46795144.json"),
      "utf8",
    ),
  ) as { response: { result: RawLog[] } };

  it("the fabricated CheckpointPublished log decodes to size 15, one peak", () => {
    expect(getLogs.response.result).toHaveLength(1);
    const cp = decodeCheckpointPublishedLog(getLogs.response.result[0]!);
    expect(cp.size).toBe(15n);
    expect(cp.accumulator).toHaveLength(1);
    expect(cp.logIndex).toBe(0);
  });

  it("the synthetic logState's eth_call result decodes to size 15, the same one peak", () => {
    const logState = JSON.parse(
      readFileSync(path.join(COMMITTED_DIR, "logState.46795144.json"), "utf8"),
    ) as {
      calls: { eth_call: { response: { result: string } } };
      blockNumber: string;
      blockHash: string;
    };
    const decoded = decodeLogStateResult(
      logState.calls.eth_call.response.result,
    );
    expect(decoded.size).toBe(15n);
    expect(decoded.accumulator).toHaveLength(1);

    const cp = decodeCheckpointPublishedLog(getLogs.response.result[0]!);
    expect(Buffer.from(decoded.accumulator[0]!)).toEqual(
      Buffer.from(cp.accumulator[0]!),
    );
    expect(logState.blockNumber).toBe("46795144");
  });

  it("the fabricated checkpoint does not hold any real checkpoint's peaks", () => {
    const cp = decodeCheckpointPublishedLog(getLogs.response.result[0]!);
    const realGetLogs = JSON.parse(
      readFileSync(
        path.join(
          repoRoot,
          "test",
          "fixtures",
          "chain",
          "history",
          "e8345800-a747-4e62-9409-61622b836f1f",
          "getLogs.46755145-46765144.json",
        ),
        "utf8",
      ),
    ) as { response: { result: RawLog[] } };
    const realSize11 = decodeCheckpointPublishedLog(
      realGetLogs.response.result[2]!,
    );
    const syntheticHex = Buffer.from(cp.accumulator[0]!).toString("hex");
    for (const peak of realSize11.accumulator) {
      expect(Buffer.from(peak).toString("hex")).not.toBe(syntheticHex);
    }
  });
});
