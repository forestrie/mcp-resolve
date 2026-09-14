/**
 * The full per-tool test matrix over the frozen recorded-exchange fixtures
 * (`test/fixtures/lane-a/`, `test/fixtures/chain/`) and one synthesised 429
 * (`test/fixtures/synthetic/`, N8 — a 429 cannot be captured on demand).
 * `test/node/mcp-smoke.test.ts` already covers the happy-path shape once per
 * tool; this file is everything that smoke test explicitly deferred here:
 * annotations/description/title per tool, `supports`/`provenance` shape,
 * exact request counts, 429s, `NetError`, and `verify_fetched_receipt`'s
 * composed paths (supplied roots, the chain-read root in both binding
 * forms, the schema's refusal of a fetched-genesis root, and the grant
 * path).
 *
 * Every call goes through `createServer({ fetchImpl: <replay fake>, env })`
 * over the SDK's in-memory transport — never `globalThis.fetch`, which the
 * unit project's `test/setup/forbid-fetch.ts` already replaces with a
 * thrower (N6 gate 2).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { encodeCborDeterministic } from "@forestrie/encoding";
import { verifyReceipt } from "@forestrie/mcp-verify";
import { decodeKnownAccumulator } from "@forestrie/receipt-verify";
import { encodeGrantPayloadV0Canonical } from "@forestrie/encoding";
import { createServer, type Deps } from "../../src/node/server.js";
import {
  COURIER_DIAGNOSTIC_CODES,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V2,
  SUPPORTS,
  genesisUrl,
  type FetchedVerifyResult,
  type Provenance,
  type Supports,
  type ToolName,
} from "../../src/core/index.js";
import { TOOL_DESCRIPTIONS, TOOL_TITLES } from "../../src/node/text.js";
import {
  SYNTHETIC_HISTORY_DIR,
  createChainHistoryReplay,
  createChainReplay,
  createLaneAReplay,
  type ChainHistoryReplay,
  type ChainReplay,
  type LaneAReplay,
  type ReplayCall,
} from "../net/replay.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE_A_DIR = path.join(HERE, "..", "fixtures", "lane-a");
const SYNTHETIC_DIR = path.join(HERE, "..", "fixtures", "synthetic");
/**
 * The INSTALLED `@forestrie/mcp-verify`'s own `fixtures/self/` —
 * regenerated at every mcp-verify release (a fresh entry id, statement and
 * receipt each time; confirmed identical only for `log-key.xy.b64` across
 * 0.4.0 and 0.4.1). Never a source for anything that must pair with
 * `ENTRY_ID`, `SELF_CONTENT_HASH` or `LANE_A_RECEIPT_PATH` — those are
 * pinned to mcp-verify 0.4.0's self-registration, and the vendored copies
 * in `test/fixtures/lane-a/` (`STATEMENT_COSE_PATH`, `LOG_KEY_PATH`) are
 * the ones that pair with them. The one legitimate use left is the
 * "bundled fixture verifies under its own bundle" check below, which reads
 * its entry id, statement AND receipt all from this same directory — never
 * mixed with the pinned/vendored constants.
 */
const VERIFY_FIXTURES_DIR = path.join(
  HERE,
  "..",
  "..",
  "node_modules",
  "@forestrie",
  "mcp-verify",
  "fixtures",
  "self",
);

/* ------------------------------- fixtures -------------------------------- */

const BASE_URL = "https://api-a.forest-2.forestrie.dev";
const BOOTSTRAP_LOG_ID = "67876864-3b46-67ae-dcb3-13cc81624aa5";
const PUBLICATIONS_LOG_ID = "e8345800-a747-4e62-9409-61622b836f1f";
const SELF_CONTENT_HASH =
  "7c29bb57bae35044f722f4842c91a38b6fae51a5405a95caf9b27c9b894e2166";
const UNKNOWN_CONTENT_HASH = "0".repeat(64);
const MASSIF_HEIGHT = 14;
const ENTRY_ID = "a09a6337ee0009000000000000000008";
const RECEIPT_SHA256 =
  "55e7edf2a65c39681cb01fc1d6b5b6bf9273b82bd741954be63c8d6f2ef85fbe";
const RECEIPT_BYTE_LENGTH = 438;
const GENESIS_SHA256 =
  "c6183184d805bf23652a265d7f533101eec5c97e1939dd90c7f142e6d502da68";

const RPC_URL = "https://rpc.example/anything";
const UNIVOCITY = "0x678768643b4667aedcb313cc81624aa560b7f0ca";
const CHAIN_ID = 84532;
const BLOCK_NUMBER = 46770471;

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

function base64OfFile(filePath: string): string {
  return readFileSync(filePath).toString("base64");
}

function utf8OfFile(filePath: string): string {
  return readFileSync(filePath, "utf8").trim();
}

/** Vendored byte-for-byte from the published mcp-verify 0.4.0 tarball's
 *  `fixtures/self/` (test/fixtures/lane-a/PROVENANCE.md) — the pair that
 *  actually matches `ENTRY_ID`/`SELF_CONTENT_HASH`/`LANE_A_RECEIPT_PATH`,
 *  unlike whatever mcp-verify happens to have installed. */
const STATEMENT_COSE_PATH = path.join(LANE_A_DIR, "statement.cose");
const LOG_KEY_PATH = path.join(LANE_A_DIR, "log-key.xy.b64");
/** The INSTALLED bundle's own receipt — used only by the "bundled fixture
 *  verifies under its own bundle" check, alongside `BUNDLED_STATEMENT_COSE_PATH`
 *  and `BUNDLED_ENTRY_ID` (read from the same installed `fixtures/self/`),
 *  never alongside the pinned/vendored constants above. */
const BUNDLED_RECEIPT_PATH = path.join(VERIFY_FIXTURES_DIR, "receipt.cbor");
const BUNDLED_STATEMENT_COSE_PATH = path.join(
  VERIFY_FIXTURES_DIR,
  "statement.cose",
);
const BUNDLED_ENTRY_ID = utf8OfFile(
  path.join(VERIFY_FIXTURES_DIR, "entry-id.txt"),
);
const LANE_A_GENESIS_PATH = path.join(LANE_A_DIR, "genesis.cbor");
const LANE_A_RECEIPT_PATH = path.join(LANE_A_DIR, "receipt-self.cbor");
/** The synthetic buried-peak fixture's fabricated "latest" `logState`
 *  (size 15, block 46795144) — plan-2609-06 F1/F2. */
const SYNTHETIC_LOGSTATE_PATH = path.join(
  SYNTHETIC_HISTORY_DIR,
  "logState.46795144.json",
);
/** The real (FROZEN) history capture's own "latest" `logState`, at the
 *  real chain's latest block, 46785144 — plan-2609-06 step 1.2. */
const REAL_LOGSTATE_PATH = path.join(
  HERE,
  "..",
  "fixtures",
  "chain",
  "history",
  PUBLICATIONS_LOG_ID,
  "logState.46785144.json",
);

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** One fake `fetch` dispatching between the lane-A HTTP replay (by exact
 *  URL) and the chain JSON-RPC replay (by the one RPC URL every chain call
 *  in this file uses) — `createServer` takes a single `fetchImpl`, so the
 *  composed chain path is served through it. */
