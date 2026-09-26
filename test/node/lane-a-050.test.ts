/**
 * The re-genesised lane A (2026-09-22) and @forestrie/mcp-verify 0.5.0's
 * own registration, replayed from `test/fixtures/lane-a-0.5.0/` — the pair
 * the README's worked example names. Everything else in the suite keeps
 * replaying the 2026-09-13 recordings under `test/fixtures/lane-a/`, which
 * name a forest the lane no longer serves; this file is what shows the
 * example's coordinates are real: the status route redirects to the
 * receipt at massif height 14, the genesis binds the new contract, the
 * receipt verifies under the 0.5.0 bundle's log key, and under a chain
 * read of the new publications log it anchors — split-view ok — at the
 * recorded logState. No network: lane and chain both replay.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, type Deps } from "../../src/node/server.js";
import {
  LANE_A_050_DIR,
  createChainReplay,
  createLaneAReplay,
} from "../net/replay.js";

const COORDS = JSON.parse(
  readFileSync(path.join(LANE_A_050_DIR, "coordinates.json"), "utf8"),
) as {
  baseUrl: string;
  bootstrapLogId: string;
  publicationsLogId: string;
  contentHashSha256: string;
  entryId: string;
  massifHeight: number;
  receiptUrl: string;
  chainId: number;
  univocity: string;
  logStateBlock: number;
  logStateSize: number;
};
const RPC_URL = "https://rpc.example/anything";
const b64 = (name: string) =>
  readFileSync(path.join(LANE_A_050_DIR, name)).toString("base64");
const text = (name: string) =>
  readFileSync(path.join(LANE_A_050_DIR, name), "utf8").trim();

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function withClient<T>(
  deps: Deps,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(deps);
  await server.connect(st);
  const client = new Client({ name: "lane-a-050", version: "0" });
  await client.connect(ct);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

describe("lane A after the 2026-09-20 reset, replayed: the 0.5.0 pair", () => {
  it("query_registration redirects to the receipt at massif height 14 with the bundle's entry id", async () => {
    const lane = await createLaneAReplay(LANE_A_050_DIR);
    const r = await withClient({ fetchImpl: lane.fetch, env: {} }, (c) =>
      c.callTool({
        name: "query_registration",
        arguments: {
          baseUrl: COORDS.baseUrl,
          bootstrapLogId: COORDS.bootstrapLogId,
          logId: COORDS.publicationsLogId,
          contentHash: COORDS.contentHashSha256,
        },
      }),
    );
    const s = r.structuredContent as {
      status: string;
      receiptUrl: string;
      entryId: string;
    };
    expect(s.status).toBe("receipt-available");
    expect(s.receiptUrl).toBe(COORDS.receiptUrl);
    expect(s.receiptUrl).toContain(`/${COORDS.massifHeight}/entries/`);
    expect(s.entryId).toBe(COORDS.entryId);
    expect(text("entry-id.txt")).toBe(COORDS.entryId);
  });

  it("fetch_genesis decodes the new forest's binding: chain 84532, univocity 0xE22c…Cd58", async () => {
    const lane = await createLaneAReplay(LANE_A_050_DIR);
    const r = await withClient({ fetchImpl: lane.fetch, env: {} }, (c) =>
      c.callTool({
        name: "fetch_genesis",
        arguments: { baseUrl: COORDS.baseUrl, logId: COORDS.bootstrapLogId },
      }),
    );
    const s = r.structuredContent as {
      chainBinding: {
        univocity: string;
        chainId: number;
        forestLogId: string;
      };
    };
    expect(s.chainBinding.chainId).toBe(COORDS.chainId);
    expect(s.chainBinding.univocity.toLowerCase()).toBe(COORDS.univocity);
    expect(s.chainBinding.forestLogId).toBe(COORDS.bootstrapLogId);
  });

  it("verify_fetched_receipt passes under the 0.5.0 bundle's log key", async () => {
    const lane = await createLaneAReplay(LANE_A_050_DIR);
    const r = await withClient({ fetchImpl: lane.fetch, env: {} }, (c) =>
      c.callTool({
        name: "verify_fetched_receipt",
        arguments: {
          receiptUrl: COORDS.receiptUrl,
          entryId: COORDS.entryId,
          payload: { base64: b64("statement.cose") },
          trust: {
            root: "known-log-key",
            keyXy: { base64: text("log-key.xy.b64") },
          },
        },
      }),
    );
    const s = r.structuredContent as {
      ok: boolean;
      root: string;
      questions: Record<string, { status: string }>;
    };
    expect(s.ok).toBe(true);
    expect(s.root).toBe("known-log-key");
    expect(s.questions["sealing"]?.status).toBe("ok");
    expect(s.questions["attribution"]?.status).toBe("ok");
  });

  it("under a chain read of the new publications log: split-view ok, anchored at the recorded logState (size 3, one peak)", async () => {
    const lane = await createLaneAReplay(LANE_A_050_DIR);
    const chain = await createChainReplay(
      undefined,
      path.join(LANE_A_050_DIR, `logState.${COORDS.logStateBlock}.json`),
    );
    const fetchImpl = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> =>
      requestUrl(input) === RPC_URL
        ? chain.fetch(input, init)
        : lane.fetch(input, init)) as unknown as typeof fetch;
    const r = await withClient({ fetchImpl, env: {} }, (c) =>
      c.callTool({
        name: "verify_fetched_receipt",
        arguments: {
          receiptUrl: COORDS.receiptUrl,
          entryId: COORDS.entryId,
          payload: { base64: b64("statement.cose") },
          trust: {
            root: "known-accumulator",
            chain: {
              genesis: { base64: b64("genesis.cbor") },
              rpcUrl: RPC_URL,
              logId: COORDS.publicationsLogId,
            },
          },
        },
      }),
    );
    const s = r.structuredContent as {
      ok: boolean;
      root: string;
      questions: Record<string, { status: string }>;
      anchor?: {
        anchored: boolean;
        anchoredSize: string;
        blockNumber: string;
      };
      diagnostics: { code: string }[];
    };
    expect(s.ok).toBe(true);
    expect(s.root).toBe("known-accumulator");
    expect(s.questions["split-view"]?.status).toBe("ok");
    expect(s.anchor?.anchored).toBe(true);
    expect(String(s.anchor?.anchoredSize)).toBe(String(COORDS.logStateSize));
    expect(String(s.anchor?.blockNumber)).toBe(String(COORDS.logStateBlock));
    expect(s.diagnostics.map((d) => d.code)).toContain("root_read_from_chain");
    expect(chain.calls).toHaveLength(3);
    expect(lane.calls).toHaveLength(1);
  });
});
