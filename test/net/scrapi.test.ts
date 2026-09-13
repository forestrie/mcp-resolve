import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classify } from "../../src/core/index.js";
import {
  NetError,
  fetchGenesis,
  fetchReceipt,
  fetchScittConfiguration,
  queryRegistration,
  toClassifyView,
} from "../../src/net/index.js";
import { createLaneAReplay } from "./replay.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE_A_DIR = path.join(HERE, "..", "fixtures", "lane-a");

const BASE_URL = "https://api-a.forest-2.forestrie.dev";
const BOOTSTRAP_LOG_ID = "67876864-3b46-67ae-dcb3-13cc81624aa5";
const PUBLICATIONS_LOG_ID = "e8345800-a747-4e62-9409-61622b836f1f";
const SELF_CONTENT_HASH =
  "7c29bb57bae35044f722f4842c91a38b6fae51a5405a95caf9b27c9b894e2166";
const UNKNOWN_CONTENT_HASH = "0".repeat(64);
const MASSIF_HEIGHT = 14;
const ENTRY_ID = "a09a6337ee0009000000000000000008";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function manifest(): Promise<Record<string, string>> {
  const raw = await readFile(path.join(LANE_A_DIR, "manifest.json"), "utf8");
  return (JSON.parse(raw) as { files: Record<string, string> }).files;
}

describe("fetchScittConfiguration", () => {
  it("replays the well-known fixture", async () => {
    const replay = await createLaneAReplay();
    const files = await manifest();

    const raw = await fetchScittConfiguration(
      { baseUrl: BASE_URL },
      { fetchImpl: replay.fetch },
    );

    expect(raw.url).toBe(replay.urls["well-known"]);
    expect(raw.status).toBe(200);
    expect(raw.headers["content-type"]).toBe("application/json");
    expect(sha256(raw.body)).toBe(files["well-known.json"]);

    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]?.init?.redirect).toBe("manual");
  });

  it("throws NetError(network) when fetchImpl rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    await expect(
      fetchScittConfiguration({ baseUrl: BASE_URL }, { fetchImpl }),
    ).rejects.toMatchObject({ name: "NetError", code: "network" });
    await expect(
      fetchScittConfiguration({ baseUrl: BASE_URL }, { fetchImpl }),
    ).rejects.toBeInstanceOf(NetError);
  });

  it("throws NetError(timeout) when fetchImpl never settles", async () => {
    const fetchImpl = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;

    await expect(
      fetchScittConfiguration(
        { baseUrl: BASE_URL },
        { fetchImpl, timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ name: "NetError", code: "timeout" });
  });
});

describe("queryRegistration", () => {
  it("replays status-self: 303 to the receipt URL, classifies as receipt-location", async () => {
    const replay = await createLaneAReplay();

    const raw = await queryRegistration(
      {
        baseUrl: BASE_URL,
        bootstrapLogId: BOOTSTRAP_LOG_ID,
        logId: PUBLICATIONS_LOG_ID,
        contentHash: SELF_CONTENT_HASH,
      },
      { fetchImpl: replay.fetch },
    );

    expect(raw.url).toBe(replay.urls["status-self"]);
    expect(raw.status).toBe(303);
    expect(raw.headers["location"]).toBe(replay.urls["receipt-self"]);

    const classified = classify("registration", toClassifyView(raw), BASE_URL);
    expect(classified).toEqual({
      kind: "receipt-location",
      receiptUrl: replay.urls["receipt-self"],
      entryIdHex: ENTRY_ID,
    });

    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]?.init?.redirect).toBe("manual");
  });

  it("replays status-unknown: 303 pending with retryAfterMs 1000", async () => {
    const replay = await createLaneAReplay();

    const raw = await queryRegistration(
      {
        baseUrl: BASE_URL,
        bootstrapLogId: BOOTSTRAP_LOG_ID,
        logId: PUBLICATIONS_LOG_ID,
        contentHash: UNKNOWN_CONTENT_HASH,
      },
      { fetchImpl: replay.fetch },
    );

    expect(raw.status).toBe(303);
    expect(raw.headers["retry-after"]).toBe("1");

    const classified = classify("registration", toClassifyView(raw), BASE_URL);
    expect(classified).toEqual({
      kind: "pending",
      location: replay.urls["status-unknown"],
      retryAfterMs: 1000,
    });

    expect(replay.calls).toHaveLength(1);
  });

  it("throws NetError(network) when fetchImpl rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    await expect(
      queryRegistration(
        {
          baseUrl: BASE_URL,
          bootstrapLogId: BOOTSTRAP_LOG_ID,
          logId: PUBLICATIONS_LOG_ID,
          contentHash: SELF_CONTENT_HASH,
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ name: "NetError", code: "network" });
  });

  it("throws NetError(timeout) when fetchImpl never settles", async () => {
    const fetchImpl = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;

    await expect(
      queryRegistration(
        {
          baseUrl: BASE_URL,
          bootstrapLogId: BOOTSTRAP_LOG_ID,
          logId: PUBLICATIONS_LOG_ID,
          contentHash: SELF_CONTENT_HASH,
        },
        { fetchImpl, timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ name: "NetError", code: "timeout" });
  });
});