function combineFetch(laneA: LaneAReplay, chain: ChainReplay): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    if (requestUrl(input) === RPC_URL) return chain.fetch(input, init);
    return laneA.fetch(input, init);
  }) as unknown as typeof fetch;
}

/** As `combineFetch`, plus routing an RPC-URL `eth_getLogs` call (F1/F2's
 *  history scan) to a `ChainHistoryReplay` instead of the plain
 *  `ChainReplay` (which only ever serves `eth_chainId`/
 *  `eth_getBlockByNumber`/`eth_call`, one `logState` read's worth). */
function combineFetchWithHistory(
  laneA: LaneAReplay,
  chain: ChainReplay,
  history: ChainHistoryReplay,
): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    if (requestUrl(input) !== RPC_URL) return laneA.fetch(input, init);
    const bodyText =
      typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    const method = (JSON.parse(bodyText) as { method?: unknown }).method;
    return method === "eth_getLogs"
      ? history.fetch(input, init)
      : chain.fetch(input, init);
  }) as unknown as typeof fetch;
}

/** `fetch_accumulator`'s buried-peak fallback makes only RPC-URL calls (no
 *  lane-A HTTP) — routed between a `ChainReplay` (the `logState` read) and
 *  a `ChainHistoryReplay` (the `eth_getLogs` scan) by JSON-RPC method. */
function combineChainAndHistory(
  chain: ChainReplay,
  history: ChainHistoryReplay,
): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const bodyText =
      typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    const method = (JSON.parse(bodyText) as { method?: unknown }).method;
    return method === "eth_getLogs"
      ? history.fetch(input, init)
      : chain.fetch(input, init);
  }) as unknown as typeof fetch;
}

/** Gap check (plan-2609-06 phase 1 step 1.6): `historyWindows`
 *  (`src/core/history.ts`) documents it never produces the string
 *  `"earliest"`, and `test/net/replay.ts`'s chain-history replay already
 *  throws if one arrives — this asserts that directly against the
 *  recorded calls, rather than relying only on that throw never firing. */
function assertNoEarliestFromBlock(calls: ReplayCall[]): void {
  for (const call of calls) {
    const bodyText =
      typeof call.init?.body === "string" ? call.init.body : "{}";
    const parsed = JSON.parse(bodyText) as {
      params?: [{ fromBlock?: unknown; toBlock?: unknown }];
    };
    expect(parsed.params?.[0]?.fromBlock).not.toBe("earliest");
    expect(parsed.params?.[0]?.toBlock).not.toBe("earliest");
  }
}

