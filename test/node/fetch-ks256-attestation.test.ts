/**
 * `fetch_ks256_attestation`, end to end through the MCP server with a
 * hand-written JSON-RPC router in place of a chain. Everything is generated
 * at run time: the keys, the certificate, the receipt carrying it, the
 * genesis documents. Nothing recorded is committed and nothing here touches
 * a network.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  encodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";
import { encodeIsValidSignatureCall } from "@forestrie/chain-rpc";
import {
  ERC1271_MAGIC_VALUE,
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  decodeKs256Attestation,
} from "@forestrie/receipt-verify";
import { describe, expect, it } from "vitest";
import { createServer, type Deps } from "../../src/node/server.js";

const COSE_ALG_KS256 = -65799;
const COSE_ALG_ES256 = -7;
const CHAIN_ID = 84532;
const RPC_URL = "https://rpc.test.invalid";
const LATEST = 4567n;
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array): { b64: string } => ({
  b64: Buffer.from(b).toString("base64"),
});

/** A contract root: an address nobody holds a key for. */
const ROOT = new Uint8Array(20).map((_, i) => 0xc0 + i);
const ROOT_HEX = `0x${hex(ROOT)}`;

/** The certificate, as a Safe's delegation would be: KS256 alg, kid the
 *  root's address, signed (keccak over the Sig_structure) by one of its
 *  owners, a key that is not the root address. */
function buildCert(alg = COSE_ALG_KS256): {
  cert: Uint8Array;
  digest: Uint8Array;
  signature: Uint8Array;
} {
  const protectedBytes = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, alg],
      [4, ROOT],
    ]),
  );
  const payload = encodeCborDeterministic(
    new Map<number, unknown>([[1, "test delegation"]]),
  );
  const sigStructure = encodeSigStructure(
    protectedBytes,
    new Uint8Array(0),
    payload,
  );
  const digest = keccak_256(sigStructure);
  const owner = secp256k1.utils.randomPrivateKey();
  const sig = secp256k1.sign(digest, owner, { lowS: true });
  const signature = new Uint8Array(65);
  signature.set(sig.toCompactRawBytes(), 0);
  signature[64] = 27 + (sig.recovery ?? 0);
  const cert = encodeCborDeterministic([
    protectedBytes,
    new Map<number, unknown>(),
    payload,
    signature,
  ]);
  return { cert, digest, signature };
}

/** A COSE_Sign1 receipt shell carrying the label-1000 certificate (or none).
 *  Its signature and proof are not exercised: the tool only reads the
 *  certificate. */
function buildReceipt(cert: Uint8Array | undefined): Uint8Array {
  const unprotected = new Map<number, unknown>();
  if (cert !== undefined) unprotected.set(1000, cert);
  return encodeCborDeterministic([
    encodeCborDeterministic(new Map<number, unknown>([[1, COSE_ALG_ES256]])),
    unprotected,
    new Uint8Array(32),
    new Uint8Array(64),
  ]);
}

function buildGenesis(
  bootstrap: { alg: number; key: Uint8Array },
  chainId = CHAIN_ID,
): Uint8Array {
  const logId = new Uint8Array(32);
  logId.set(new Uint8Array(16).fill(0x77), 16);
  return encodeCborDeterministic(
    new Map<number, unknown>([
      [FOREST_GENESIS_LABEL_GENESIS_VERSION, 2],
      [FOREST_GENESIS_LABEL_GENESIS_ALG, bootstrap.alg],
      [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, bootstrap.key],
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, new Uint8Array(20).fill(0xab)],
      [FOREST_GENESIS_LABEL_CHAIN_ID, String(chainId)],
      [FOREST_GENESIS_LABEL_LOG_ID, logId],
    ]),
  );
}

type Call = { method: string; params: unknown[] };
type Behaviour = {
  chainId?: number;
  code?: string;
  /** What eth_call answers: a result word, or a JSON-RPC error message. */
  call?: { result: string } | { error: string };
};

const blockHash = (n: bigint): string =>
  `0x${n.toString(16).padStart(64, "0")}`;
const MAGIC_WORD = `0x${hex(ERC1271_MAGIC_VALUE)}${"00".repeat(28)}`;

/** The chain: a JSON-RPC router faked at fetch, recording every call. */
function fakeChain(behaviour: Behaviour = {}): {
  deps: Deps;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    calls.push({ method: body.method, params: body.params });
    const reply = (message: Record<string, unknown>): Response =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, ...message }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    switch (body.method) {
      case "eth_chainId":
        return reply({
          result: `0x${(behaviour.chainId ?? CHAIN_ID).toString(16)}`,
        });
      case "eth_getBlockByNumber": {
        const tag = body.params[0] as string;
        const n = tag === "latest" ? LATEST : BigInt(tag);
        return reply({
          result: { number: `0x${n.toString(16)}`, hash: blockHash(n) },
        });
      }
      case "eth_getCode":
        return reply({ result: behaviour.code ?? "0x6080604052" });
      case "eth_call": {
        const call = behaviour.call ?? { result: MAGIC_WORD };
        return "error" in call
          ? reply({ error: { code: 3, message: call.error } })
          : reply({ result: call.result });
      }
      default:
        return reply({ error: { code: -32601, message: body.method } });
    }
  }) as typeof fetch;
  return { deps: { fetchImpl, env: {} }, calls };
}

