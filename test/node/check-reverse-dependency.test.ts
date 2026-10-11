/**
 * Negative test: `findMcpResolveCopies`
 * (scripts/check-reverse-dependency.mjs) must find a nested
 * @forestrie/mcp-resolve wherever it is planted — plain nested
 * node_modules, and pnpm's `.pnpm/<key>/node_modules/<scope>/<name>` store
 * layout — and must find nothing in a clean tree. Pure filesystem walk,
 * synthetic fixtures only: no network, no real install.
 */
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findMcpResolveCopies,
  scanInstalledTree,
} from "../../scripts/check-reverse-dependency.mjs";

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

describe("check:reverse-dependency — scanInstalledTree (part 1)", () => {
  const host = (root: string) =>
    writePkg(
      join(root, "node_modules", "@forestrie", "mcp-verify"),
      "@forestrie/mcp-verify",
    );

  it("finds a copy planted as a pnpm sibling, outside mcp-verify's own directory", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "reverse-dependency-scan-pnpm-"));
    host(scratchDir);
    const planted = join(
      scratchDir,
      "node_modules",
      ".pnpm",
      "some-dep@1.0.0",
      "node_modules",
      "@forestrie",
      "mcp-resolve",
    );
    writePkg(planted, "@forestrie/mcp-resolve");
    const scan = scanInstalledTree(scratchDir);
    expect(scan.hits).toEqual([planted]);
    expect(scan.sawHost).toBe(true);
    expect(scan.errors).toEqual([]);
  });

  it("reports host-not-seen when mcp-verify is absent", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "reverse-dependency-nohost-"));
    writePkg(join(scratchDir, "node_modules", "left-pad"), "left-pad");
    const scan = scanInstalledTree(scratchDir);
    expect(scan.sawHost).toBe(false);
    expect(scan.hits).toEqual([]);
  });

  it("reports host-not-seen when there is no node_modules at all", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "reverse-dependency-empty-"));
    expect(scanInstalledTree(scratchDir).sawHost).toBe(false);
  });

  it("fails closed on a package.json that exists but does not parse", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "reverse-dependency-corrupt-"));
    host(scratchDir);
    const bad = join(scratchDir, "node_modules", "broken");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "package.json"), "{ not json", "utf8");
    const scan = scanInstalledTree(scratchDir);
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0]).toContain("unparseable");
  });

  it("fails closed when the depth limit is hit", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "reverse-dependency-depth-"));
    host(scratchDir);
    let dir = join(scratchDir, "node_modules", "a");
    writePkg(dir, "a");
    for (const n of ["b", "c", "d"]) {
      dir = join(dir, "node_modules", n);
      writePkg(dir, n);
    }
    const scan = scanInstalledTree(scratchDir, 3);
    expect(scan.errors.some((e) => e.includes("depth limit"))).toBe(true);
  });

  it("terminates on a symlink cycle, and still finds a copy beside it", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "reverse-dependency-cycle-"));
    host(scratchDir);
    const a = join(scratchDir, "node_modules", "a");
    writePkg(a, "a");
    mkdirSync(join(a, "node_modules"), { recursive: true });
    // a/node_modules/loop -> a: walking loop revisits a forever, unguarded.
    symlinkSync(a, join(a, "node_modules", "loop"), "dir");
    const planted = join(
      scratchDir,
      "node_modules",
      "z",
      "node_modules",
      "@forestrie",
      "mcp-resolve",
    );
    writePkg(join(scratchDir, "node_modules", "z"), "z");
    writePkg(planted, "@forestrie/mcp-resolve");
    const scan = scanInstalledTree(scratchDir);
    expect(scan.hits).toEqual([planted]);
    expect(scan.errors).toEqual([]);
  });
});
