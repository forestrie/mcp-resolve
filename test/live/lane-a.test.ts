/**
 * Live project (`vitest --project live`), opt-in by `FORESTRIE_LIVE=1` and
 * NEVER a required check (N6 gate 6, N8) — the orchestrator runs this
 * personally against a captured lane and the caller's own RPC URL; a worker
 * never does. No setup file here (`vitest.config.ts`'s `live` project):
 * this file deliberately makes real requests through the real `fetch`.
 *
 * Env-gated twice over: `describe.skipIf` on `FORESTRIE_LIVE` itself, and
 * (inside) a per-test skip naming which of `FORESTRIE_BASE_URL` /
 * `FORESTRIE_RPC_URL` / `UNIVOCITY_ADDRESS` / `CHAIN_ID` / `GENESIS_CBOR_B64`
 * is missing, so a `FORESTRIE_LIVE=1` run with an incomplete environment
 * fails loud rather than silently no-op'ing.
 *
 * Exactly three lane requests and one three-call chain read across the
 * whole file (plan-2609-05 step 2.5): `globalThis.fetch` is wrapped in a
 * counter for the file's duration (real `fetch` underneath — this project
 * has no forbidden-fetch setup) and the final test asserts the total.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyReceipt } from "@forestrie/mcp-verify";
import { decodeCborDeterministic } from "@forestrie/encoding";
import { decodeReceiptLogId } from "../../src/core/index.js";
import { createServer, type Deps } from "../../src/node/server.js";
import type {
  FetchedVerifyResult,
  Provenance,
  Supports,
} from "../../src/core/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE_A_DIR = path.join(HERE, "..", "fixtures", "lane-a");
/**
 * Vendored byte-for-byte from the published mcp-verify 0.4.0 tarball's
 * `fixtures/self/` (test/fixtures/lane-a/PROVENANCE.md) — the pair that
 * actually matches `ENTRY_ID` below (mcp-verify 0.4.0's self-registration,
 * which is what this file's live fetches read back). NOT the installed
 * mcp-verify's own `fixtures/self/`: that is regenerated at every release
 * (a fresh entry id, statement and receipt each time), so pairing it with
 * this file's pinned `ENTRY_ID` broke the moment mcp-verify moved past
 * 0.4.0.
 */
const LANE_A_RECEIPT_PATH = path.join(LANE_A_DIR, "receipt-self.cbor");
const STATEMENT_COSE_PATH = path.join(LANE_A_DIR, "statement.cose");
const LOG_KEY_PATH = path.join(LANE_A_DIR, "log-key.xy.b64");

const BOOTSTRAP_LOG_ID = "67876864-3b46-67ae-dcb3-13cc81624aa5";
const PUBLICATIONS_LOG_ID = "e8345800-a747-4e62-9409-61622b836f1f";
const MASSIF_HEIGHT = 14;
const ENTRY_ID = "a09a6337ee0009000000000000000008";

/** The parts of a COSE_Sign1 receipt that must not change between serves. */
interface ReceiptParts {
  protectedHeader: Uint8Array;
  payload: Uint8Array | null;
  certificateProtectedHeader: Uint8Array | undefined;
  certificateLogId: string | undefined;
  mmrIndex: unknown;
  path: Uint8Array[];
}

function asIntKeyMap(value: unknown): Map<number, unknown> {
  if (value instanceof Map) return value as Map<number, unknown>;
  const out = new Map<number, unknown>();
  for (const [key, entry] of Object.entries(
    (value ?? {}) as Record<string, unknown>,
  )) {
    out.set(Number(key), entry);
  }
  return out;
}

/**
 * Decode a receipt into the parts that identify it: the protected header,
 * the payload, the delegation certificate (unprotected label 1000), and the
 * inclusion proof for its entry (label 396, then -1, then the first proof's
 * {1: MMR index, 2: path}).
 */
function unwrapTag(value: unknown): unknown {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    "value" in value
    ? (value as { value: unknown }).value
    : value;
}

/** The protected header of the delegation certificate's own COSE_Sign1. */
function certificateProtectedHeader(
  certificate: unknown,
): Uint8Array | undefined {
  if (!(certificate instanceof Uint8Array)) return undefined;
  const sign1 = unwrapTag(decodeCborDeterministic(certificate)) as unknown[];
  return sign1[0] as Uint8Array;
}

function receiptParts(bytes: Uint8Array): ReceiptParts {
  let sign1 = decodeCborDeterministic(bytes) as unknown;
  if (
    sign1 !== null &&
    typeof sign1 === "object" &&
    !Array.isArray(sign1) &&
    "value" in sign1
  ) {
    sign1 = (sign1 as { value: unknown }).value;
  }
  const [protectedHeader, unprotected, payload] = sign1 as [
    Uint8Array,
    unknown,
    Uint8Array | null,
    Uint8Array,
  ];
  const header = asIntKeyMap(unprotected);
  const proofs = asIntKeyMap(header.get(396)).get(-1) as unknown[];
  const proof = asIntKeyMap(proofs[0]);
  return {
    protectedHeader,
    payload,
    certificateProtectedHeader: certificateProtectedHeader(header.get(1000)),
    certificateLogId: decodeReceiptLogId(bytes)?.logId,
    mmrIndex: proof.get(1),
    path: proof.get(2) as Uint8Array[],
  };
}

