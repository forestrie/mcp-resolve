/**
 * Pure ABI decoding of the `logState(bytes32)` return, and the
 * `known-accumulator` snapshot builder that byte-matches
 * `@forestrie/receipt-verify`'s `encodeKnownAccumulator`. No `fetch`, no
 * `node:*` — `src/net` makes the
 * `eth_call` itself and hands this module the returned hex; this module
 * only decodes and re-encodes bytes.
 */
import { encodeKnownAccumulator } from "@forestrie/receipt-verify";
import { normalizeAddress, toContractLogId } from "./endpoints.js";

/** A pure decode/encode failure over already-fetched chain bytes — never
 *  thrown for an RPC error itself, which is `src/net`'s concern. */
export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

/** Strip a leading `0x`/`0X`. Exported so `history.ts`'s
 *  `CheckpointPublished` event-data decode — the same word-offset ABI
 *  shape as `decodeLogStateResult` below — shares this instead of a second
 *  copy (AGENTS.md: no duplicated hex utilities). */
export function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** Bare (no `0x`) hex -> bytes. Exported for the same reason as
 *  `stripHexPrefix`. */
export function hexToBytesRaw(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBigint(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt(hex);
}

/** Parse a standalone `0x`-prefixed hex value (e.g. an RPC `eth_chainId`
 *  result) to a bigint. */
export function hexToBigint(hex: string): bigint {
  const clean = hex.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(clean)) {
    throw new ChainError(`not hex: '${hex}'`);
  }
  return clean === "0x" ? 0n : BigInt(clean);
}

/** Parse a standalone hex value (e.g. an RPC block hash) to exactly 32
 *  bytes, left-zero-padded. */
export function hexToBytes32(hex: string): Uint8Array {
  const clean = stripHexPrefix(hex.trim());
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length > 64) {
    throw new ChainError(`not a 32-byte hex value: '${hex}'`);
  }
  return hexToBytesRaw(clean.padStart(64, "0"));
}

export const WORD_BYTES = 32;

/** Read one 32-byte word at `byteOffset`, throwing on truncation. Exported
 *  for `history.ts`'s `CheckpointPublished` decode (see `stripHexPrefix`). */
export function readBytes32(
  bytes: Uint8Array,
  byteOffset: number,
): Uint8Array {
  if (byteOffset < 0 || byteOffset + WORD_BYTES > bytes.length) {
    throw new ChainError("truncated ABI-encoded data");
  }
  return bytes.slice(byteOffset, byteOffset + WORD_BYTES);
}

/** Exported for the same reason as `readBytes32`. */
export function readWord(bytes: Uint8Array, byteOffset: number): bigint {
  return bytesToBigint(readBytes32(bytes, byteOffset));
}

/**
 * Decode the `eth_call` return for `logState(bytes32)`: the dynamic tuple
 * `(bytes32[] accumulator, uint64 size)` (byte-compatible with
 * `forestrie fetch-accumulator`'s `decodeLogStateResult`).
 *
 * Layout: word 0 is the byte offset to the tuple; at the tuple base, the
 * first word is the byte offset (relative to the tuple base) to the
 * `accumulator` array and the second word is `size`; the array is a length
 * word followed by that many 32-byte elements.
 */
export function decodeLogStateResult(resultHex: string): {
  accumulator: Uint8Array[];
  size: bigint;
} {
  const hex = stripHexPrefix(resultHex.trim());
  if (hex.length === 0) {
    throw new ChainError("empty eth_call result");
  }
  const bytes = hexToBytesRaw(hex);

  const tupleBase = Number(readWord(bytes, 0));
  const arrOffset = Number(readWord(bytes, tupleBase));
  const size = readWord(bytes, tupleBase + WORD_BYTES);
  const arrBase = tupleBase + arrOffset;
  const arrLen = Number(readWord(bytes, arrBase));

  const accumulator: Uint8Array[] = [];
  for (let i = 0; i < arrLen; i++) {
    accumulator.push(
      readBytes32(bytes, arrBase + WORD_BYTES + i * WORD_BYTES),
    );
  }
  return { accumulator, size };
}

/**
 * Build a `known-accumulator` snapshot (the bytes the verifier's
 * `known-accumulator` root consumes) from a chain read, via
 * `@forestrie/receipt-verify`'s `encodeKnownAccumulator`. `univocity` and
 * `logId` are the caller's raw strings — normalized here the same way
 * `endpoints.ts` normalizes them elsewhere, so callers don't have to.
 */
export function buildKnownAccumulator(input: {
  chainId: bigint;
  univocity: string;
  logId: string;
  size: bigint;
  accumulator: Uint8Array[];
  blockNumber: bigint;
  blockHash: Uint8Array;
}): Uint8Array {
  const univocityBytes = hexToBytesRaw(
    normalizeAddress(input.univocity).slice(2),
  );
  const logIdBytes = hexToBytesRaw(toContractLogId(input.logId).slice(2));
  return encodeKnownAccumulator({
    version: 1,
    chainId: input.chainId,
    univocity: univocityBytes,
    logId: logIdBytes,
    size: input.size,
    accumulator: input.accumulator,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
  });
}
