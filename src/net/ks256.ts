/**
 * The `fetch_ks256_attestation` chain read: `eth_chainId`, then
 * `eth_getBlockByNumber` for the chosen block, then `eth_getCode` at the
 * root and `eth_call isValidSignature(digest, signature)` at that block's
 * number. Every state read is pinned to the block whose number and hash the
 * attestation names, so anyone with RPC can re-run exactly that call.
 *
 * Refusals are structured problems, never an attestation: an EOA root (no
 * code; it verifies by ecrecover and needs none), a revert, a short or
 * malformed return, or any return other than the ERC-1271 magic value.
 * `NetError` is thrown only when no response was obtained at all.
 */
import { encodeIsValidSignatureCall } from "@forestrie/chain-rpc";
import { erc1271MagicFromReturn, hexToBigint } from "../core/index.js";
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
      chainId: number;
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
  if (typeof chainIdCall.result !== "string") {
    return rpcProblem(undefined, "eth_chainId result is not a hex string");
  }
  const chainId = Number(hexToBigint(chainIdCall.result));
  if (
    input.expectedChainId !== undefined &&
    chainId !== input.expectedChainId
  ) {
    return {
      kind: "problem",
      problem: {
        code: "rpc_chain_id_mismatch",
        expected: input.expectedChainId,
        actual: chainId,
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
  if (typeof block.number !== "string" || typeof block.hash !== "string") {
    return rpcProblem(
      undefined,
      "eth_getBlockByNumber result missing number/hash",
    );
  }
  const blockNumber = hexToBigint(block.number);
  if (input.block !== undefined && blockNumber !== input.block) {
    return rpcProblem(
      undefined,
      `eth_getBlockByNumber returned block ${blockNumber}, not the ${input.block} asked for`,
    );
  }
  // Pin to the number the block reported, whether it was asked for or latest.
  const blockHex = block.number;

  const codeCall = await callJsonRpc(
    input.rpcUrl,
    3,
    "eth_getCode",
    [input.root, blockHex],
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
      blockHex,
    ],
    opts,
  );
  if (!call.ok) {
    const failure = call.result.problem;
    // A node that answered 2xx with a JSON-RPC error is reporting the call
    // itself failing (a revert); anything else is the endpoint, not the contract.
    if (failure.code === "rpc_error" && failure.status === 200) {
      return {
        kind: "problem",
        problem: {
          code: "erc1271_call_failed",
          message: `isValidSignature at ${input.root} failed at block ${blockNumber}: ${failure.message}`,
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
        message: `isValidSignature at ${input.root} did not return the ERC-1271 magic value 0x1626ba7e at block ${blockNumber} (returned ${call.result}): the certificate's signature is not valid under the contract's signers there`,
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
