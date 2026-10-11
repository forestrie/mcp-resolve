/**
 * `findCopies` (scripts/check-encoding-single-copy.mjs) must see a second
 * copy of a tracked package nested inside another tracked package's own
 * node_modules (npm's fallback layout), and a clean tree must show one.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCopies } from "../../scripts/check-encoding-single-copy.mjs";

const NAMES = ["@forestrie/encoding", "@forestrie/mcp-verify"];
let scratchDir: string | undefined;

function writePkg(dir: string, name: string, version: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
}

afterEach(() => {
  if (scratchDir !== undefined) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

describe("check:encoding-single-copy — findCopies", () => {
  it("passes a clean npm-style tree: one version of each", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "single-copy-clean-"));
    const nm = join(scratchDir, "node_modules", "@forestrie");
    writePkg(join(nm, "encoding"), "@forestrie/encoding", "0.8.0");
    writePkg(join(nm, "mcp-verify"), "@forestrie/mcp-verify", "0.5.0");
    const found = findCopies(scratchDir, NAMES);
    expect([...found.get("@forestrie/encoding")!.keys()]).toEqual(["0.8.0"]);
    expect([...found.get("@forestrie/mcp-verify")!.keys()]).toEqual(["0.5.0"]);
  });

  it("reports a copy nested inside a tracked package's own node_modules", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "single-copy-nested-"));
    const nm = join(scratchDir, "node_modules", "@forestrie");
    writePkg(join(nm, "encoding"), "@forestrie/encoding", "0.8.0");
    writePkg(join(nm, "mcp-verify"), "@forestrie/mcp-verify", "0.5.0");
    writePkg(
      join(nm, "mcp-verify", "node_modules", "@forestrie", "encoding"),
      "@forestrie/encoding",
      "0.9.0",
    );
    const versions = findCopies(scratchDir, NAMES).get("@forestrie/encoding")!;
    expect([...versions.keys()].sort()).toEqual(["0.8.0", "0.9.0"]);
  });
});
