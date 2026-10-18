/**
 * The pure half of `fetch_ks256_attestation`: reading the contract's answer
 * to `isValidSignature` and assembling the attestation `@forestrie/mcp-verify`
 * consumes. No network here; `src/net/ks256.ts` makes the chain reads and
 * hands the results to these.
 *
 * The attestation CBOR itself (canonical, RFC 8949 §4.2) is encoded by
 * `@forestrie/receipt-verify`'s `encodeKs256Attestation`; this package does
 * not carry a second encoder.
 */
import {
  ERC1271_MAGIC_VALUE,
  encodeKs256Attestation,
} from "@forestrie/receipt-verify";
import { keccak_256 } from "@noble/hashes/sha3";
import { hexToBytes32, hexToBytesRaw, stripHexPrefix } from "./chain.js";

/** The ERC-1271 magic value, if `returnHex` is exactly one 32-byte ABI
 *  word equal to `0x1626ba7e` followed by 28 zero bytes (what a `bytes4`
 *  return is, and OpenZeppelin SignatureChecker's own test: length 32 and
 *  word == magic). Anything else is `undefined`: a short return, dirty
 *  padding, extra words, odd-length hex, or the call's own calldata echoed
 *  back by a fallback (`0x1626ba7e` is also the selector). */
export function erc1271MagicFromReturn(
  returnHex: string,
): Uint8Array | undefined {
  const hex = stripHexPrefix(returnHex.trim()).toLowerCase();
  if (hex.length !== 64 || !/^[0-9a-f]+$/.test(hex)) return undefined;
  const word = hexToBytesRaw(hex);
  for (let i = 0; i < word.length; i++) {
    const want = i < ERC1271_MAGIC_VALUE.length ? ERC1271_MAGIC_VALUE[i] : 0;
    if (word[i] !== want) return undefined;
  }
  return word.slice(0, ERC1271_MAGIC_VALUE.length);
}

export type Ks256AttestationFields = {
  /** Decimal string. */
  chainId: string;
  /** `0x` + 40 hex: the contract root the call was made to. */
  address: string;
  /** `0x` + 64 hex. */
  digest: string;
  /** `0x` + 64 hex: keccak256 of the signature the call carried. */
  signatureHash: string;
  /** Decimal string. */
  blockNumber: string;
  /** `0x` + 64 hex. */
  blockHash: string;
  /** `0x1626ba7e`. */
  magic: string;
};

function hex0x(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/** Encode the attestation for a successful, block-pinned
 *  `isValidSignature` read, and return the same fields readable. */
export function buildKs256Attestation(input: {
  chainId: bigint;
  /** 20-byte root address. */
  address: Uint8Array;
  digest: Uint8Array;
  signature: Uint8Array;
  blockNumber: bigint;
  /** `0x` hex block hash as the RPC returned it. */
  blockHash: string;
  magic: Uint8Array;
}): { bytes: Uint8Array; fields: Ks256AttestationFields } {
  const signatureHash = keccak_256(input.signature);
  const blockHash = hexToBytes32(input.blockHash);
  const bytes = encodeKs256Attestation({
    version: 1,
    chainId: input.chainId,
    address: input.address,
    digest: input.digest,
    signatureHash,
    blockNumber: input.blockNumber,
    blockHash,
    magic: input.magic,
  });
  return {
    bytes,
    fields: {
      chainId: input.chainId.toString(),
      address: hex0x(input.address),
      digest: hex0x(input.digest),
      signatureHash: hex0x(signatureHash),
      blockNumber: input.blockNumber.toString(),
      blockHash: hex0x(blockHash),
      magic: hex0x(input.magic),
    },
  };
}
