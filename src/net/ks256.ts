/**
 * The `fetch_ks256_attestation` chain read: `eth_chainId`, then
 * `eth_getBlockByNumber` for the chosen block, then `eth_getCode` at the
 * root and `eth_call isValidSignature(digest, signature)`, both pinned by
 * block HASH (EIP-1898, `requireCanonical`), so the hash the attestation
 * names is the state that was read and anyone with RPC can re-run the call.
 *
 * Refusals are structured problems, never an attestation: an EOA root (no
 * code; it verifies by ecrecover and needs none), a revert, a short or
 * malformed return, or any return other than the ERC-1271 magic value.
 * `NetError` is thrown only when no response was obtained at all.
 */
import { encodeIsValidSignatureCall } from "@forestrie/chain-rpc";
import { erc1271MagicFromReturn } from "../core/index.js";
import { callJsonRpc, type LogStateProblem } from "./chain.js";
import type { FetchOptions } from "./types.js";

export type ReadKs256AttestationInput = {
  rpcUrl: string;
  /** `0x` + 40 lowercase hex. */
  root: string;
  digest: Uint8Array;
  signature: Uint8Array;
  /** Checked against `eth_chainId` before any further call, if given. */
  expectedChainId?: number;
  /** Absent: the latest block, whose number every later call is pinned to. */
  block?: bigint;
};

export type Ks256Problem =
  | LogStateProblem
  | { code: "block_not_found"; message: string }
  | { code: "no_contract_code"; message: string }
  | { code: "erc1271_call_failed"; message: string }
  | { code: "erc1271_not_valid"; message: string };

export type ReadKs256AttestationResult =
  | {
      kind: "ok";
      chainId: bigint;
      blockNumber: bigint;
      blockHash: string;
      magic: Uint8Array;
      at: string;
      rpcUrl: string;
    }
  | { kind: "problem"; problem: Ks256Problem };

function rpcProblem(
  status: number | undefined,
  message: string,
): { kind: "problem"; problem: Ks256Problem } {
  return {
    kind: "problem",
    problem: {
      code: "rpc_error",
      ...(status !== undefined ? { status } : {}),
      message,
    },
  };
}

/** A JSON-RPC quantity: `0x` and at least one hex digit. No decimal, no
 *  bare `0x`, never silently coerced. */
function quantity(value: unknown): bigint | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)
    ? BigInt(value)
    : undefined;
}

export async function readKs256Attestation(
  input: ReadKs256AttestationInput,
  opts?: FetchOptions,
): Promise<ReadKs256AttestationResult> {
  const chainIdCall = await callJsonRpc(
    input.rpcUrl,
    1,
    "eth_chainId",
    [],
    opts,
  );
  if (!chainIdCall.ok) return chainIdCall.result;
  const chainId = quantity(chainIdCall.result);
  if (chainId === undefined) {
    return rpcProblem(
      undefined,
      `eth_chainId result is not a hex quantity: ${JSON.stringify(chainIdCall.result)}`,
    );
  }
  if (
    input.expectedChainId !== undefined &&
    chainId !== BigInt(input.expectedChainId)
  ) {
    return {
      kind: "problem",
      problem: {
        code: "rpc_chain_id_mismatch",
        expected: input.expectedChainId,
        actual: Number(chainId),
      },
    };
  }

  const tag =
    input.block === undefined ? "latest" : `0x${input.block.toString(16)}`;
  const blockCall = await callJsonRpc(
    input.rpcUrl,
    2,
    "eth_getBlockByNumber",
    [tag, false],
    opts,
  );
  if (!blockCall.ok) return blockCall.result;
  if (blockCall.result === null || blockCall.result === undefined) {
    return {
      kind: "problem",
      problem: {
        code: "block_not_found",
        message: `the RPC has no block ${input.block ?? "latest"}`,
      },
    };
  }
  const block = blockCall.result as { number?: unknown; hash?: unknown };
  const blockNumber = quantity(block.number);
  if (
    blockNumber === undefined ||
    typeof block.hash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(block.hash)
  ) {
    return rpcProblem(
      undefined,
      "eth_getBlockByNumber result needs a hex quantity number and a 32-byte hex hash",
    );
  }
  if (input.block !== undefined && blockNumber !== input.block) {
    return rpcProblem(
      undefined,
      `eth_getBlockByNumber returned block ${blockNumber}, not the ${input.block} asked for`,
    );
  }
  // Pin by the hash the attestation will name (EIP-1898).
  const at = { blockHash: block.hash, requireCanonical: true };

  const codeCall = await callJsonRpc(
    input.rpcUrl,
    3,
    "eth_getCode",
    [input.root, at],
    opts,
  );
  if (!codeCall.ok) return codeCall.result;
  if (typeof codeCall.result !== "string") {
    return rpcProblem(undefined, "eth_getCode result is not a hex string");
  }
  if (/^(0x)?0*$/i.test(codeCall.result.trim())) {
    return {
      kind: "problem",
      problem: {
        code: "no_contract_code",
        message: `no contract code at ${input.root} at block ${blockNumber}: an EOA root verifies by ecrecover and needs no attestation`,
      },
    };
  }

  const call = await callJsonRpc(
    input.rpcUrl,
    4,
    "eth_call",
    [
      {
        to: input.root,
        data: encodeIsValidSignatureCall(input.digest, input.signature),
      },
      at,
    ],
    opts,
  );
  if (!call.ok) {
    const failure = call.result.problem;
    // `ethRpc` keeps only the JSON-RPC error's message, so a revert is
    // recognised by it; any other error (unknown block, header not found,
    // an endpoint refusing) is the endpoint's, not the contract's.
    if (failure.code === "rpc_error" && /revert/i.test(failure.message)) {
      return {
        kind: "problem",
        problem: {
          code: "erc1271_call_failed",
          message: `isValidSignature at ${input.root} reverted at block ${blockNumber}: ${failure.message}`,
        },
      };
    }
    return call.result;
  }
  if (typeof call.result !== "string") {
    return rpcProblem(undefined, "eth_call result is not a hex string");
  }
  const magic = erc1271MagicFromReturn(call.result);
  if (magic === undefined) {
    return {
      kind: "problem",
      problem: {
        code: "erc1271_not_valid",
        message: `isValidSignature at ${input.root} did not return exactly the one 32-byte word 0x1626ba7e followed by 28 zero bytes at block ${blockNumber} (returned ${call.result}): the certificate's signature is not valid under the contract's signers there`,
      },
    };
  }

  return {
    kind: "ok",
    chainId,
    blockNumber,
    blockHash: block.hash,
    magic,
    at: new Date().toISOString(),
    rpcUrl: input.rpcUrl,
  };
}
