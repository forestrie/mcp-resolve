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

/** The first four bytes of an `isValidSignature` return word, if it is the
 *  ERC-1271 magic value `0x1626ba7e`; otherwise `undefined`. A short,
 *  malformed or non-magic return is never an attestation. */
export function erc1271MagicFromReturn(
  returnHex: string,
): Uint8Array | undefined {
  const hex = stripHexPrefix(returnHex.trim());
  // ABI return of `bytes4` is one 32-byte word, left-aligned.
  if (hex.length < 8 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  const head = hexToBytesRaw(hex.slice(0, 8));
  for (let i = 0; i < ERC1271_MAGIC_VALUE.length; i++) {
    if (head[i] !== ERC1271_MAGIC_VALUE[i]) return undefined;
  }
  return head;
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
