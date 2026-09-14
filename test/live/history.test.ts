/**
 * Live project (`vitest --project live`), opt-in by `FORESTRIE_LIVE=1` and
 * NEVER a required check (N6 gate 6, N8) — plan-2609-06 F1/F2/F4 exercised
 * against the real publications log (`e8345800-a747-4e62-9409-61622b836f1f`)
 * and the caller's own RPC URL. No setup file here (`vitest.config.ts`'s
 * `live` project): this file deliberately makes real requests through a
 * `fetch` wrapper injected via `Deps.fetchImpl` (never `globalThis.fetch`),
 * counting JSON-RPC calls by method name so each test can assert exactly
 * how many `eth_getLogs` windows its own call opened.
 *
 * Env-gated twice over, as `lane-a.test.ts`: `describe.skipIf` on
 * `FORESTRIE_LIVE` itself, and (inside) a per-test skip naming which of
 * `FORESTRIE_BASE_URL` / `FORESTRIE_RPC_URL` / `UNIVOCITY_ADDRESS` /
 * `CHAIN_ID` is missing. The explicit chain form is used throughout
 * (`{rpcUrl, univocity, logId, chainId}`) — no genesis needed.
 *
 * The publications log's first `CheckpointPublished` is at block
 * 46734813 (`FIRST_CHECKPOINT_BLOCK`); six checkpoints were captured once
 * (blocks 46734813/46734839/46736245/46764135/46764156/46764680, sizes
 * 1/3/4/8/10/11) and the log may have grown since — tests 1 and 4 assert
 * against that superset/shape rather than an exact count. Tests 2 and 3
 * additionally branch on whether the live chain's current `logState`
 * still holds the verifier's own receipt's peak directly (no history
 * scan needed) or has folded past it (the F1/F2 history fallback runs) —
 * both are valid outcomes of a live, moving chain, so each test asserts
 * whichever branch actually ran and logs which one that was.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { decodeKnownAccumulator } from "@forestrie/receipt-verify";
import { createServer, type Deps } from "../../src/node/server.js";
import {
  SUPPORTS,
  type FetchedVerifyResult,
  type Provenance,
  type Supports,
} from "../../src/core/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE_A_DIR = path.join(HERE, "..", "fixtures", "lane-a");
/**
 * Vendored byte-for-byte from the published mcp-verify 0.4.0 tarball's
 * `fixtures/self/` (test/fixtures/lane-a/PROVENANCE.md) — the pair that
 * actually matches `ENTRY_ID` below (mcp-verify 0.4.0's self-registration).
 * NOT the installed mcp-verify's own `fixtures/self/`: that is regenerated
 * at every release (a fresh entry id, statement and receipt each time), so
 * pairing it with this file's pinned `ENTRY_ID` broke the moment
 * mcp-verify moved past 0.4.0.
 */
const LANE_A_RECEIPT_PATH = path.join(LANE_A_DIR, "receipt-self.cbor");
const STATEMENT_COSE_PATH = path.join(LANE_A_DIR, "statement.cose");

const BOOTSTRAP_LOG_ID = "67876864-3b46-67ae-dcb3-13cc81624aa5";
const PUBLICATIONS_LOG_ID = "e8345800-a747-4e62-9409-61622b836f1f";
const MASSIF_HEIGHT = 14;
const ENTRY_ID = "a09a6337ee0009000000000000000008";

const FIRST_CHECKPOINT_BLOCK = 46734813;
const CHUNK = 10_000;
const LATEST_CAPTURED_BLOCK = 46785144;

/** The six checkpoints captured once (1.2) — a superset check, since the
 *  live log may have published more since capture. */
const KNOWN_CHECKPOINTS = [
  { blockNumber: 46734813, size: 1 },
  { blockNumber: 46734839, size: 3 },
  { blockNumber: 46736245, size: 4 },
  { blockNumber: 46764135, size: 8 },
  { blockNumber: 46764156, size: 10 },
  { blockNumber: 46764680, size: 11 },
] as const;

const FORESTRIE_LIVE = process.env["FORESTRIE_LIVE"] === "1";

const REQUIRED_ENV_VARS = [
  "FORESTRIE_BASE_URL",
  "FORESTRIE_RPC_URL",
  "UNIVOCITY_ADDRESS",
  "CHAIN_ID",
] as const;

function missingEnvVars(): string[] {
  return REQUIRED_ENV_VARS.filter((name) => process.env[name] === undefined);
}

function base64OfFile(filePath: string): string {
  return readFileSync(filePath).toString("base64");
}

