#!/usr/bin/env node
/**
 * F5 (plan-2609-06 3.1, FOR-559): @forestrie/mcp-verify must never depend
 * back on @forestrie/mcp-resolve.
 *
 * This package (@forestrie/mcp-resolve) depends on @forestrie/mcp-verify
 * (exact pin, see package.json#dependencies) to know the shapes it fetches
 * material for. plan-2609-05 promised the verifier never depends back on
 * this package — a cycle here would mean mcp-verify's own dependency tree
 * pulls in a second, possibly divergent copy of mcp-resolve, and would make
 * "install mcp-verify alone" pull in an MCP server nobody asked for.
 *
 * Two invocations, both required:
 *   1. The repo's own node_modules/@forestrie/mcp-verify (this is what this
 *      package is actually built and tested against today).
 *   2. A scratch `npm i @forestrie/mcp-verify@<pin>` in a throwaway
 *      directory, under npm's flat resolver — not pnpm's isolated store —
 *      because that is what an `npm i @forestrie/mcp-verify` (or
 *      `npx @forestrie/mcp-verify`) user actually gets, and pnpm's
 *      workspace-local layout can hide a skew npm's flat tree would expose.
 *
 * Works on both node_modules layouts:
 *   pnpm  — node_modules/.pnpm/<key>/node_modules/<scope>/<name>
 *   npm   — nested/flat node_modules/<scope>/<name>/package.json
 * by walking generically and reading each candidate's package.json `name`
 * rather than trusting a directory name — a pnpm store key or an npm alias
 * can rename the folder without renaming the package.
 *
 * Usage: node scripts/check-reverse-dependency.mjs [repoRoot]
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = "@forestrie/mcp-resolve";
// A little deeper than check-encoding-single-copy's 12: a scratch npm
// install adds one more nesting level than pnpm's own store layout does.
const MAX_DEPTH = 16;

/**
 * Pure: walk `rootDir/node_modules` and return every directory whose own
 * package.json declares `name === "@forestrie/mcp-resolve"`. Handles pnpm's
 * `.pnpm/<key>/node_modules/<scope>/<name>` store layout and plain nested
 * `node_modules/<scope>/<name>` alike, because both fall out of the same
 * walk: an entry with its own package.json is a package (checked, then
 * recursed into via its own node_modules); an entry without one — a scope
 * directory, `.pnpm` itself, or one of its store-key directories — is just
 * a container, recursed into directly. No layout-specific special-casing.
 */
export function findMcpResolveCopies(rootDir, maxDepth = MAX_DEPTH) {
  const hits = [];

  function pkgNameOf(dir) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return typeof pkg.name === "string" ? pkg.name : undefined;
    } catch {
      return undefined;
    }
  }

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name === ".bin" || e.name === ".cache") continue;
      const p = join(dir, e.name);
      const name = pkgNameOf(p);
      if (name !== undefined) {
        // `p` has its own package.json: it's a real package directory.
        if (name === TARGET) hits.push(p);
        walk(join(p, "node_modules"), depth + 1);
      } else {
        // No package.json of its own: a scope directory (`@forestrie`), or
        // one of pnpm's containers — `.pnpm` itself, or one of its
        // `<name>@<version>` / `@scope+name@<version>` store-key entries,
        // which hold the real package one level further down, inside their
        // own `node_modules`. All of these are just containers; recurse
        // straight into them (not through a `node_modules` hop, since they
        // don't have deps of their own — their *contents* do).
        walk(p, depth + 1);
      }
    }
  }

  walk(join(rootDir, "node_modules"), 0);
  return hits;
}

/** Recursively search an `npm ls --json` tree for TARGET nodes. */
function findInNpmLsTree(node, hits, pathSoFar = []) {
  const deps = node?.dependencies;
  if (!deps || typeof deps !== "object") return;
  for (const [name, child] of Object.entries(deps)) {
    const path = [...pathSoFar, name];
    if (name === TARGET) {
      hits.push(String(child?.path ?? path.join(" > ")));
    }
    findInNpmLsTree(child, hits, path);
  }
}

function report(label, hits) {
  if (hits.length === 0) {
    console.log(
      `reverse-dependency check passed: ${label} — no nested ${TARGET}.`,
    );
    return true;
  }
  console.error(
    `reverse-dependency check FAILED: ${label} — ${TARGET} found at:`,
  );
  for (const h of hits) console.error(`  ${h}`);
  return false;
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  let ok = true;

  // --- Part 1: the repo's own installed mcp-verify -----------------------
  const mcpVerifyLink = join(
    repoRoot,
    "node_modules",
    "@forestrie",
    "mcp-verify",
  );
  let mcpVerifyReal;
  try {
    mcpVerifyReal = realpathSync(mcpVerifyLink);
  } catch (err) {
    console.error(
      `reverse-dependency check FAILED: could not resolve ${mcpVerifyLink} ` +
        `— is \`pnpm install\` done? (${err instanceof Error ? err.message : String(err)})`,
    );
    process.exit(1);
  }
  ok =
    report(
      `repo node_modules (${mcpVerifyReal})`,
      findMcpResolveCopies(mcpVerifyReal),
    ) && ok;

  // --- Part 2: a scratch install under npm's own flat resolver -----------
  const pkgJsonPath = join(repoRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const version = pkg.dependencies?.["@forestrie/mcp-verify"];
  if (!version) {
    console.error(
      `reverse-dependency check FAILED: no @forestrie/mcp-verify pin in ` +
        `${pkgJsonPath}#dependencies`,
    );
    process.exit(1);
  }

  const scratchDir = mkdtempSync(
    join(tmpdir(), "mcp-resolve-reverse-dependency-"),
  );
  try {
    const install = spawnSync(
      "npm",
      [
        "i",
        `@forestrie/mcp-verify@${version}`,
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--prefix",
        scratchDir,
      ],
      { encoding: "utf8" },
    );
    if (install.error || install.status !== 0) {
      // Fail closed: an install we could not run is a check we could not
      // run, never a pass. Most likely cause is no npm registry access.
      console.error(
        `reverse-dependency check FAILED: could not run — scratch ` +
          `\`npm i @forestrie/mcp-verify@${version}\` did not succeed ` +
          `(exit ${String(install.status)}). This check fails closed rather ` +
          `than skipping; check npm registry access.`,
      );
      if (install.error) console.error(`  ${install.error.message}`);
      if (install.stderr) console.error(install.stderr.trim());
      process.exit(1);
    }

    const ls = spawnSync(
      "npm",
      ["ls", TARGET, "--all", "--json", "--prefix", scratchDir],
      { encoding: "utf8" },
    );
    if (ls.error) {
      console.error(
        `reverse-dependency check FAILED: could not run — scratch ` +
          `\`npm ls ${TARGET}\` did not execute (${ls.error.message}).`,
      );
      process.exit(1);
    }
    const lsHits = [];
    try {
      findInNpmLsTree(JSON.parse(ls.stdout || "{}"), lsHits);
    } catch {
      // Some npm versions interleave warnings with the JSON on stdout; the
      // pure walk below is authoritative regardless, so this is not fatal.
      console.log(
        `reverse-dependency check: scratch \`npm ls ${TARGET} --json\` ` +
          `output was not parseable JSON, relying on the filesystem walk.`,
      );
    }
    ok = report(`scratch npm ls --json (${scratchDir})`, lsHits) && ok;
    ok =
      report(
        `scratch install tree (${scratchDir})`,
        findMcpResolveCopies(scratchDir),
      ) && ok;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  if (!ok) process.exit(1);
}

function isMain() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main();
}
