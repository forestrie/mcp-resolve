/**
 * The MCP surface, over the SDK's in-memory transport pair.
 *
 * In-memory rather than a spawned process: it is faster and it exercises the
 * same `Server`/`Client` protocol code. The one thing it CANNOT catch is a
 * stray `console.log` corrupting the stdio framing — that needs a real
 * process, and it lives in `pnpm run check:stdio-clean`.
 *
 * This file runs under the forbidden-fetch global (N6 gate 2), so it is
 * simultaneously the proof that starting this server touches no network.
 *
 * Phase 1 (this repo's bootstrap): no tools are registered yet, so this
 * test only proves the server identifies itself correctly and advertises
 * an empty tool list. test/node/mcp-smoke.test.ts grows tool assertions in
 * phase 2 as they land.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/node/server.js";
import { PACKAGE_VERSION } from "../../src/core/index.js";

const repoRoot = new URL("../../", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8")) as {
  version: string;
};

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer();
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
  it("is empty in this build", async () => {
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
  });
});
