/**
 * Every `*_VERSION` constant in src/core/version.ts must equal the matching
 * exact pin in package.json#dependencies. A forgotten bump on either side
 * is a red test here rather than a silent lie in a networked result's
 * provenance, or in `check:encoding-single-copy`'s expectations.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHAIN_RPC_VERSION,
  ENCODING_VERSION,
  PACKAGE_VERSION,
  RECEIPT_VERIFY_VERSION,
  SCRAPI_CLIENT_VERSION,
  VERIFIER_VERSION,
} from "../../src/core/index.js";

const repoRoot = new URL("../../", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
};

describe("version constants agree with package.json", () => {
  it("PACKAGE_VERSION === package.json#version", () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it("VERIFIER_VERSION === package.json#dependencies['@forestrie/mcp-verify']", () => {
    expect(VERIFIER_VERSION).toBe(pkg.dependencies["@forestrie/mcp-verify"]);
  });

  it("CHAIN_RPC_VERSION === package.json#dependencies['@forestrie/chain-rpc']", () => {
    expect(CHAIN_RPC_VERSION).toBe(pkg.dependencies["@forestrie/chain-rpc"]);
  });

  it("SCRAPI_CLIENT_VERSION === package.json#dependencies['@forestrie/scrapi-client']", () => {
    expect(SCRAPI_CLIENT_VERSION).toBe(
      pkg.dependencies["@forestrie/scrapi-client"],
    );
  });

  it("RECEIPT_VERIFY_VERSION === package.json#dependencies['@forestrie/receipt-verify']", () => {
    expect(RECEIPT_VERIFY_VERSION).toBe(
      pkg.dependencies["@forestrie/receipt-verify"],
    );
  });

  it("ENCODING_VERSION === package.json#dependencies['@forestrie/encoding']", () => {
    expect(ENCODING_VERSION).toBe(pkg.dependencies["@forestrie/encoding"]);
  });
});
