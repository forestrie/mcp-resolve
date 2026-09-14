/**
 * F5 (plan-2609-06 3.1, FOR-559) negative test: `findMcpResolveCopies`
 * (scripts/check-reverse-dependency.mjs) must find a nested
 * @forestrie/mcp-resolve wherever it is planted — plain nested
 * node_modules, and pnpm's `.pnpm/<key>/node_modules/<scope>/<name>` store
 * layout — and must find nothing in a clean tree. Pure filesystem walk,
 * synthetic fixtures only: no network, no real install.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMcpResolveCopies } from "../../scripts/check-reverse-dependency.mjs";

let scratchDir: string | undefined;

function writePkg(dir: string, name: string, version = "0.0.0-test") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version }),
    "utf8",
  );
}

afterEach(() => {
  if (scratchDir !== undefined) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

describe("check:reverse-dependency — findMcpResolveCopies", () => {
  it("finds a plain nested @forestrie/mcp-resolve", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "reverse-dependency-nested-"));
    writePkg(
      join(scratchDir, "node_modules", "@forestrie", "mcp-verify"),
      "@forestrie/mcp-verify",
    );
    const planted = join(
      scratchDir,
      "node_modules",
      "@forestrie",
      "mcp-verify",
      "node_modules",
      "@forestrie",
      "mcp-resolve",
    );
    writePkg(planted, "@forestrie/mcp-resolve");

    expect(findMcpResolveCopies(scratchDir)).toEqual([planted]);
  });

  it("finds @forestrie/mcp-resolve under pnpm's .pnpm store layout", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "reverse-dependency-pnpm-"));
    writePkg(
      join(scratchDir, "node_modules", "@forestrie", "mcp-verify"),
      "@forestrie/mcp-verify",
    );
    const planted = join(
      scratchDir,
      "node_modules",
      ".pnpm",
      "@forestrie+mcp-resolve@1.0.0",
      "node_modules",
      "@forestrie",
      "mcp-resolve",
    );
    writePkg(planted, "@forestrie/mcp-resolve");

    expect(findMcpResolveCopies(scratchDir)).toEqual([planted]);
  });

  it("finds both at once, and only those, alongside unrelated packages", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "reverse-dependency-both-"));
    writePkg(
      join(scratchDir, "node_modules", "@forestrie", "mcp-verify"),
      "@forestrie/mcp-verify",
    );
    writePkg(join(scratchDir, "node_modules", "left-pad"), "left-pad");
    const nested = join(
      scratchDir,
      "node_modules",
      "@forestrie",
      "mcp-verify",
      "node_modules",
      "@forestrie",
      "mcp-resolve",
    );
    writePkg(nested, "@forestrie/mcp-resolve");
    const pnpmStyle = join(
      scratchDir,
      "node_modules",
      ".pnpm",
      "@forestrie+mcp-resolve@1.0.0",
      "node_modules",
      "@forestrie",
      "mcp-resolve",
    );
    writePkg(pnpmStyle, "@forestrie/mcp-resolve");

    const hits = findMcpResolveCopies(scratchDir);
    expect(hits.sort()).toEqual([nested, pnpmStyle].sort());
  });

  it("finds nothing in a clean tree", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "reverse-dependency-clean-"));
    writePkg(
      join(scratchDir, "node_modules", "@forestrie", "mcp-verify"),
      "@forestrie/mcp-verify",
    );
    writePkg(
      join(
        scratchDir,
        "node_modules",
        "@forestrie",
        "mcp-verify",
        "node_modules",
        "@forestrie",
        "receipt-verify",
      ),
      "@forestrie/receipt-verify",
    );
    writePkg(join(scratchDir, "node_modules", "left-pad"), "left-pad");

    expect(findMcpResolveCopies(scratchDir)).toEqual([]);
  });

  it("does not false-positive on a directory named mcp-resolve with a different package.json name", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "reverse-dependency-namecheck-"));
    // Folder name matches; package.json name does not. Must not count.
    writePkg(
      join(scratchDir, "node_modules", "@forestrie", "mcp-resolve"),
      "@someone-else/mcp-resolve",
    );

    expect(findMcpResolveCopies(scratchDir)).toEqual([]);
  });
});