const FORESTRIE_LIVE = process.env["FORESTRIE_LIVE"] === "1";

const REQUIRED_ENV_VARS = [
  "FORESTRIE_BASE_URL",
  "FORESTRIE_RPC_URL",
  "UNIVOCITY_ADDRESS",
  "CHAIN_ID",
  "GENESIS_CBOR_B64",
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
  const client = new Client({ name: "live-lane-a-test", version: "0" });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

type VerifyStructured = FetchedVerifyResult & {
  provenance: { receipt: Provenance; root: Provenance };
  supports: Supports;
};

describe.skipIf(!FORESTRIE_LIVE)(
  "live: lane A, the verifier's own release entry (plan-2609-05 step 2.5)",
  () => {
    const missing = missingEnvVars();
    const skipMessage =
      missing.length > 0
        ? `skipped: missing env var(s) ${missing.join(", ")}`
        : undefined;

    let requestCount = 0;
    let realFetch: typeof fetch | undefined;

    beforeAll(() => {
      if (skipMessage !== undefined) return;
      realFetch = globalThis.fetch;
      const counted = realFetch;
      globalThis.fetch = (async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        requestCount += 1;
        return counted(...args);
      }) as typeof fetch;
    });

    afterAll(() => {
      if (realFetch !== undefined) {
        globalThis.fetch = realFetch;
      }
    });

    it(
      skipMessage ??
        "fetch_receipt (five-field form): the same receipt as the bundled copy (header and MMR index identical, certificate naming the same log, bundled proof a prefix of the served proof) and verifies identically under known-log-key",
      { skip: skipMessage !== undefined },
      async () => {
        const baseUrl = process.env["FORESTRIE_BASE_URL"] as string;
        const result = await withClient({ env: {} }, (client) =>
          client.callTool({
            name: "fetch_receipt",
            arguments: {
              baseUrl,
              bootstrapLogId: BOOTSTRAP_LOG_ID,
              logId: PUBLICATIONS_LOG_ID,
              massifHeight: MASSIF_HEIGHT,
              entryId: ENTRY_ID,
            },
          }),
        );

        expect(result.isError).toBe(false);
        const structured = result.structuredContent as {
          receipt: { base64: string };
        };
        const fetchedBytes = Buffer.from(structured.receipt.base64, "base64");
        const bundledBytes = readFileSync(LANE_A_RECEIPT_PATH);

        // Amendment A: the operator signs afresh on every serve (ECDSA is
        // randomised), so the signature bytes always differ. And once the
        // log grows past a fold, the served receipt's inclusion proof for
        // the same entry extends the bundled one: the MMR is append-only,
        // so the bundled path is a prefix of the served path. Lane A showed
        // this on 2026-09-14, path 1 -> 3 hashes after two new registrations
        // (plan-2609-06 phase 2 gate). The delegation certificate is
        // re-issued too: its issued-at, expiry, id and signature change (the
        // same day, the verifier's release ran `forestrie delegate
        // --ttl-seconds 86400`), so it must keep its protected header and
        // name the same log, and the known-log-key comparison below proves
        // it still chains to the same key. Everything else must be identical.
        const fetched = receiptParts(new Uint8Array(fetchedBytes));
        const bundled = receiptParts(new Uint8Array(bundledBytes));
        expect(fetched.protectedHeader).toEqual(bundled.protectedHeader);
        expect(fetched.payload).toEqual(bundled.payload);
        expect(fetched.certificateProtectedHeader).toEqual(
          bundled.certificateProtectedHeader,
        );
        expect(fetched.certificateLogId).toBe(PUBLICATIONS_LOG_ID);
        expect(bundled.certificateLogId).toBe(PUBLICATIONS_LOG_ID);
        expect(fetched.mmrIndex).toEqual(bundled.mmrIndex);
        expect(fetched.path.length).toBeGreaterThanOrEqual(
          bundled.path.length,
        );
        expect(fetched.path.slice(0, bundled.path.length)).toEqual(
          bundled.path,
        );

        const keyXy = new Uint8Array(
          Buffer.from(readFileSync(LOG_KEY_PATH, "utf8").trim(), "base64"),
        );
        const statementCose = new Uint8Array(
          readFileSync(STATEMENT_COSE_PATH),
        );
        const fetchedVerify = await verifyReceipt({
          receipt: new Uint8Array(fetchedBytes),
          payload: statementCose,
          entryId: ENTRY_ID,
          trust: { root: "known-log-key", keyXy },
        });
        const bundledVerify = await verifyReceipt({
          receipt: new Uint8Array(bundledBytes),
          payload: statementCose,
          entryId: ENTRY_ID,
          trust: { root: "known-log-key", keyXy },
        });
        expect(fetchedVerify.questions).toEqual(bundledVerify.questions);
      },
    );

    it(
      skipMessage ??
        "verify_fetched_receipt, root:'genesis' (supplied bytes): questions equal the verifier's own verifyReceipt under the same genesis",
      { skip: skipMessage !== undefined },
      async () => {
        const baseUrl = process.env["FORESTRIE_BASE_URL"] as string;
        const genesisB64 = process.env["GENESIS_CBOR_B64"] as string;

        const result = await withClient({ env: {} }, (client) =>
          client.callTool({
            name: "verify_fetched_receipt",
            arguments: {
              baseUrl,
              bootstrapLogId: BOOTSTRAP_LOG_ID,
              logId: PUBLICATIONS_LOG_ID,
              massifHeight: MASSIF_HEIGHT,
              entryId: ENTRY_ID,
              payload: { base64: base64OfFile(STATEMENT_COSE_PATH) },
              trust: { root: "genesis", genesis: { base64: genesisB64 } },
            },
          }),
        );

        expect(result.isError).toBe(false);
        const structured = result.structuredContent as VerifyStructured;

        // This is the composed tool's ONE receipt request for this test —
        // its structuredContent carries no raw receipt bytes (only
        // fetch_receipt's does), so a second fetch to get "the same bytes"
        // for a direct-call comparison would break the one-request budget.
        // Amendment A (asserted in the previous test on this same run)
        // established the fetched and bundled receipts are byte-identical
        // outside the COSE signature, and the genesis root's failure here
        // is expected at delegation resolution (docs/self-registration.md:
        // the publications log is a grandchild the offline genesis walk
        // does not reach) — a stage the randomised signature bytes never
        // reach, so the bundled receipt is "the same bytes" for this
        // comparison's purposes.
        const direct = await verifyReceipt({
          receipt: new Uint8Array(readFileSync(LANE_A_RECEIPT_PATH)),
          payload: new Uint8Array(readFileSync(STATEMENT_COSE_PATH)),
          entryId: ENTRY_ID,
          trust: {
            root: "genesis",
            genesis: new Uint8Array(Buffer.from(genesisB64, "base64")),
          },
        });
        expect(structured.questions).toEqual(direct.questions);

        const diagnosticCodes = structured.diagnostics.map((d) => d.code);
        expect(diagnosticCodes).toContain("receipt_fetched_from_operator");
        expect(diagnosticCodes).not.toContain("root_read_from_chain");
      },
    );

    it(
      skipMessage ??
        "verify_fetched_receipt, root:'known-accumulator' (held-genesis chain): one receipt request + three RPC calls, split-view answered",
      { skip: skipMessage !== undefined },
      async () => {
        const baseUrl = process.env["FORESTRIE_BASE_URL"] as string;
        const rpcUrl = process.env["FORESTRIE_RPC_URL"] as string;
        const genesisB64 = process.env["GENESIS_CBOR_B64"] as string;
        const univocity = (
          process.env["UNIVOCITY_ADDRESS"] as string
        ).toLowerCase();
        const chainId = Number(process.env["CHAIN_ID"] as string);

        const result = await withClient({ env: {} }, (client) =>
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
                chain: {
                  genesis: { base64: genesisB64 },
                  rpcUrl,
                  logId: PUBLICATIONS_LOG_ID,
                },
              },
            },
          }),
        );

        expect(result.isError).toBe(false);
        const structured = result.structuredContent as VerifyStructured;
        expect(structured.root).toBe("known-accumulator");

        const splitView = structured.questions["split-view"];
        expect(
          splitView?.status,
          `split-view was not "ok": ${JSON.stringify(splitView)}`,
        ).toBe("ok");

        expect(structured.diagnostics.map((d) => d.code)).toContain(
          "root_read_from_chain",
        );
        expect(structured.provenance.root.binding).toBe("held-genesis");
        expect(structured.provenance.root.source).toBe("chain-read");
        if (typeof structured.provenance.root.from === "object") {
          expect(structured.provenance.root.from.chainId).toBe(chainId);
          expect(structured.provenance.root.from.univocity).toBe(univocity);
        } else {
          throw new Error(
            "chain-read provenance.from was a string, expected {rpcUrl, univocity, chainId}",
          );
        }
      },
    );

    it(
      skipMessage ??
        "counts exactly three lane requests and one three-call chain read across the file",
      { skip: skipMessage !== undefined },
      () => {
        // Test 1: one receipt GET. Test 2: one receipt GET. Test 3: one
        // receipt GET + eth_chainId + eth_getBlockByNumber + eth_call.
        // 1 + 1 + (1 + 3) = 6 raw fetch() calls; "three lane requests and
        // one chain read" in the plan's own words.
        expect(requestCount).toBe(6);
      },
    );
  },
);