async function withClient<T>(
  deps: Deps,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(deps);
  await server.connect(serverTransport);
  const client = new Client({ name: "live-history-test", version: "0" });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Wraps the real `fetch` and counts requests by JSON-RPC `method` name
 *  (a non-JSON-RPC body, e.g. the receipt GET, is simply not counted).
 *  Fresh per test — never shared — so each test's own count is exact. */
function createRpcCounter(): {
  fetchImpl: typeof fetch;
  countOf: (method: string) => number;
} {
  const counts = new Map<string, number>();
  const fetchImpl = (async (
    ...args: Parameters<typeof fetch>
  ): Promise<Response> => {
    const init = args[1];
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    if (bodyText !== undefined) {
      try {
        const parsed = JSON.parse(bodyText) as { method?: unknown };
        if (typeof parsed.method === "string") {
          counts.set(parsed.method, (counts.get(parsed.method) ?? 0) + 1);
        }
      } catch {
        // not a JSON body (e.g. the receipt GET) — not a JSON-RPC call.
      }
    }
    return globalThis.fetch(...args);
  }) as typeof fetch;
  return { fetchImpl, countOf: (method) => counts.get(method) ?? 0 };
}

type VerifyStructured = FetchedVerifyResult & {
  provenance: { receipt: Provenance; root: Provenance };
  supports: Supports;
  anchor?: { anchoredSize?: string; blockNumber?: string };
};

type CheckpointHistoryStructured = {
  checkpoints?: Array<{
    size: number;
    blockNumber: number;
    snapshot: string;
  }>;
  scannedFrom?: number;
  scannedTo?: number;
  requests?: number;
  provenance?: Provenance;
  supports: Supports;
  problem?: unknown;
};

type FetchAccumulatorStructured = {
  snapshot?: { base64: string };
  provenance?: Provenance;
  problem?: unknown;
};

describe.skipIf(!FORESTRIE_LIVE)(
  "live: checkpoint history (plan-2609-06 phase 1 step 1.6)",
  () => {
    const missing = missingEnvVars();
    const skipMessage =
      missing.length > 0
        ? `skipped: missing env var(s) ${missing.join(", ")}`
        : undefined;

    function explicitChain(history: Record<string, number>) {
      return {
        rpcUrl: process.env["FORESTRIE_RPC_URL"] as string,
        univocity: (process.env["UNIVOCITY_ADDRESS"] as string).toLowerCase(),
        logId: PUBLICATIONS_LOG_ID,
        chainId: Number(process.env["CHAIN_ID"] as string),
        history,
      };
    }

    it(
      skipMessage ??
        "fetch_checkpoint_history, fromBlock at the first CheckpointPublished: every known checkpoint present, snapshots decode, requests == counted eth_getLogs",
      { skip: skipMessage !== undefined },
      async () => {
        const { fetchImpl, countOf } = createRpcCounter();
        const result = await withClient({ fetchImpl, env: {} }, (client) =>
          client.callTool({
            name: "fetch_checkpoint_history",
            arguments: {
              chain: explicitChain({ fromBlock: FIRST_CHECKPOINT_BLOCK }),
            },
          }),
        );

        expect(result.isError).toBe(false);
        const structured =
          result.structuredContent as CheckpointHistoryStructured;
        expect(structured.problem).toBeUndefined();

        expect(structured.scannedFrom).toBe(FIRST_CHECKPOINT_BLOCK);
        const scannedTo = structured.scannedTo as number;
        expect(scannedTo).toBeGreaterThanOrEqual(LATEST_CAPTURED_BLOCK);

        const expectedRequests = Math.ceil(
          (scannedTo - FIRST_CHECKPOINT_BLOCK + 1) / CHUNK,
        );
        expect(structured.requests).toBe(expectedRequests);
        expect(countOf("eth_getLogs")).toBe(expectedRequests);

        const checkpoints = structured.checkpoints as Array<{
          size: number;
          blockNumber: number;
          snapshot: string;
        }>;
        for (let i = 1; i < checkpoints.length; i++) {
          expect(checkpoints[i - 1]!.blockNumber).toBeGreaterThan(
            checkpoints[i]!.blockNumber,
          );
        }

        for (const known of KNOWN_CHECKPOINTS) {
          expect(
            checkpoints.some(
              (c) =>
                c.blockNumber === known.blockNumber && c.size === known.size,
            ),
            `expected a checkpoint at block ${known.blockNumber} size ${known.size}`,
          ).toBe(true);
        }

        for (const cp of checkpoints) {
          const decoded = decodeKnownAccumulator(
            new Uint8Array(Buffer.from(cp.snapshot, "base64")),
          );
          expect(decoded.size).toBe(BigInt(cp.size));
          expect(decoded.blockNumber).toBe(BigInt(cp.blockNumber));
        }

        expect(structured.provenance?.source).toBe("chain-read");
        expect(structured.supports.note).toBe(
          SUPPORTS.fetch_checkpoint_history.note,
        );
      },
    );

    it(
      skipMessage ??
        "verify_fetched_receipt, known-accumulator chain history: split-view ok, courier diagnostics consistent with provenance.root.history",
      { skip: skipMessage !== undefined },
      async () => {
        const baseUrl = process.env["FORESTRIE_BASE_URL"] as string;
        const { fetchImpl, countOf } = createRpcCounter();

        const result = await withClient({ fetchImpl, env: {} }, (client) =>
          client.callTool({
            name: "verify_fetched_receipt",
            arguments: {
              baseUrl,
              bootstrapLogId: BOOTSTRAP_LOG_ID,
              logId: PUBLICATIONS_LOG_ID,
              massifHeight: MASSIF_HEIGHT,
              entryId: ENTRY_ID,
              payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
              trust: {
                root: "known-accumulator",
                chain: explicitChain({ fromBlock: FIRST_CHECKPOINT_BLOCK }),
              },
            },
          }),
        );

        expect(result.isError).toBe(false);
        const structured = result.structuredContent as VerifyStructured;
        expect(structured.ok).toBe(true);
        expect(structured.questions["split-view"]?.status).toBe("ok");

        const diagnosticCodes = structured.diagnostics.map((d) => d.code);
        expect(diagnosticCodes).toContain("receipt_fetched_from_operator");
        expect(diagnosticCodes).toContain("root_read_from_chain");

        const grew = diagnosticCodes.includes("root_read_from_chain_history");
        const historyProvenance = structured.provenance.root.history;
        const getLogsCount = countOf("eth_getLogs");

        console.error(
          grew
            ? "live history.test.ts test 2: log has folded past the verifier's own peak — history branch ran"
            : "live history.test.ts test 2: verifier's own peak is still in logState directly — no history branch",
        );

        // Assert the two are consistent: the diagnostic and the
        // provenance field agree, in both directions.
        expect(historyProvenance !== undefined).toBe(grew);

        if (grew) {
          expect(getLogsCount).toBeGreaterThan(0);
          expect(historyProvenance?.requests).toBe(getLogsCount);
          const scannedFrom = historyProvenance?.scannedFrom as number;
          const scannedTo = historyProvenance?.scannedTo as number;
          expect(historyProvenance?.requests).toBeLessThanOrEqual(
            Math.ceil((scannedTo - scannedFrom + 1) / CHUNK),
          );
          expect(structured.anchor?.anchoredSize).toBe(
            String(historyProvenance?.size),
          );
        } else {
          expect(getLogsCount).toBe(0);
        }
      },
    );

    it(
      skipMessage ??
        "fetch_accumulator forReceipt, known-accumulator chain history: snapshot decodes, provenance consistent with the counted eth_getLogs calls",
      { skip: skipMessage !== undefined },
      async () => {
        const { fetchImpl, countOf } = createRpcCounter();

        const result = await withClient({ fetchImpl, env: {} }, (client) =>
          client.callTool({
            name: "fetch_accumulator",
            arguments: {
              chain: explicitChain({ fromBlock: FIRST_CHECKPOINT_BLOCK }),
              forReceipt: {
                receipt: { base64: base64OfFile(LANE_A_RECEIPT_PATH) },
                payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
                entryId: ENTRY_ID,
              },
            },
          }),
        );

        expect(result.isError).toBe(false);
        const structured =
          result.structuredContent as FetchAccumulatorStructured;
        expect(structured.problem).toBeUndefined();
        expect(structured.snapshot).toBeDefined();

        const decoded = decodeKnownAccumulator(
          new Uint8Array(
            Buffer.from(
              (structured.snapshot as { base64: string }).base64,
              "base64",
            ),
          ),
        );
        expect(decoded.size).toBeGreaterThan(0n);

        const grew = structured.provenance?.history !== undefined;
        const getLogsCount = countOf("eth_getLogs");

        console.error(
          grew
            ? "live history.test.ts test 3: buried-peak fallback ran — history branch"
            : "live history.test.ts test 3: peak found directly in logState — no history branch",
        );

        if (grew) {
          expect(getLogsCount).toBeGreaterThan(0);
          expect(structured.provenance?.history?.requests).toBe(getLogsCount);
          const scannedFrom = structured.provenance?.history
            ?.scannedFrom as number;
          const scannedTo = structured.provenance?.history
            ?.scannedTo as number;
          expect(structured.provenance?.history?.requests).toBeLessThanOrEqual(
            Math.ceil((scannedTo - scannedFrom + 1) / CHUNK),
          );
        } else {
          expect(getLogsCount).toBe(0);
        }
      },
    );

    it(
      skipMessage ??
        "fetch_checkpoint_history, maxBlocks budget of 15000: exactly 2 eth_getLogs windows",
      { skip: skipMessage !== undefined },
      async () => {
        const { fetchImpl, countOf } = createRpcCounter();
        const result = await withClient({ fetchImpl, env: {} }, (client) =>
          client.callTool({
            name: "fetch_checkpoint_history",
            arguments: {
              chain: explicitChain({ maxBlocks: 15_000 }),
            },
          }),
        );

        expect(result.isError).toBe(false);
        const structured =
          result.structuredContent as CheckpointHistoryStructured;
        expect(structured.problem).toBeUndefined();
        expect(structured.requests).toBe(2);
        expect(countOf("eth_getLogs")).toBe(2);
        expect(
          (structured.scannedTo as number) -
            (structured.scannedFrom as number) +
            1,
        ).toBe(15_000);
      },
    );
  },
);