describe("fetchReceipt", () => {
  it("replays receipt-self via the constructed URL", async () => {
    const replay = await createLaneAReplay();
    const files = await manifest();

    const raw = await fetchReceipt(
      {
        baseUrl: BASE_URL,
        bootstrapLogId: BOOTSTRAP_LOG_ID,
        logId: PUBLICATIONS_LOG_ID,
        massifHeight: MASSIF_HEIGHT,
        entryId: ENTRY_ID,
      },
      { fetchImpl: replay.fetch },
    );

    expect(raw.url).toBe(replay.urls["receipt-self"]);
    expect(raw.status).toBe(200);
    expect(raw.headers["content-type"]).toBe("application/scitt-receipt+cbor");
    expect(sha256(raw.body)).toBe(files["receipt-self.cbor"]);

    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]?.init?.redirect).toBe("manual");
  });

  it("replays receipt-self via a receiptUrl obtained from query_registration", async () => {
    const replay = await createLaneAReplay();

    const raw = await fetchReceipt(
      { receiptUrl: replay.urls["receipt-self"]! },
      { fetchImpl: replay.fetch },
    );

    expect(raw.status).toBe(200);
    expect(raw.headers["content-type"]).toBe("application/scitt-receipt+cbor");
    expect(replay.calls).toHaveLength(1);
  });

  it("throws NetError(network) when fetchImpl rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    await expect(
      fetchReceipt({ receiptUrl: `${BASE_URL}/receipt` }, { fetchImpl }),
    ).rejects.toMatchObject({ name: "NetError", code: "network" });
  });

  it("throws NetError(timeout) when fetchImpl never settles", async () => {
    const fetchImpl = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;

    await expect(
      fetchReceipt(
        { receiptUrl: `${BASE_URL}/receipt` },
        { fetchImpl, timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ name: "NetError", code: "timeout" });
  });
});

describe("fetchGenesis", () => {
  it("replays the genesis fixture", async () => {
    const replay = await createLaneAReplay();
    const files = await manifest();

    const raw = await fetchGenesis(
      { baseUrl: BASE_URL, logId: BOOTSTRAP_LOG_ID },
      { fetchImpl: replay.fetch },
    );

    expect(raw.url).toBe(replay.urls["genesis"]);
    expect(raw.status).toBe(200);
    expect(raw.headers["content-type"]).toBe("application/cbor");
    expect(sha256(raw.body)).toBe(files["genesis.cbor"]);

    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]?.init?.redirect).toBe("manual");
  });

  it("throws NetError(network) when fetchImpl rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    await expect(
      fetchGenesis(
        { baseUrl: BASE_URL, logId: BOOTSTRAP_LOG_ID },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ name: "NetError", code: "network" });
  });

  it("throws NetError(timeout) when fetchImpl never settles", async () => {
    const fetchImpl = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;

    await expect(
      fetchGenesis(
        { baseUrl: BASE_URL, logId: BOOTSTRAP_LOG_ID },
        { fetchImpl, timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ name: "NetError", code: "timeout" });
  });
});