async function callTool(
  deps: Deps,
  args: Record<string, unknown>,
): Promise<{
  text: string;
  structured: Record<string, any>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(deps);
  await server.connect(serverTransport);
  const client = new Client({ name: "ks256-test", version: "0" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "fetch_ks256_attestation",
      arguments: args,
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    return {
      text: content[0]!.text,
      structured: result.structuredContent as Record<string, any>,
    };
  } finally {
    await client.close();
  }
}

async function es256Genesis(): Promise<Uint8Array> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return buildGenesis({ alg: COSE_ALG_ES256, key: raw.slice(1) });
}

describe("fetch_ks256_attestation", () => {
  const { cert, digest, signature } = buildCert();
  const receipt = buildReceipt(cert);
  const genesis = buildGenesis({ alg: COSE_ALG_KS256, key: ROOT });

  it("success at a chosen block: attestation decodes, every call pinned to it", async () => {
    const { deps, calls } = fakeChain();
    const { text, structured } = await callTool(deps, {
      receipt: b64(receipt),
      root: ROOT_HEX,
      rpcUrl: RPC_URL,
      block: 123,
    });

    expect(structured["problem"]).toBeUndefined();
    const attestation = decodeKs256Attestation(
      new Uint8Array(Buffer.from(structured["attestation"].base64, "base64")),
    );
    expect(structured["attestation"].byteLength).toBe(
      Buffer.from(structured["attestation"].base64, "base64").length,
    );
    expect(attestation).toMatchObject({
      version: 1,
      chainId: BigInt(CHAIN_ID),
      blockNumber: 123n,
    });
    expect(hex(attestation.address)).toBe(hex(ROOT));
    expect(hex(attestation.digest)).toBe(hex(digest));
    expect(hex(attestation.signatureHash)).toBe(hex(keccak_256(signature)));
    expect(hex(attestation.blockHash)).toBe(blockHash(123n).slice(2));
    expect(hex(attestation.magic)).toBe("1626ba7e");

    expect(structured["fields"]).toEqual({
      chainId: String(CHAIN_ID),
      address: ROOT_HEX,
      digest: `0x${hex(digest)}`,
      signatureHash: `0x${hex(keccak_256(signature))}`,
      blockNumber: "123",
      blockHash: blockHash(123n),
      magic: "0x1626ba7e",
    });
    expect(structured["provenance"]).toMatchObject({
      source: "chain-read",
      from: { rpcUrl: RPC_URL, root: ROOT_HEX, chainId: CHAIN_ID },
      block: { blockNumber: 123, blockHash: blockHash(123n) },
    });
    expect(structured["supports"].rows).toEqual([]);
    expect(text).toContain("valid under the contract's signers at block 123");
    expect(text).toContain("ks256Attestation");

    expect(calls.map((c) => c.method)).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_getCode",
      "eth_call",
    ]);
    expect(calls[1]!.params).toEqual(["0x7b", false]);
    expect(calls[2]!.params).toEqual([ROOT_HEX, "0x7b"]);
    expect(calls[3]!.params).toEqual([
      { to: ROOT_HEX, data: encodeIsValidSignatureCall(digest, signature) },
      "0x7b",
    ]);
  });

  it("by default asks at the latest block's own number, not the tag", async () => {
    const { deps, calls } = fakeChain();
    const { structured } = await callTool(deps, {
      receipt: b64(receipt),
      root: ROOT_HEX,
      rpcUrl: RPC_URL,
    });
    expect(structured["fields"].blockNumber).toBe(String(LATEST));
    const latestHex = `0x${LATEST.toString(16)}`;
    expect(calls[1]!.params).toEqual(["latest", false]);
    expect(calls[2]!.params[1]).toBe(latestHex);
    expect(calls[3]!.params[1]).toBe(latestHex);
  });

  it("takes the root and the chain from a KS256 genesis, and rpcUrl from the environment", async () => {
    const { deps } = fakeChain();
    const { structured } = await callTool(
      { ...deps, env: { FORESTRIE_RPC_URL: RPC_URL } },
      { receipt: b64(receipt), genesis: b64(genesis) },
    );
    expect(structured["fields"].address).toBe(ROOT_HEX);
    expect(structured["provenance"].binding).toBe("held-genesis");
    expect(structured["provenance"].from.rpcUrl).toBe(RPC_URL);
  });

  it("refuses an RPC on another chain than the genesis, before any further call", async () => {
    const { deps, calls } = fakeChain({ chainId: 1 });
    const { structured } = await callTool(deps, {
      receipt: b64(receipt),
      genesis: b64(genesis),
      rpcUrl: RPC_URL,
    });
    expect(structured["attestation"]).toBeUndefined();
    expect(structured["problem"]).toMatchObject({
      code: "rpc_chain_id_mismatch",
      expected: CHAIN_ID,
      actual: 1,
    });
    expect(calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });

  it("refuses when there is no contract code at the root (an EOA)", async () => {
    for (const code of ["0x", "0x0"]) {
      const { deps, calls } = fakeChain({ code });
      const { structured } = await callTool(deps, {
        receipt: b64(receipt),
        root: ROOT_HEX,
        rpcUrl: RPC_URL,
      });
      expect(structured["attestation"]).toBeUndefined();
      expect(structured["problem"].code).toBe("no_contract_code");
      expect(structured["problem"].message).toContain(
        "an EOA root verifies by ecrecover and needs no attestation",
      );
      expect(calls.map((c) => c.method)).not.toContain("eth_call");
    }
  });

  it("refuses a return that is not the ERC-1271 magic value", async () => {
    for (const result of [
      `0xffffffff${"00".repeat(28)}`,
      `0x${"00".repeat(32)}`,
      "0x",
      "0x1626ba",
      "not hex",
    ]) {
      const { deps } = fakeChain({ call: { result } });
      const { structured } = await callTool(deps, {
        receipt: b64(receipt),
        root: ROOT_HEX,
        rpcUrl: RPC_URL,
      });
      expect(structured["attestation"]).toBeUndefined();
      expect(structured["fields"]).toBeUndefined();
      expect(structured["problem"].code).toBe("erc1271_not_valid");
    }
  });

  it("refuses a reverting call", async () => {
    const { deps } = fakeChain({ call: { error: "execution reverted" } });
    const { structured } = await callTool(deps, {
      receipt: b64(receipt),
      root: ROOT_HEX,
      rpcUrl: RPC_URL,
    });
    expect(structured["attestation"]).toBeUndefined();
    expect(structured["problem"].code).toBe("erc1271_call_failed");
    expect(structured["problem"].message).toContain("execution reverted");
  });

  it("refuses a receipt with no delegation certificate, before any chain call", async () => {
    const { deps, calls } = fakeChain();
    const { structured } = await callTool(deps, {
      receipt: b64(buildReceipt(undefined)),
      root: ROOT_HEX,
      rpcUrl: RPC_URL,
    });
    expect(structured["problem"].message).toBe(
      "receipt carries no delegation certificate",
    );
    expect(calls).toEqual([]);
  });

  it("refuses a certificate that is not KS256, before any chain call", async () => {
    const { deps, calls } = fakeChain();
    const { structured } = await callTool(deps, {
      receipt: b64(buildReceipt(buildCert(COSE_ALG_ES256).cert)),
      root: ROOT_HEX,
      rpcUrl: RPC_URL,
    });
    expect(structured["problem"].code).toBe("receipt_not_ks256");
    expect(calls).toEqual([]);
  });

  it("refuses a genesis with an ES256 root when no root is given", async () => {
    const { deps, calls } = fakeChain();
    const { structured } = await callTool(deps, {
      receipt: b64(receipt),
      genesis: b64(await es256Genesis()),
      rpcUrl: RPC_URL,
    });
    expect(structured["attestation"]).toBeUndefined();
    expect(structured["problem"].code).toBe("genesis_root_not_ks256");
    expect(calls).toEqual([]);
  });

  it("with an explicit root, an ES256 genesis still supplies the chain", async () => {
    const { deps } = fakeChain({ chainId: 1 });
    const { structured } = await callTool(deps, {
      receipt: b64(receipt),
      root: ROOT_HEX,
      genesis: b64(await es256Genesis()),
      rpcUrl: RPC_URL,
    });
    expect(structured["problem"].code).toBe("rpc_chain_id_mismatch");
  });

  it("needs a root: neither root nor genesis is an input problem", async () => {
    const { deps, calls } = fakeChain();
    const { structured } = await callTool(deps, {
      receipt: b64(receipt),
      rpcUrl: RPC_URL,
    });
    expect(structured["problem"].code).toBe("missing_input");
    expect(calls).toEqual([]);
  });

  it("needs an rpcUrl from the argument or the environment", async () => {
    const { deps } = fakeChain();
    const { structured } = await callTool(deps, {
      receipt: b64(receipt),
      root: ROOT_HEX,
    });
    expect(structured["problem"].code).toBe("missing_input");
    expect(structured["problem"].message).toContain("FORESTRIE_RPC_URL");
  });
});
