import { decodeKnownAccumulator } from "@forestrie/receipt-verify";
import { describe, expect, it } from "vitest";
import {
  ChainError,
  buildKnownAccumulator,
  decodeLogStateResult,
} from "../../src/core/index.js";

/** Big-endian 32-byte word, as hex (no 0x). */
function word(n: bigint | number): string {
  return BigInt(n).toString(16).padStart(64, "0");
}

/** 32-byte word from a byte-fill value (e.g. peak(0x11) = 0x1111...11). */
function fill(byte: number): string {
  return byte.toString(16).padStart(2, "0").repeat(32);
}

/**
 * Hand-built ABI encoding of `logState(bytes32)`'s dynamic tuple
 * `(bytes32[] accumulator, uint64 size)`, for two peaks and size 5.
 *
 * word0            offset to tuple (32)
 * tuple+0          offset to array, relative to tuple base (64)
 * tuple+32         size (5)
 * array base+0     array length (2)
 * array base+32    peak 1
 * array base+64    peak 2
 */
function buildLogStateHex(peaks: string[], size: bigint | number): string {
  const arrayWords = [word(peaks.length), ...peaks].join("");
  const tupleWords = [word(64), word(size), arrayWords].join("");
  return "0x" + word(32) + tupleWords;
}

describe("decodeLogStateResult", () => {
  it("decodes two peaks and size 5", () => {
    const peak1 = fill(0x11);
    const peak2 = fill(0x22);
    const hex = buildLogStateHex([peak1, peak2], 5);

    const { accumulator, size } = decodeLogStateResult(hex);

    expect(size).toBe(5n);
    expect(accumulator).toHaveLength(2);
    expect(Buffer.from(accumulator[0]!).toString("hex")).toBe(peak1);
    expect(Buffer.from(accumulator[1]!).toString("hex")).toBe(peak2);
  });

  it("decodes zero peaks", () => {
    const hex = buildLogStateHex([], 0);
    const { accumulator, size } = decodeLogStateResult(hex);
    expect(accumulator).toHaveLength(0);
    expect(size).toBe(0n);
  });

  it("throws on an empty result", () => {
    expect(() => decodeLogStateResult("0x")).toThrow(ChainError);
    expect(() => decodeLogStateResult("")).toThrow(ChainError);
  });

  it("throws on a truncated result", () => {
    const full = buildLogStateHex([fill(0x11), fill(0x22)], 5);
    // Cut it off partway through the second peak.
    const truncated = full.slice(0, full.length - 20);
    expect(() => decodeLogStateResult(truncated)).toThrow(ChainError);
  });

  it("throws when the result is too short even for the header words", () => {
    expect(() => decodeLogStateResult("0x" + word(32))).toThrow(ChainError);
  });
});

describe("buildKnownAccumulator", () => {
  it("round-trips through decodeKnownAccumulator", () => {
    const peak = new Uint8Array(32).fill(0xab);
    const blockHash = new Uint8Array(32).fill(0xcd);
    const bytes = buildKnownAccumulator({
      chainId: 84532n,
      univocity: "0x678768643B4667aEDcB313cC81624aA560b7f0Ca",
      logId: "660e8400-e29b-41d4-a716-446655440001",
      size: 5n,
      accumulator: [peak],
      blockNumber: 1_234_567n,
      blockHash,
    });

    const decoded = decodeKnownAccumulator(bytes);
    expect(decoded.version).toBe(1);
    expect(decoded.chainId).toBe(84532n);
    expect(Buffer.from(decoded.univocity).toString("hex")).toBe(
      "678768643b4667aedcb313cc81624aa560b7f0ca",
    );
    expect(Buffer.from(decoded.logId).toString("hex")).toBe(
      "660e8400e29b41d4a716446655440001".padStart(64, "0"),
    );
    expect(decoded.size).toBe(5n);
    expect(decoded.accumulator).toHaveLength(1);
    expect(Buffer.from(decoded.accumulator[0]!)).toEqual(Buffer.from(peak));
    expect(decoded.blockNumber).toBe(1_234_567n);
    expect(Buffer.from(decoded.blockHash)).toEqual(Buffer.from(blockHash));
  });
});
