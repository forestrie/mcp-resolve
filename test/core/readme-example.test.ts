/**
 * The README's worked example names lane-A coordinates. This keeps them
 * honest mechanically: every id, address and chain id in that section
 * must equal what the recorded fixtures say (`test/fixtures/lane-a/`,
 * `test/fixtures/chain/`, and the genesis document itself), so a fixture
 * re-capture that moved a value would fail here rather than leaving the
 * published example pointing at a log that no longer matches. No network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeChainBindingFromGenesis } from "../../src/core/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const LANE_A_DIR = path.join(REPO_ROOT, "test", "fixtures", "lane-a");
const CHAIN_DIR = path.join(REPO_ROOT, "test", "fixtures", "chain");

const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
const section =
  readme.split(/^## A worked example/m)[1]?.split(/^## /m)[0] ?? "";
/** Prettier may rewrap prose; compare on one line. */
const flat = section.replace(/\s+/g, " ");

/** `const NAME = "value";` out of the live test, so the README and the
 *  live run cannot name different coordinates. */
function liveConst(name: string): string {
  const src = readFileSync(
    path.join(REPO_ROOT, "test", "live", "lane-a.test.ts"),
    "utf8",
  );
  const m = src.match(new RegExp(`const ${name} = "([^"]+)";`));
  if (m === null) throw new Error(`test/live/lane-a.test.ts has no ${name}`);
  return m[1] as string;
}

describe("README worked example", () => {
  it("exists", () => {
    expect(section.length).toBeGreaterThan(0);
  });

  it("names the lane-A base URL and the two log ids the live test and fixtures use", () => {
    const meta = JSON.parse(
      readFileSync(path.join(LANE_A_DIR, "status-self.meta.json"), "utf8"),
    ) as { url: string };
    const baseUrl = new URL(meta.url).origin;
    expect(section).toContain(baseUrl);
    for (const name of ["BOOTSTRAP_LOG_ID", "PUBLICATIONS_LOG_ID"]) {
      const value = liveConst(name);
      expect(section, name).toContain(value);
      expect(meta.url, `${name} in the recorded status URL`).toContain(value);
    }
  });

  it("names the chain id and univocity address bound in the recorded genesis, and the recorded logState's", () => {
    const genesis = new Uint8Array(
      readFileSync(path.join(LANE_A_DIR, "genesis.cbor")),
    );
    const binding = decodeChainBindingFromGenesis(genesis);
    expect(section).toContain(`id ${binding.chainId} `);
    expect(section).toContain(binding.univocity);
    const chain = JSON.parse(
      readFileSync(path.join(CHAIN_DIR, "logState.46770471.json"), "utf8"),
    ) as { chainId: string; univocity: string; logId: string };
    expect(Number(chain.chainId)).toBe(binding.chainId);
    expect(chain.univocity.toLowerCase()).toBe(
      binding.univocity.toLowerCase(),
    );
    expect(section).toContain(chain.logId);
  });

  it("names the massif height the recorded receipt URL carries, and never asks the reader to type one", () => {
    const meta = JSON.parse(
      readFileSync(path.join(LANE_A_DIR, "receipt-self.meta.json"), "utf8"),
    ) as { url: string };
    const height = meta.url.match(/\/(\d+)\/entries\//)?.[1];
    expect(height).toBe("14");
    expect(flat).toContain("massif height, 14, inside it");
    expect(flat).toMatch(/\| massif height\s+\| never typed/);
  });

  it("lists the example RPC endpoints as third-party examples, not defaults", () => {
    for (const url of [
      "https://sepolia.base.org",
      "https://base-sepolia-rpc.publicnode.com",
      "https://base-sepolia.drpc.org",
      "https://base-sepolia.gateway.tenderly.co",
    ]) {
      expect(section).toContain(`| \`${url}\``);
    }
    expect(section).toContain(
      "ships no provider and names\nnone as a default",
    );
    expect(section).toContain("third-party public services");
  });
});
