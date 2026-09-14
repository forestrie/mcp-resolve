/**
 * The MCP surface, over the SDK's in-memory transport pair.
 *
 * In-memory rather than a spawned process: it is faster and it exercises the
 * same `Server`/`Client` protocol code. The one thing it CANNOT catch is a
 * stray `console.log` corrupting the stdio framing — that needs a real
 * process, and it lives in `pnpm run check:stdio-clean`.
 *
 * This file runs under the forbidden-fetch global (N6 gate 2): every
 * end-to-end call below goes through `createServer({ fetchImpl, env: {} })`
 * with a replayed fake `fetch` over the frozen fixtures
 * (`test/fixtures/lane-a/`, `test/fixtures/chain/`), never
 * `globalThis.fetch`.
 *
 * This is a SMOKE test: `tools/list` shape, one identify check, one
 * happy-path call per fetch tool, and one input-validation check. The full
 * per-tool test matrix (429s, chain mismatches, malformed inputs,
 * `verify_fetched_receipt`'s composed paths, live-project assertions) is
 * step 2.5's `test/node/tools.test.ts`.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/node/server.js";
import { PACKAGE_VERSION, type ToolName } from "../../src/core/index.js";
import { createChainReplay, createLaneAReplay } from "../net/replay.js";

const repoRoot = new URL("../../", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8")) as {
  version: string;
};

const BASE_URL = "https://api-a.forest-2.forestrie.dev";
const BOOTSTRAP_LOG_ID = "67876864-3b46-67ae-dcb3-13cc81624aa5";
const PUBLICATIONS_LOG_ID = "e8345800-a747-4e62-9409-61622b836f1f";
const SELF_CONTENT_HASH =
  "7c29bb57bae35044f722f4842c91a38b6fae51a5405a95caf9b27c9b894e2166";
const MASSIF_HEIGHT = 14;
const ENTRY_ID = "a09a6337ee0009000000000000000008";
const RECEIPT_SHA256 =
  "55e7edf2a65c39681cb01fc1d6b5b6bf9273b82bd741954be63c8d6f2ef85fbe";

const RPC_URL = "https://rpc.example/anything";
const UNIVOCITY = "0x678768643b4667aedcb313cc81624aa560b7f0ca";
const CHAIN_ID = 84532;

const TOOL_NAMES: ToolName[] = [
  "fetch_scitt_configuration",
  "query_registration",
  "fetch_receipt",
  "fetch_genesis",
  "fetch_accumulator",
  "fetch_checkpoint_history",
  "verify_fetched_receipt",
];

const N5_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** One fake `fetch` that dispatches between the lane-A HTTP replay (by
 *  exact URL) and the chain JSON-RPC replay (by the one RPC URL every
 *  chain call in this file uses) — `createServer` takes a single
 *  `fetchImpl`, so both fixtures are served through it. */
async function createCombinedReplay(): Promise<typeof fetch> {
  const laneA = await createLaneAReplay();
  const chain = await createChainReplay();

  const combined = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url === RPC_URL) return chain.fetch(input, init);
    return laneA.fetch(input, init);
  }) as unknown as typeof fetch;

  return combined;
}

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const fetchImpl = await createCombinedReplay();
  const server = createServer({ fetchImpl, env: {} });
  await server.connect(serverTransport);
  client = new Client({ name: "mcp-resolve-test", version: "0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

describe("initialize", () => {
  /**
   * The version is read from package.json here so that a forgotten bump
   * fails as a red test rather than as a lie in `initialize`'s serverInfo.
   */
  it("reports the package version", () => {
    expect(client.getServerVersion()).toMatchObject({
      name: "forestrie-mcp-resolve",
      version: pkg.version,
    });
  });

  it("PACKAGE_VERSION agrees with package.json#version", () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});

describe("tools/list", () => {
  it("is exactly the seven tools, each N5-annotated with a non-empty description", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(tool.annotations).toEqual(N5_ANNOTATIONS);
      expect(typeof tool.description).toBe("string");
      expect((tool.description ?? "").length).toBeGreaterThan(0);
    }
  });
});

describe("fetch_scitt_configuration", () => {
  it("fetches the lane-a well-known document", async () => {
    const result = await client.callTool({
      name: "fetch_scitt_configuration",
      arguments: { baseUrl: BASE_URL },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      configuration: { serviceId: string };
      supports: unknown;
      provenance: unknown;
    };
    expect(structured.configuration.serviceId).toBe("canopy-dev-1");
    expect(structured.supports).toBeDefined();
    expect(structured.provenance).toBeDefined();
  });

  it("reports a missing_input problem, isError:false, when baseUrl is omitted and the environment is empty", async () => {
    const result = await client.callTool({
      name: "fetch_scitt_configuration",
      arguments: {},
    });

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { code: string };
    };
    expect(structured.problem.code).toBe("missing_input");
  });
});

describe("fetch_receipt", () => {
  it("fetches the self receipt by receiptUrl", async () => {
    const laneA = await createLaneAReplay();
    const result = await client.callTool({
      name: "fetch_receipt",
      arguments: { receiptUrl: laneA.urls["receipt-self"] },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      receipt: { sha256: string };
      decoded: unknown;
    };
    expect(structured.receipt.sha256).toBe(RECEIPT_SHA256);
    expect(structured.decoded).toBeDefined();
  });
});

describe("fetch_genesis", () => {
  it("fetches the forest genesis and decodes the chain binding", async () => {
    const result = await client.callTool({
      name: "fetch_genesis",
      arguments: { baseUrl: BASE_URL, logId: BOOTSTRAP_LOG_ID },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      chainBinding: { univocity: string; chainId: number };
    };
    expect(structured.chainBinding.univocity).toBe(UNIVOCITY);
    expect(structured.chainBinding.chainId).toBe(CHAIN_ID);
  });
});

describe("query_registration", () => {
  it("reports receipt-available for the self content hash", async () => {
    const result = await client.callTool({
      name: "query_registration",
      arguments: {
        baseUrl: BASE_URL,
        bootstrapLogId: BOOTSTRAP_LOG_ID,
        logId: PUBLICATIONS_LOG_ID,
        contentHash: SELF_CONTENT_HASH,
      },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      status: string;
      entryId: string;
    };
    expect(structured.status).toBe("receipt-available");
    expect(structured.entryId).toBe(ENTRY_ID);
    expect(MASSIF_HEIGHT).toBe(14); // the massif height the receipt was captured at (PROVENANCE.md)
  });
});

describe("fetch_accumulator", () => {
  it("reads the accumulator via the explicit chain form", async () => {
    const result = await client.callTool({
      name: "fetch_accumulator",
      arguments: {
        chain: {
          rpcUrl: RPC_URL,
          univocity: UNIVOCITY,
          logId: PUBLICATIONS_LOG_ID,
          chainId: CHAIN_ID,
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      accumulator: { size: number; blockNumber: number };
    };
    expect(structured.accumulator.size).toBe(11);
    expect(structured.accumulator.blockNumber).toBe(46770471);
  });
});