async function create429Fetch(): Promise<{
  fetch: typeof fetch;
  calls: string[];
}> {
  const body = new Uint8Array(
    readFileSync(path.join(SYNTHETIC_DIR, "429.body.txt")),
  );
  const calls: string[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
  ): Promise<Response> => {
    calls.push(requestUrl(input));
    return new Response(body as unknown as BodyInit, {
      status: 429,
      headers: { "content-type": "text/plain", "retry-after": "60" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function rejectingFetch(message = "boom"): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/* -------- plan-2609-06 F7: a synthetic KS256-bootstrap-key genesis -------- *
 * `@forestrie/receipt-verify` 1.1.0 (`src/forest-genesis-labels.ts`) names
 * these two labels only from an internal module with no subpath export
 * (`package.json#exports` lists only "."), so they are hand-copied here —
 * the same reason genesis-binding.test.ts's own `buildGenesis` helper
 * hand-sets label -68014 as filler already. FOREST_GENESIS_LABEL_GENESIS_ALG
 * = -68014, FOREST_GENESIS_LABEL_BOOTSTRAP_KEY = -68015; COSE_ALG_KS256 =
 * -65799 (`src/cose-key.ts`). A v2 genesis with alg KS256 has no P-256
 * public key to give up — `decodeTrustRootDetailsFromGenesis`'s
 * `bootstrapKeyXy` is `undefined` for it, on-chain-address KS256 root
 * decode taking the bootstrap key's 20 raw bytes instead. */
const FOREST_GENESIS_LABEL_GENESIS_ALG = -68014;
const FOREST_GENESIS_LABEL_BOOTSTRAP_KEY = -68015;
const COSE_ALG_KS256 = -65799;

const KS256_GENESIS_UNIVOCITY = new Uint8Array(20).fill(3);
const KS256_GENESIS_CHAIN_ID = "84532";
const KS256_GENESIS_LOG_ID_WIRE = (() => {
  const wire = new Uint8Array(32);
  wire.set(KS256_GENESIS_UNIVOCITY.slice(0, 16), 16);
  return wire;
})();
const KS256_BOOTSTRAP_ADDRESS = new Uint8Array(20).fill(9);

function buildKs256Genesis(): Uint8Array {
  const map = new Map<number, unknown>([
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
    [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, KS256_GENESIS_UNIVOCITY],
    [FOREST_GENESIS_LABEL_CHAIN_ID, KS256_GENESIS_CHAIN_ID],
    [FOREST_GENESIS_LABEL_LOG_ID, KS256_GENESIS_LOG_ID_WIRE],
    [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
    [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, KS256_BOOTSTRAP_ADDRESS],
  ]);
  return encodeCborDeterministic(map);
}

function createKs256GenesisFetch(): { fetch: typeof fetch; calls: string[] } {
  const body = buildKs256Genesis();
  const calls: string[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
  ): Promise<Response> => {
    calls.push(requestUrl(input));
    return new Response(body as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/cbor" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** Connect a fresh in-memory client/server pair, run `fn`, then close —
 *  every test gets its own server so request counts on the replay fakes it
 *  passed in are exactly that test's own calls. */
async function withClient<T>(
  deps: Deps,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(deps);
  await server.connect(serverTransport);
  const client = new Client({ name: "tools-test", version: "0" });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function assertIsoString(value: string): void {
  expect(new Date(value).toISOString()).toBe(value);
}

function stripCourierDiagnostics(
  diagnostics: FetchedVerifyResult["diagnostics"],
): FetchedVerifyResult["diagnostics"] {
  return diagnostics.filter(
    (d) => !(COURIER_DIAGNOSTIC_CODES as readonly string[]).includes(d.code),
  );
}

/* ---------------------------------------------------------------------- */

describe("tools/list", () => {
  it("every tool carries the N5 annotations, a title, and its exact text.ts description", async () => {
    await withClient({ env: {} }, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

      for (const tool of tools) {
        const name = tool.name as ToolName;
        expect(tool.annotations).toEqual(N5_ANNOTATIONS);
        expect(tool.title).toBe(TOOL_TITLES[name]);
        expect(tool.description).toBe(TOOL_DESCRIPTIONS[name]);
      }
    });
  });
});

/* --------------------------- fetch_scitt_configuration ------------------- */

describe("fetch_scitt_configuration", () => {
  it("fetches the well-known fixture: provenance, supports, one text summary, one request", async () => {
    const laneA = await createLaneAReplay();
    const result = await withClient(
      { fetchImpl: laneA.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_scitt_configuration",
          arguments: { baseUrl: BASE_URL },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      configuration: { serviceId: string };
      provenance: Provenance;
      supports: Supports;
    };
    expect(structured.configuration.serviceId).toBe("canopy-dev-1");
    expect(structured.provenance.source).toBe("fetched");
    expect(structured.provenance.from).toBe(laneA.urls["well-known"]);
    assertIsoString(structured.provenance.at);
    expect(structured.supports).toEqual(SUPPORTS.fetch_scitt_configuration);

    const first = (result.content as unknown[])[0] as {
      type: string;
      text: string;
    };
    expect(first.type).toBe("text");
    expect(first.text.length).toBeGreaterThan(0);

    expect(laneA.calls).toHaveLength(1);
  });

  it("uses FORESTRIE_BASE_URL from the environment when baseUrl is omitted", async () => {
    const laneA = await createLaneAReplay();
    const result = await withClient(
      { fetchImpl: laneA.fetch, env: { FORESTRIE_BASE_URL: BASE_URL } },
      (client) =>
        client.callTool({
          name: "fetch_scitt_configuration",
          arguments: {},
        }),
    );

    expect(result.isError).toBe(false);
    expect(laneA.calls).toHaveLength(1);
    expect(laneA.calls[0]?.url).toBe(laneA.urls["well-known"]);
  });

  it("reports missing_input, isError:false, when neither baseUrl nor FORESTRIE_BASE_URL is set", async () => {
    const result = await withClient(
      { fetchImpl: rejectingFetch("must not fetch"), env: {} },
      (client) =>
        client.callTool({
          name: "fetch_scitt_configuration",
          arguments: {},
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { code: string };
    };
    expect(structured.problem.code).toBe("missing_input");
  });

  it("a rejected fetchImpl yields a network problem, isError:false", async () => {
    const result = await withClient(
      { fetchImpl: rejectingFetch(), env: {} },
      (client) =>
        client.callTool({
          name: "fetch_scitt_configuration",
          arguments: { baseUrl: BASE_URL },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { code: string };
    };
    expect(structured.problem.code).toBe("network");
  });

  it("a synthesised 429 yields a structured problem, isError:false, one request, no retry", async () => {
    const synthetic = await create429Fetch();
    const result = await withClient(
      { fetchImpl: synthetic.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_scitt_configuration",
          arguments: { baseUrl: BASE_URL },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { status: number; retryAfterMs: number };
    };
    expect(structured.problem.status).toBe(429);
    expect(structured.problem.retryAfterMs).toBe(60_000);
    expect(synthetic.calls).toHaveLength(1);
  });
});

/* -------------------------------- query_registration ---------------------- */

describe("query_registration", () => {
  it("reports receipt-available with the entry id and receipt URL for the self content hash, one request, no redirect followed", async () => {
    const laneA = await createLaneAReplay();
    const result = await withClient(
      { fetchImpl: laneA.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "query_registration",
          arguments: {
            baseUrl: BASE_URL,
            bootstrapLogId: BOOTSTRAP_LOG_ID,
            logId: PUBLICATIONS_LOG_ID,
            contentHash: SELF_CONTENT_HASH,
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      status: string;
      entryId: string;
      receiptUrl: string;
      provenance: Provenance;
      supports: Supports;
    };
    expect(structured.status).toBe("receipt-available");
    expect(structured.entryId).toBe(ENTRY_ID);
    expect(structured.receiptUrl).toBe(laneA.urls["receipt-self"]);
    expect(structured.provenance.source).toBe("fetched");
    expect(structured.provenance.from).toBe(laneA.urls["status-self"]);
    assertIsoString(structured.provenance.at);
    expect(structured.supports).toEqual(SUPPORTS.query_registration);

    const first = (result.content as unknown[])[0] as {
      type: string;
      text: string;
    };
    expect(first.type).toBe("text");
    expect(first.text.length).toBeGreaterThan(0);

    expect(laneA.calls).toHaveLength(1);
    expect(laneA.calls[0]?.init?.redirect).toBe("manual");
  });

  it("reports pending with retryAfterMs 1000 for the all-zero content hash, no second (retry) request", async () => {
    const laneA = await createLaneAReplay();
    const result = await withClient(
      { fetchImpl: laneA.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "query_registration",
          arguments: {
            baseUrl: BASE_URL,
            bootstrapLogId: BOOTSTRAP_LOG_ID,
            logId: PUBLICATIONS_LOG_ID,
            contentHash: UNKNOWN_CONTENT_HASH,
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      status: string;
      location: string;
      retryAfterMs: number;
      supports: Supports;
    };
    expect(structured.status).toBe("pending");
    expect(structured.retryAfterMs).toBe(1000);
    expect(structured.location).toBe(laneA.urls["status-unknown"]);
    expect(structured.supports).toEqual(SUPPORTS.query_registration);

    expect(laneA.calls).toHaveLength(1);
  });

  it("a synthesised 429 yields a structured problem, isError:false, one request, no retry", async () => {
    const synthetic = await create429Fetch();
    const result = await withClient(
      { fetchImpl: synthetic.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "query_registration",
          arguments: {
            baseUrl: BASE_URL,
            bootstrapLogId: BOOTSTRAP_LOG_ID,
            logId: PUBLICATIONS_LOG_ID,
            contentHash: SELF_CONTENT_HASH,
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { status: number; retryAfterMs: number };
    };
    expect(structured.problem.status).toBe(429);
    expect(structured.problem.retryAfterMs).toBe(60_000);
    expect(synthetic.calls).toHaveLength(1);
  });
});

/* ---------------------------------- fetch_receipt -------------------------- */

describe("fetch_receipt", () => {
  it("fetches by receiptUrl: sha256, byteLength, decoded inclusion mmr index 8, one request", async () => {
    const laneA = await createLaneAReplay();
    const result = await withClient(
      { fetchImpl: laneA.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_receipt",
          arguments: { receiptUrl: laneA.urls["receipt-self"] },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      receipt: { sha256: string; byteLength: number };
      decoded: { inclusion: { mmrIndex: string } };
      provenance: Provenance;
      supports: Supports;
    };
    expect(structured.receipt.sha256).toBe(RECEIPT_SHA256);
    expect(structured.receipt.byteLength).toBe(RECEIPT_BYTE_LENGTH);
    expect(structured.decoded.inclusion.mmrIndex).toBe("8");
    expect(structured.provenance.source).toBe("fetched");
    assertIsoString(structured.provenance.at);
    expect(structured.supports).toEqual(SUPPORTS.fetch_receipt);

    const first = (result.content as unknown[])[0] as {
      type: string;
      text: string;
    };
    expect(first.type).toBe("text");
    expect(first.text.length).toBeGreaterThan(0);

    expect(laneA.calls).toHaveLength(1);
  });

  it("fetches by the five-field form: same sha256, byteLength, mmr index, one request", async () => {
    const laneA = await createLaneAReplay();
    const result = await withClient(
      { fetchImpl: laneA.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_receipt",
          arguments: {
            baseUrl: BASE_URL,
            bootstrapLogId: BOOTSTRAP_LOG_ID,
            logId: PUBLICATIONS_LOG_ID,
            massifHeight: MASSIF_HEIGHT,
            entryId: ENTRY_ID,
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      receipt: { sha256: string; byteLength: number };
      decoded: { inclusion: { mmrIndex: string } };
    };
    expect(structured.receipt.sha256).toBe(RECEIPT_SHA256);
    expect(structured.receipt.byteLength).toBe(RECEIPT_BYTE_LENGTH);
    expect(structured.decoded.inclusion.mmrIndex).toBe("8");

    expect(laneA.calls).toHaveLength(1);
  });

  it("a synthesised 429 yields a structured problem, isError:false, one request, no retry", async () => {
    const synthetic = await create429Fetch();
    const result = await withClient(
      { fetchImpl: synthetic.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_receipt",
          arguments: { receiptUrl: `${BASE_URL}/anything/receipt` },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { status: number; retryAfterMs: number };
    };
    expect(structured.problem.status).toBe(429);
    expect(structured.problem.retryAfterMs).toBe(60_000);
    expect(synthetic.calls).toHaveLength(1);
  });

  it("a rejected fetchImpl yields a network problem, isError:false", async () => {
    const result = await withClient(
      { fetchImpl: rejectingFetch(), env: {} },
      (client) =>
        client.callTool({
          name: "fetch_receipt",
          arguments: { receiptUrl: `${BASE_URL}/anything/receipt` },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { code: string };
    };
    expect(structured.problem.code).toBe("network");
  });
});

/* ---------------------------------- fetch_genesis -------------------------- */

describe("fetch_genesis", () => {
  it("fetches the genesis document: chainBinding, sha256, supports rows exactly the N3 sealing row, one request", async () => {
    const laneA = await createLaneAReplay();
    const result = await withClient(
      { fetchImpl: laneA.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_genesis",
          arguments: { baseUrl: BASE_URL, logId: BOOTSTRAP_LOG_ID },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      genesis: { sha256: string };
      chainBinding: {
        univocity: string;
        chainId: number;
        forestLogId: string;
      };
      bootstrapKeyXy?: string;
      provenance: Provenance;
      supports: Supports;
    };
    expect(structured.chainBinding.univocity).toBe(UNIVOCITY);
    expect(structured.chainBinding.chainId).toBe(CHAIN_ID);
    expect(structured.genesis.sha256).toBe(GENESIS_SHA256);
    expect(structured.provenance.source).toBe("fetched");
    assertIsoString(structured.provenance.at);
    expect(structured.supports).toEqual(SUPPORTS.fetch_genesis);
    expect(structured.supports.rows).toEqual([
      { question: "sealing", root: "known-log-key" },
    ]);
    // plan-2609-06 F7: the bootstrap public key as x‖y hex (64 bytes -> 128
    // hex chars), decoded straight from the genesis bytes via
    // decodeTrustRootDetailsFromGenesis — the lane-A fixture's bootstrap
    // key is ES256, verified against a direct decode of genesis.cbor.
    expect(structured.bootstrapKeyXy).toBe(
      "4284403053a157bf6976be27e0c0bdf746da8d9d4269a211b99505b0f977ae1e2856fb3b2b009ac46403328bc3ea6869b13459bbbacfb1dc545f9f782712486c",
    );

    const first = (result.content as unknown[])[0] as {
      type: string;
      text: string;
    };
    expect(first.type).toBe("text");
    expect(first.text.length).toBeGreaterThan(0);

    expect(laneA.calls).toHaveLength(1);
  });

  it("a synthesised 429 yields a structured problem, isError:false, one request, no retry", async () => {
    const synthetic = await create429Fetch();
    const result = await withClient(
      { fetchImpl: synthetic.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_genesis",
          arguments: { baseUrl: BASE_URL, logId: BOOTSTRAP_LOG_ID },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { status: number; retryAfterMs: number };
    };
    expect(structured.problem.status).toBe(429);
    expect(structured.problem.retryAfterMs).toBe(60_000);
    expect(synthetic.calls).toHaveLength(1);
  });

  it("a KS256 bootstrap key omits bootstrapKeyXy rather than failing (plan-2609-06 F7)", async () => {
    const synthetic = createKs256GenesisFetch();
    const result = await withClient(
      { fetchImpl: synthetic.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_genesis",
          arguments: { baseUrl: BASE_URL, logId: BOOTSTRAP_LOG_ID },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      chainBinding: { univocity: string; chainId: number };
      bootstrapKeyXy?: string;
      problem?: unknown;
    };
    expect(structured.problem).toBeUndefined();
    expect(structured.chainBinding.univocity).toBe(
      `0x${Buffer.from(KS256_GENESIS_UNIVOCITY).toString("hex")}`,
    );
    expect(structured.chainBinding.chainId).toBe(84532);
    expect(structured.bootstrapKeyXy).toBeUndefined();
    expect(synthetic.calls).toHaveLength(1);
    // The genesis URL this fetch actually asked for, confirming the fake
    // was wired to the tool call rather than trivially vacuous.
    expect(synthetic.calls[0]).toBe(genesisUrl(BASE_URL, BOOTSTRAP_LOG_ID));
  });
});

/* -------------------------------- fetch_accumulator ------------------------ */

describe("fetch_accumulator", () => {
  it("explicit chain form: size 11, block 46770471, binding explicit, three RPC calls, snapshot decodes", async () => {
    const chain = await createChainReplay();
    const result = await withClient(
      { fetchImpl: chain.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_accumulator",
          arguments: {
            chain: {
              rpcUrl: RPC_URL,
              univocity: UNIVOCITY,
              logId: PUBLICATIONS_LOG_ID,
              chainId: CHAIN_ID,
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      snapshot: { base64: string };
      accumulator: { size: number; blockNumber: number };
      provenance: Provenance;
      supports: Supports;
    };
    expect(structured.accumulator.size).toBe(11);
    expect(structured.accumulator.blockNumber).toBe(BLOCK_NUMBER);
    expect(structured.provenance.source).toBe("chain-read");
    expect(structured.provenance.binding).toBe("explicit");
    assertIsoString(structured.provenance.at);
    expect(structured.supports).toEqual(SUPPORTS.fetch_accumulator);

    const decoded = decodeKnownAccumulator(
      new Uint8Array(Buffer.from(structured.snapshot.base64, "base64")),
    );
    expect(decoded.size).toBe(11n);
    expect(decoded.chainId).toBe(BigInt(CHAIN_ID));

    expect(chain.calls).toHaveLength(3);
  });

  it("held-genesis chain form: same snapshot, binding held-genesis, three RPC calls, no lane-a request", async () => {
    const laneA = await createLaneAReplay();
    const chain = await createChainReplay();
    const result = await withClient(
      { fetchImpl: combineFetch(laneA, chain), env: {} },
      (client) =>
        client.callTool({
          name: "fetch_accumulator",
          arguments: {
            chain: {
              genesis: { base64: base64OfFile(LANE_A_GENESIS_PATH) },
              rpcUrl: RPC_URL,
              logId: PUBLICATIONS_LOG_ID,
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      accumulator: { size: number; blockNumber: number };
      provenance: Provenance;
    };
    expect(structured.accumulator.size).toBe(11);
    expect(structured.accumulator.blockNumber).toBe(BLOCK_NUMBER);
    expect(structured.provenance.binding).toBe("held-genesis");

    expect(chain.calls).toHaveLength(3);
    expect(laneA.calls).toHaveLength(0);
  });

  it("explicit chain form with chainId:1 yields rpc_chain_id_mismatch after exactly one RPC call", async () => {
    const chain = await createChainReplay();
    const result = await withClient(
      { fetchImpl: chain.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_accumulator",
          arguments: {
            chain: {
              rpcUrl: RPC_URL,
              univocity: UNIVOCITY,
              logId: PUBLICATIONS_LOG_ID,
              chainId: 1,
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { code: string };
    };
    expect(structured.problem.code).toBe("rpc_chain_id_mismatch");
    expect(chain.calls).toHaveLength(1);
  });

  it("reads rpcUrl from FORESTRIE_RPC_URL when omitted", async () => {
    const chain = await createChainReplay();
    const result = await withClient(
      {
        fetchImpl: chain.fetch,
        env: { FORESTRIE_RPC_URL: RPC_URL },
      },
      (client) =>
        client.callTool({
          name: "fetch_accumulator",
          arguments: {
            chain: {
              univocity: UNIVOCITY,
              logId: PUBLICATIONS_LOG_ID,
              chainId: CHAIN_ID,
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      accumulator: { size: number };
    };
    expect(structured.accumulator.size).toBe(11);
    expect(chain.calls).toHaveLength(3);
  });

  /* -------- plan-2609-06 F1/F2: the buried-peak history fallback -------- */

  it("forReceipt: the synthetic latest state doesn't hold the peak, the scan finds the real size-11 checkpoint, provenance.history, 4 history requests", async () => {
    const chain = await createChainReplay(undefined, SYNTHETIC_LOGSTATE_PATH);
    const history = await createChainHistoryReplay();
    const result = await withClient(
      { fetchImpl: combineChainAndHistory(chain, history), env: {} },
      (client) =>
        client.callTool({
          name: "fetch_accumulator",
          arguments: {
            chain: {
              rpcUrl: RPC_URL,
              univocity: UNIVOCITY,
              logId: PUBLICATIONS_LOG_ID,
              chainId: CHAIN_ID,
            },
            forReceipt: {
              receipt: { base64: base64OfFile(LANE_A_RECEIPT_PATH) },
              payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
              entryId: ENTRY_ID,
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      accumulator: { size: number; blockNumber: number };
      provenance: Provenance;
      supports: Supports;
    };
    expect(structured.accumulator.size).toBe(11);
    expect(structured.accumulator.blockNumber).toBe(46764680);
    expect(structured.provenance.history).toMatchObject({
      blockNumber: 46764680,
      size: 11,
      requests: 4,
    });
    expect(structured.supports).toEqual(SUPPORTS.fetch_accumulator);

    expect(chain.calls).toHaveLength(3); // the initial logState read
    expect(history.calls).toHaveLength(4); // the buried-peak scan (F2)
    assertNoEarliestFromBlock(history.calls);
  });

  it("forReceipt without payload/entryId is missing_input before any JSON-RPC call, zero requests", async () => {
    const calls: string[] = [];
    const countingFetch = (async (
      input: Parameters<typeof fetch>[0],
    ): Promise<Response> => {
      calls.push(requestUrl(input));
      throw new Error("no request should have been made");
    }) as unknown as typeof fetch;

    const result = await withClient(
      { fetchImpl: countingFetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_accumulator",
          arguments: {
            chain: {
              rpcUrl: RPC_URL,
              univocity: UNIVOCITY,
              logId: PUBLICATIONS_LOG_ID,
              chainId: CHAIN_ID,
            },
            forReceipt: {
              receipt: { base64: base64OfFile(LANE_A_RECEIPT_PATH) },
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { code: string; message: string };
    };
    expect(structured.problem.code).toBe("missing_input");
    expect(structured.problem.message).toBe(
      "forReceipt needs payload and entryId (or grant true with the committed grant bytes) to recompute the receipt's peak",
    );
    expect(calls).toHaveLength(0);
  });

  it("forReceipt with grant:true and a raw grant payload, no entryId, is missing_input, zero requests", async () => {
    const calls: string[] = [];
    const countingFetch = (async (
      input: Parameters<typeof fetch>[0],
    ): Promise<Response> => {
      calls.push(requestUrl(input));
      throw new Error("no request should have been made");
    }) as unknown as typeof fetch;

    // A raw Forestrie-Grant v0 payload (no COSE wrapping, so no embedded
    // idtimestamp) — arbitrary field values, since the handler must reject
    // this before ever touching the receipt or the chain.
    const rawGrantPayload = encodeGrantPayloadV0Canonical({
      logId: new Uint8Array(16),
      ownerLogId: new Uint8Array(16),
      grant: new Uint8Array(8),
      maxHeight: 0,
      minGrowth: 0,
      grantData: new Uint8Array(64),
    });

    const result = await withClient(
      { fetchImpl: countingFetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_accumulator",
          arguments: {
            chain: {
              rpcUrl: RPC_URL,
              univocity: UNIVOCITY,
              logId: PUBLICATIONS_LOG_ID,
              chainId: CHAIN_ID,
            },
            forReceipt: {
              receipt: { base64: base64OfFile(LANE_A_RECEIPT_PATH) },
              payload: {
                base64: Buffer.from(rawGrantPayload).toString("base64"),
              },
              grant: true,
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { code: string; message: string };
    };
    expect(structured.problem.code).toBe("missing_input");
    expect(structured.problem.message).toBe(
      "forReceipt.payload is a raw grant payload, which carries no idtimestamp; supply entryId (a Forestrie-Grant COSE Sign1 carries its own)",
    );
    expect(calls).toHaveLength(0);
  });

  it("forReceipt with grant:true and undecodable payload bytes is invalid_input, zero requests", async () => {
    const calls: string[] = [];
    const countingFetch = (async (
      input: Parameters<typeof fetch>[0],
    ): Promise<Response> => {
      calls.push(requestUrl(input));
      throw new Error("no request should have been made");
    }) as unknown as typeof fetch;

    const result = await withClient(
      { fetchImpl: countingFetch, env: {} },
      (client) =>
        client.callTool({
          name: "fetch_accumulator",
          arguments: {
            chain: {
              rpcUrl: RPC_URL,
              univocity: UNIVOCITY,
              logId: PUBLICATIONS_LOG_ID,
              chainId: CHAIN_ID,
            },
            forReceipt: {
              receipt: { base64: base64OfFile(LANE_A_RECEIPT_PATH) },
              // A plain COSE-signed statement — neither a Forestrie-Grant
              // COSE Sign1 nor a raw grant payload CBOR map (same fixture,
              // same "Grant payload must be a CBOR map" detail, as the
              // verify_fetched_receipt grant:true test below).
              payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
              grant: true,
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { code: string; message: string };
    };
    expect(structured.problem.code).toBe("invalid_input");
    expect(
      structured.problem.message.startsWith(
        "forReceipt.payload with grant true is neither a Forestrie-Grant COSE Sign1 nor a raw grant payload: ",
      ),
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });

  // The positive forReceipt+grant path (a grant receipt whose recomputed
  // peak is checked against the accumulator, with a history fallback) is
  // NOT re-tested here: `test/core/grant-leaf.test.ts` (a) cross-checks
  // `grantLeafInputs`'s derivation against the verifier's own
  // `verifyGrantReceipt`, and the plumbing from `leafInput` through
  // `recomputePeakForReceipt`/`peakHeldIn` to the tool result is already
  // covered end-to-end by the existing payload `forReceipt` tests above —
  // the grant branch only changes where the leaf inputs come from.
});

/* ---------------------------- fetch_checkpoint_history ---------------------- */

describe("fetch_checkpoint_history", () => {
  it("real history from the real latest (46785144), history.fromBlock 46732186: 6 checkpoints newest first, 6 requests, only the chain head (no eth_call)", async () => {
    const chain = await createChainReplay(undefined, REAL_LOGSTATE_PATH);
    const history = await createChainHistoryReplay();
    const result = await withClient(
      { fetchImpl: combineChainAndHistory(chain, history), env: {} },
      (client) =>
        client.callTool({
          name: "fetch_checkpoint_history",
          arguments: {
            chain: {
              rpcUrl: RPC_URL,
              univocity: UNIVOCITY,
              logId: PUBLICATIONS_LOG_ID,
              chainId: CHAIN_ID,
              history: { fromBlock: 46732186 },
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      checkpoints: Array<{
        size: number;
        blockNumber: number;
        snapshot: string;
      }>;
      scannedFrom: number;
      scannedTo: number;
      requests: number;
      chainBinding: { univocity: string; chainId: number; logId: string };
      provenance: Provenance;
      supports: Supports;
    };
    expect(structured.checkpoints.map((c) => c.size)).toEqual([
      11, 10, 8, 4, 3, 1,
    ]);
    expect(structured.scannedFrom).toBe(46732186);
    expect(structured.scannedTo).toBe(46785144);
    expect(structured.requests).toBe(6);
    expect(structured.chainBinding).toEqual({
      univocity: UNIVOCITY,
      chainId: CHAIN_ID,
      logId: PUBLICATIONS_LOG_ID,
    });
    expect(structured.provenance.source).toBe("chain-read");
    expect(structured.provenance.history).toEqual({
      scannedFrom: 46732186,
      scannedTo: 46785144,
      requests: 6,
    });
    expect(structured.supports).toEqual(SUPPORTS.fetch_checkpoint_history);

    for (const cp of structured.checkpoints) {
      const decoded = decodeKnownAccumulator(
        new Uint8Array(Buffer.from(cp.snapshot, "base64")),
      );
      expect(decoded.size).toBe(BigInt(cp.size));
      expect(decoded.blockNumber).toBe(BigInt(cp.blockNumber));
    }

    // readChainHead: eth_chainId + eth_getBlockByNumber only — no eth_call.
    expect(chain.calls).toHaveLength(2);
    expect(history.calls).toHaveLength(6);
    assertNoEarliestFromBlock(history.calls);
  });

  it("maxBlocks 20000 stops short of every real checkpoint: 2 requests, 0 checkpoints, no problem", async () => {
    const chain = await createChainReplay(undefined, REAL_LOGSTATE_PATH);
    const history = await createChainHistoryReplay();
    const result = await withClient(
      { fetchImpl: combineChainAndHistory(chain, history), env: {} },
      (client) =>
        client.callTool({
          name: "fetch_checkpoint_history",
          arguments: {
            chain: {
              rpcUrl: RPC_URL,
              univocity: UNIVOCITY,
              logId: PUBLICATIONS_LOG_ID,
              chainId: CHAIN_ID,
              history: { maxBlocks: 20_000 },
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      checkpoints: unknown[];
      requests: number;
      problem?: unknown;
    };
    expect(structured.checkpoints).toEqual([]);
    expect(structured.requests).toBe(2);
    expect(structured.problem).toBeUndefined();
    expect(chain.calls).toHaveLength(2);
    expect(history.calls).toHaveLength(2);
    assertNoEarliestFromBlock(history.calls);
  });

  it("a JSON-RPC error on the first window is a structured problem, isError:false", async () => {
    const chain = await createChainReplay(undefined, REAL_LOGSTATE_PATH);
    const history = await createChainHistoryReplay([
      {
        fromBlock: "0x2c9bb69", // 46775145
        toBlock: "0x2c9e278", // 46785144
        status: 200,
        response: {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "boom" },
        },
      },
    ]);
    const result = await withClient(
      { fetchImpl: combineChainAndHistory(chain, history), env: {} },
      (client) =>
        client.callTool({
          name: "fetch_checkpoint_history",
          arguments: {
            chain: {
              rpcUrl: RPC_URL,
              univocity: UNIVOCITY,
              logId: PUBLICATIONS_LOG_ID,
              chainId: CHAIN_ID,
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { code: string; message: string };
    };
    expect(structured.problem.code).toBe("rpc_error");
    expect(structured.problem.message).toBe("boom");
    expect(history.calls).toHaveLength(1);
    assertNoEarliestFromBlock(history.calls);
  });
});

/* ----------------------------- verify_fetched_receipt ---------------------- */

type VerifyStructured = FetchedVerifyResult & {
  provenance: { receipt: Provenance; root: Provenance };
  supports: Supports;
};

describe("verify_fetched_receipt", () => {
  it("known-log-key, supplied: verifier answers pass through unaltered, exactly one courier diagnostic, no root_read_from_chain", async () => {
    const laneA = await createLaneAReplay();
    const result = await withClient(
      { fetchImpl: laneA.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "verify_fetched_receipt",
          arguments: {
            receiptUrl: laneA.urls["receipt-self"],
            entryId: ENTRY_ID,
            payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
            trust: {
              root: "known-log-key",
              keyXy: { base64: utf8OfFile(LOG_KEY_PATH) },
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as VerifyStructured;
    expect(structured.ok).toBe(true);
    expect(structured.root).toBe("known-log-key");
    expect(structured.questions["sealing"]?.status).toBe("ok");
    expect(structured.questions["attribution"]?.status).toBe("ok");
    expect(structured.questions["split-view"]?.status).toBe(
      "not_answered_by_this_root",
    );
    expect(structured.questions["append-authority"]?.status).toBe(
      "not_answered_by_this_root",
    );
    expect(Object.keys(structured.questions).sort()).toEqual(
      ["append-authority", "attribution", "sealing", "split-view"].sort(),
    );

    const courierDiagnostics = structured.diagnostics.filter((d) =>
      (COURIER_DIAGNOSTIC_CODES as readonly string[]).includes(d.code),
    );
    expect(courierDiagnostics).toEqual([
      {
        code: "receipt_fetched_from_operator",
        message:
          "the receipt bytes were fetched from the operator's API in this call",
      },
    ]);
    expect(structured.supports).toEqual(SUPPORTS.verify_fetched_receipt);
    expect(structured.provenance.receipt.source).toBe("fetched");
    expect(structured.provenance.root.source).toBe("supplied");

    expect(laneA.calls).toHaveLength(1);

    // Compare against calling @forestrie/mcp-verify's verifyReceipt directly
    // on the SAME (lane-a fetched) receipt bytes and inputs.
    const trust = {
      root: "known-log-key" as const,
      keyXy: new Uint8Array(Buffer.from(utf8OfFile(LOG_KEY_PATH), "base64")),
    };
    const direct = await verifyReceipt({
      receipt: new Uint8Array(readFileSync(LANE_A_RECEIPT_PATH)),
      payload: new Uint8Array(readFileSync(STATEMENT_COSE_PATH)),
      entryId: ENTRY_ID,
      trust,
    });
    expect(structured.questions).toEqual(direct.questions);
    expect(structured.stages).toEqual(direct.stages);
    expect(stripCourierDiagnostics(structured.diagnostics)).toEqual(
      direct.diagnostics,
    );

    // The INSTALLED mcp-verify's own bundled fixtures/self/ is a fresh
    // self-registration every release — a different entry id, statement
    // and receipt each time (only log-key.xy.b64 has stayed byte-identical
    // across 0.4.0 and 0.4.1) — so it no longer pairs with ENTRY_ID or the
    // vendored STATEMENT_COSE_PATH the way it did when Amendment A was
    // written against 0.4.0. This check reads its entry id, statement and
    // receipt all from that same installed bundle instead, and asserts
    // only that the bundle verifies under its own terms (sealing and
    // attribution ok, under the log key both fixture generations share) —
    // not that it reproduces lane-A's specific questions, which was a
    // coincidence of 0.4.0's fixture pairing, not a general guarantee.
    const bundledDirect = await verifyReceipt({
      receipt: new Uint8Array(readFileSync(BUNDLED_RECEIPT_PATH)),
      payload: new Uint8Array(readFileSync(BUNDLED_STATEMENT_COSE_PATH)),
      entryId: BUNDLED_ENTRY_ID,
      trust,
    });
    expect(bundledDirect.ok).toBe(true);
    expect(bundledDirect.questions["sealing"]?.status).toBe("ok");
    expect(bundledDirect.questions["attribution"]?.status).toBe("ok");
  });

  it("known-accumulator, explicit chain: four requests, both courier diagnostics, split-view ok, binding explicit", async () => {
    const laneA = await createLaneAReplay();
    const chain = await createChainReplay();
    const result = await withClient(
      { fetchImpl: combineFetch(laneA, chain), env: {} },
      (client) =>
        client.callTool({
          name: "verify_fetched_receipt",
          arguments: {
            receiptUrl: laneA.urls["receipt-self"],
            entryId: ENTRY_ID,
            payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
            trust: {
              root: "known-accumulator",
              chain: {
                rpcUrl: RPC_URL,
                univocity: UNIVOCITY,
                logId: PUBLICATIONS_LOG_ID,
                chainId: CHAIN_ID,
              },
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as VerifyStructured;
    expect(structured.root).toBe("known-accumulator");
    // The receipt's own inclusion mmr index (8) is covered by the chain's
    // accumulator (size 11 at block 46770471): the recomputed peak matches
    // one of the chain's own peaks, so the verifier reports split-view ok
    // (checked directly against @forestrie/mcp-verify's verifyReceipt with
    // the same accumulator bytes — see the probe this test's assertion is
    // taken from). Quoting the verifier's own note verbatim below.
    expect(structured.questions["split-view"]).toEqual({
      status: "ok",
      note: "the recomputed peak is one of the peaks in the accumulator you trust",
    });

    const diagnosticCodes = structured.diagnostics.map((d) => d.code);
    expect(diagnosticCodes).toContain("receipt_fetched_from_operator");
    expect(diagnosticCodes).toContain("root_read_from_chain");
    expect(structured.diagnostics).toContainEqual({
      code: "root_read_from_chain",
      message:
        "the accumulator was read from the chain in this call, at the caller's RPC URL",
    });

    expect(structured.provenance.receipt.source).toBe("fetched");
    expect(structured.provenance.receipt.from).toBe(
      laneA.urls["receipt-self"],
    );
    expect(structured.provenance.root.source).toBe("chain-read");
    expect(structured.provenance.root.binding).toBe("explicit");
    expect(structured.provenance.root.from).toEqual({
      rpcUrl: RPC_URL,
      univocity: UNIVOCITY,
      chainId: CHAIN_ID,
    });

    expect(laneA.calls).toHaveLength(1);
    expect(chain.calls).toHaveLength(3);
  });

  it("known-accumulator, held-genesis chain: same result, binding held-genesis, four requests", async () => {
    const laneA = await createLaneAReplay();
    const chain = await createChainReplay();
    const result = await withClient(
      { fetchImpl: combineFetch(laneA, chain), env: {} },
      (client) =>
        client.callTool({
          name: "verify_fetched_receipt",
          arguments: {
            receiptUrl: laneA.urls["receipt-self"],
            entryId: ENTRY_ID,
            payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
            trust: {
              root: "known-accumulator",
              chain: {
                genesis: { base64: base64OfFile(LANE_A_GENESIS_PATH) },
                rpcUrl: RPC_URL,
                logId: PUBLICATIONS_LOG_ID,
              },
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as VerifyStructured;
    expect(structured.root).toBe("known-accumulator");
    expect(structured.questions["split-view"]?.status).toBe("ok");
    expect(structured.provenance.root.binding).toBe("held-genesis");

    const diagnosticCodes = structured.diagnostics.map((d) => d.code);
    expect(diagnosticCodes).toEqual(
      expect.arrayContaining([
        "receipt_fetched_from_operator",
        "root_read_from_chain",
      ]),
    );

    expect(laneA.calls).toHaveLength(1);
    expect(chain.calls).toHaveLength(3);
  });

  /* -------- plan-2609-06 F1/F2: the buried-peak history fallback -------- */

  it("known-accumulator, chain history fallback: the synthetic latest state doesn't hold the peak, the scan finds the real size-11 checkpoint, split-view ok, both chain diagnostics, 4 history requests, anchor at block 46764680", async () => {
    const laneA = await createLaneAReplay();
    const chain = await createChainReplay(undefined, SYNTHETIC_LOGSTATE_PATH);
    const history = await createChainHistoryReplay();
    const result = await withClient(
      {
        fetchImpl: combineFetchWithHistory(laneA, chain, history),
        env: {},
      },
      (client) =>
        client.callTool({
          name: "verify_fetched_receipt",
          arguments: {
            receiptUrl: laneA.urls["receipt-self"],
            entryId: ENTRY_ID,
            payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
            trust: {
              root: "known-accumulator",
              chain: {
                rpcUrl: RPC_URL,
                univocity: UNIVOCITY,
                logId: PUBLICATIONS_LOG_ID,
                chainId: CHAIN_ID,
              },
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as VerifyStructured;
    expect(structured.root).toBe("known-accumulator");
    expect(structured.questions["split-view"]?.status).toBe("ok");

    const diagnosticCodes = structured.diagnostics.map((d) => d.code);
    expect(diagnosticCodes).toEqual(
      expect.arrayContaining([
        "receipt_fetched_from_operator",
        "root_read_from_chain",
        "root_read_from_chain_history",
      ]),
    );
    expect(structured.diagnostics).toContainEqual({
      code: "root_read_from_chain_history",
      message:
        "the accumulator was selected from published checkpoint history in this call, at the caller's RPC URL",
    });

    expect(structured.anchor).toMatchObject({
      anchoredSize: "11",
      blockNumber: "46764680",
    });

    expect(structured.provenance.root.history).toMatchObject({
      blockNumber: 46764680,
      size: 11,
      requests: 4,
    });
    // F2: provenance.source is "chain-read" even when the accumulator came
    // from history — "chain-read-history" is an internal rootProvenance
    // label only, never emitted in structuredContent.
    expect(structured.provenance.root.source).toBe("chain-read");

    expect(laneA.calls).toHaveLength(1);
    expect(chain.calls).toHaveLength(3); // the initial logState read
    expect(history.calls).toHaveLength(4); // the buried-peak scan (F2)
    assertNoEarliestFromBlock(history.calls);
  });

  it("known-accumulator, chain history fallback with a tight budget: history_scan_exhausted, isError:false, no throw", async () => {
    const laneA = await createLaneAReplay();
    const chain = await createChainReplay(undefined, SYNTHETIC_LOGSTATE_PATH);
    const history = await createChainHistoryReplay();
    const result = await withClient(
      {
        fetchImpl: combineFetchWithHistory(laneA, chain, history),
        env: {},
      },
      (client) =>
        client.callTool({
          name: "verify_fetched_receipt",
          arguments: {
            receiptUrl: laneA.urls["receipt-self"],
            entryId: ENTRY_ID,
            payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
            trust: {
              root: "known-accumulator",
              chain: {
                rpcUrl: RPC_URL,
                univocity: UNIVOCITY,
                logId: PUBLICATIONS_LOG_ID,
                chainId: CHAIN_ID,
                history: { maxBlocks: 20_000 },
              },
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: {
        code: string;
        scannedFrom: number;
        scannedTo: number;
        checkpointsSeen: number;
        requests: number;
      };
      latest: unknown;
      supports: Supports;
    };
    expect(structured.problem.code).toBe("history_scan_exhausted");
    expect(structured.problem.requests).toBe(2);
    expect(structured.problem.checkpointsSeen).toBe(1);
    expect(structured.problem.scannedFrom).toBe(46775145);
    expect(structured.problem.scannedTo).toBe(46795144);
    expect(structured.latest).toBeDefined();
    expect(structured.supports).toEqual(SUPPORTS.verify_fetched_receipt);
    assertNoEarliestFromBlock(history.calls);
  });

  it("refuses trust:{root:'genesis', fetch:true} (no genesis bytes) at input validation, zero requests", async () => {
    const laneA = await createLaneAReplay();
    // The MCP SDK catches a zod input-validation McpError and returns it as
    // a normal CallToolResult with isError:true (mcp.js's CallToolRequest
    // handler), rather than rejecting the client's callTool promise — so
    // this is the "SDK returns an error result" branch, not the "throws"
    // one. Either way, no request is ever made: validation runs before the
    // handler.
    const result = await withClient(
      { fetchImpl: laneA.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "verify_fetched_receipt",
          arguments: {
            receiptUrl: laneA.urls["receipt-self"],
            entryId: ENTRY_ID,
            payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
            trust: { root: "genesis", fetch: true },
          },
        }),
    );
    expect(result.isError).toBe(true);
    expect(laneA.calls).toHaveLength(0);
  });

  it("refuses trust:{root:'genesis', baseUrl:...} (no genesis bytes) at input validation, zero requests", async () => {
    const laneA = await createLaneAReplay();
    const result = await withClient(
      { fetchImpl: laneA.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "verify_fetched_receipt",
          arguments: {
            receiptUrl: laneA.urls["receipt-self"],
            entryId: ENTRY_ID,
            payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
            trust: { root: "genesis", baseUrl: BASE_URL },
          },
        }),
    );
    expect(result.isError).toBe(true);
    expect(laneA.calls).toHaveLength(0);
  });

  it("grant:true on the same receipt: ok:false at the parse stage, receipt_fetched_from_operator still appended", async () => {
    const laneA = await createLaneAReplay();
    const result = await withClient(
      { fetchImpl: laneA.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "verify_fetched_receipt",
          arguments: {
            receiptUrl: laneA.urls["receipt-self"],
            entryId: ENTRY_ID,
            payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
            grant: true,
            trust: {
              root: "known-log-key",
              keyXy: { base64: utf8OfFile(LOG_KEY_PATH) },
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as VerifyStructured;
    expect(structured.ok).toBe(false);
    expect(structured.stage).toBe("parse");
    // The self receipt's committed payload (statement.cose, a plain
    // COSE-signed statement) is neither a Forestrie-Grant COSE Sign1 nor a
    // raw grant payload CBOR map, so verifyGrantReceipt fails at parse
    // before any signature/inclusion check runs (checked directly against
    // the verifier). Quoting the verifier's own reason verbatim.
    expect(structured.reason).toBe(
      "committedGrant is neither a Forestrie-Grant COSE Sign1 nor a raw grant payload: Grant payload must be a CBOR map",
    );
    expect(structured.diagnostics.map((d) => d.code)).toContain(
      "receipt_fetched_from_operator",
    );

    expect(laneA.calls).toHaveLength(1);
  });

  it("a synthesised 429 on the receipt step yields a structured problem, isError:false, one request, no retry", async () => {
    const synthetic = await create429Fetch();
    const result = await withClient(
      { fetchImpl: synthetic.fetch, env: {} },
      (client) =>
        client.callTool({
          name: "verify_fetched_receipt",
          arguments: {
            receiptUrl: `${BASE_URL}/anything/receipt`,
            entryId: ENTRY_ID,
            payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
            trust: {
              root: "known-log-key",
              keyXy: { base64: utf8OfFile(LOG_KEY_PATH) },
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { status: number; retryAfterMs: number };
    };
    expect(structured.problem.status).toBe(429);
    expect(structured.problem.retryAfterMs).toBe(60_000);
    expect(synthetic.calls).toHaveLength(1);
  });

  it("a rejected fetchImpl on the receipt step yields a network problem, isError:false", async () => {
    const result = await withClient(
      { fetchImpl: rejectingFetch(), env: {} },
      (client) =>
        client.callTool({
          name: "verify_fetched_receipt",
          arguments: {
            receiptUrl: `${BASE_URL}/anything/receipt`,
            entryId: ENTRY_ID,
            payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
            trust: {
              root: "known-log-key",
              keyXy: { base64: utf8OfFile(LOG_KEY_PATH) },
            },
          },
        }),
    );

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as {
      problem: { code: string };
    };
    expect(structured.problem.code).toBe("network");
  });
});
