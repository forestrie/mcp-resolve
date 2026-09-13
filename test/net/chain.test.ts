import { decodeKnownAccumulator } from "@forestrie/receipt-verify";
import { describe, expect, it } from "vitest";
import {
  fetchAccumulatorSnapshot,
  readLogState,
} from "../../src/net/index.js";
import { createChainReplay } from "./replay.js";

const RPC_URL = "https://rpc.example/anything";
const LOG_ID = "e8345800-a747-4e62-9409-61622b836f1f";
const UNIVOCITY = "0x678768643b4667aedcb313cc81624aa560b7f0ca";
const CHAIN_ID = 84532;
const BLOCK_NUMBER = 46770471n;
const BLOCK_HASH =
  "0x713c531b734b5c1edb5c89e0182fdd6b52d0b9c80fd2bf0a395847b39091e170";

describe("readLogState", () => {
  it("makes the three calls in order and decodes the fixture's values", async () => {
    const replay = await createChainReplay();

    const result = await readLogState(
      { rpcUrl: RPC_URL, univocity: UNIVOCITY, logId: LOG_ID },
      { fetchImpl: replay.fetch },
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.chainId).toBe(CHAIN_ID);
    expect(result.blockNumber).toBe(BLOCK_NUMBER);
    expect(result.blockHash).toBe(BLOCK_HASH);
    expect(result.resultHex).toBe(
      (replay.fixture.calls["eth_call"]!.response as { result: string })
        .result,
    );
    expect(result.rpcUrl).toBe(RPC_URL);
    expect(result.univocity).toBe(UNIVOCITY);

    expect(replay.calls).toHaveLength(3);
    const bodies = replay.calls.map(
      (c) =>
        JSON.parse(String(c.init?.body)) as {
          method: string;
          params: unknown[];
        },
    );
    expect(bodies.map((b) => b.method)).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_call",
    ]);
    expect(bodies[0]?.params).toEqual(
      replay.fixture.calls["eth_chainId"]!.request.params,
    );
    expect(bodies[1]?.params).toEqual(
      replay.fixture.calls["eth_getBlockByNumber"]!.request.params,
    );
    expect(bodies[2]?.params).toEqual(
      replay.fixture.calls["eth_call"]!.request.params,
    );
    for (const call of replay.calls) {
      expect(call.init?.headers).toMatchObject({
        "content-type": "application/json",
      });
    }
  });

  it("returns rpc_chain_id_mismatch after exactly one call when expectedChainId differs", async () => {
    const replay = await createChainReplay();

    const result = await readLogState(
      {
        rpcUrl: RPC_URL,
        univocity: UNIVOCITY,
        logId: LOG_ID,
        expectedChainId: 1,
      },
      { fetchImpl: replay.fetch },
    );

    expect(result).toEqual({
      kind: "problem",
      problem: {
        code: "rpc_chain_id_mismatch",
        expected: 1,
        actual: CHAIN_ID,
      },
    });
    expect(replay.calls).toHaveLength(1);
  });

  it("returns rpc_error for a JSON-RPC error body", async () => {
    const replay = await createChainReplay({
      eth_chainId: {
        status: 200,
        response: {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "boom" },
        },
      },
    });

    const result = await readLogState(
      { rpcUrl: RPC_URL, univocity: UNIVOCITY, logId: LOG_ID },
      { fetchImpl: replay.fetch },
    );

    expect(result).toEqual({
      kind: "problem",
      problem: { code: "rpc_error", status: 200, message: "boom" },
    });
    expect(replay.calls).toHaveLength(1);
  });

  it("throws NetError(network) when fetchImpl rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    await expect(
      readLogState(
        { rpcUrl: RPC_URL, univocity: UNIVOCITY, logId: LOG_ID },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ name: "NetError", code: "network" });
  });

  it("throws NetError(timeout) when fetchImpl never settles", async () => {
    const fetchImpl = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;

    await expect(
      readLogState(
        { rpcUrl: RPC_URL, univocity: UNIVOCITY, logId: LOG_ID },
        { fetchImpl, timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ name: "NetError", code: "timeout" });
  });
});

describe("fetchAccumulatorSnapshot", () => {
  it("builds a snapshot that round-trips through decodeKnownAccumulator", async () => {
    const replay = await createChainReplay();

    const result = await fetchAccumulatorSnapshot(
      { rpcUrl: RPC_URL, univocity: UNIVOCITY, logId: LOG_ID },
      { fetchImpl: replay.fetch },
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");

    // The eth_call result decodes to 3 peaks and MMR size 11 (checked by
    // hand against the fixture bytes).
    expect(result.accumulator).toHaveLength(3);
    expect(result.size).toBe(11n);

    const decoded = decodeKnownAccumulator(result.snapshot);
    expect(decoded.version).toBe(1);
    expect(decoded.chainId).toBe(BigInt(CHAIN_ID));
    expect(Buffer.from(decoded.univocity).toString("hex")).toBe(
      UNIVOCITY.slice(2),
    );
    expect(Buffer.from(decoded.logId).toString("hex")).toBe(
      LOG_ID.replace(/-/g, "").padStart(64, "0"),
    );
    expect(decoded.blockNumber).toBe(BLOCK_NUMBER);
    expect(Buffer.from(decoded.blockHash).toString("hex")).toBe(
      BLOCK_HASH.slice(2),
    );
    expect(decoded.size).toBe(11n);
    expect(decoded.accumulator).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(Buffer.from(decoded.accumulator[i]!)).toEqual(
        Buffer.from(result.accumulator[i]!),
      );
    }
  });

  it("carries through a chain-level problem unchanged", async () => {
    const replay = await createChainReplay();

    const result = await fetchAccumulatorSnapshot(
      {
        rpcUrl: RPC_URL,
        univocity: UNIVOCITY,
        logId: LOG_ID,
        expectedChainId: 1,
      },
      { fetchImpl: replay.fetch },
    );

    expect(result).toEqual({
      kind: "problem",
      problem: {
        code: "rpc_chain_id_mismatch",
        expected: 1,
        actual: CHAIN_ID,
      },
    });
  });
});
