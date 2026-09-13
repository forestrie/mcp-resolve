/**
 * Fake `fetch` functions built from the frozen recorded-exchange fixtures
 * (`test/fixtures/lane-a/`, `test/fixtures/chain/`), for `test/net/**` to
 * inject through `fetchImpl` — never `globalThis.fetch`, which the unit
 * project's `test/setup/forbid-fetch.ts` already replaces with a thrower
 * (N6 gate 2). This module never touches `globalThis.fetch` itself.
 *
 * Lane A: keyed by the exact URL each `*.meta.json` recorded, so a test
 * never hand-types a URL that could drift from the fixture. Any URL not in
 * the map throws — a test asking for something that was never captured is
 * a bug in the test, not a fixture gap.
 *
 * Chain: keyed by JSON-RPC method — `readLogState` makes all three calls
 * against one `rpcUrl`, so routing by method (asserting the incoming
 * request's `method`/`params` match the fixture's recorded request,
 * ignoring `id`) is what the fixture actually captured.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE_A_DIR = path.join(HERE, "..", "fixtures", "lane-a");
const CHAIN_DIR = path.join(HERE, "..", "fixtures", "chain");

export type ReplayCall = { url: string; init: RequestInit | undefined };

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/* ---- Lane A: SCRAPI HTTP fixtures ---- */

type LaneAMeta = {
  url: string;
  status: number;
  headers: Record<string, string>;
};

/** `<name>.meta.json` -> the body file recorded alongside it, if any
 *  (a 303 has no body). */
const LANE_A_BODY_FILES: Record<string, string | undefined> = {
  "well-known": "well-known.json",
  genesis: "genesis.cbor",
  "status-self": undefined,
  "receipt-self": "receipt-self.cbor",
  "status-unknown": undefined,
};

export type LaneAReplay = {
  fetch: typeof fetch;
  calls: ReplayCall[];
  /** The URL each fixture was recorded against, keyed by fixture name —
   *  so a test can address `urls["receipt-self"]` instead of retyping the
   *  URL from PROVENANCE.md. */
  urls: Record<string, string>;
};

export async function createLaneAReplay(): Promise<LaneAReplay> {
  const entries = new Map<
    string,
    { status: number; headers: Record<string, string>; body: Uint8Array }
  >();
  const urls: Record<string, string> = {};

  for (const [name, bodyFile] of Object.entries(LANE_A_BODY_FILES)) {
    const metaRaw = await readFile(
      path.join(LANE_A_DIR, `${name}.meta.json`),
      "utf8",
    );
    const meta = JSON.parse(metaRaw) as LaneAMeta;
    const body =
      bodyFile === undefined
        ? new Uint8Array(0)
        : new Uint8Array(await readFile(path.join(LANE_A_DIR, bodyFile)));
    entries.set(meta.url, {
      status: meta.status,
      headers: meta.headers,
      body,
    });
    urls[name] = meta.url;
  }

  const calls: ReplayCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    calls.push({ url, init });
    const entry = entries.get(url);
    if (entry === undefined) {
      throw new Error(`replay: no lane-a fixture recorded for URL ${url}`);
    }
    return new Response(entry.body as unknown as BodyInit, {
      status: entry.status,
      headers: entry.headers,
    });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, calls, urls };
}

/* ---- Chain: JSON-RPC fixtures ---- */

type ChainCallFixture = {
  request: { jsonrpc: string; id: number; method: string; params: unknown[] };
  status: number;
  response: unknown;
};

type ChainFixtureFile = {
  logId: string;
  univocity: string;
  chainId: string;
  blockNumber: string;
  blockHash: string;
  calls: Record<string, ChainCallFixture>;
};

export type ChainReplay = {
  fetch: typeof fetch;
  calls: ReplayCall[];
  fixture: ChainFixtureFile;
};

export type ChainReplayOverride = { status: number; response: unknown };

/**
 * @param overrides Per-method response overrides (e.g. to synthesise a
 *   JSON-RPC error body for `eth_chainId`) — the fixture's recorded
 *   request/params are still the ones checked against the incoming call.
 */
export async function createChainReplay(
  overrides?: Record<string, ChainReplayOverride>,
): Promise<ChainReplay> {
  const raw = await readFile(
    path.join(CHAIN_DIR, "logState.46770471.json"),
    "utf8",
  );
  const fixture = JSON.parse(raw) as ChainFixtureFile;

  const calls: ReplayCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    calls.push({ url, init });

    const bodyText =
      typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    let parsed: { id?: unknown; method?: unknown; params?: unknown };
    try {
      parsed = JSON.parse(bodyText) as typeof parsed;
    } catch (err) {
      throw new Error(
        `replay: chain request body is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const method = parsed.method;
    if (typeof method !== "string") {
      throw new Error("replay: chain request body has no method");
    }

    const recorded = fixture.calls[method];
    if (recorded === undefined) {
      throw new Error(
        `replay: no chain fixture recorded for method ${method}`,
      );
    }
    if (
      JSON.stringify(parsed.params) !== JSON.stringify(recorded.request.params)
    ) {
      throw new Error(
        `replay: params mismatch for ${method}: expected ${JSON.stringify(recorded.request.params)}, got ${JSON.stringify(parsed.params)}`,
      );
    }

    const override = overrides?.[method];
    const status = override?.status ?? recorded.status;
    const response = override?.response ?? recorded.response;
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, calls, fixture };
}
