#!/usr/bin/env node
/**
 * @forestrie/mcp-verify must never depend back on @forestrie/mcp-resolve.
 *
 * This package (@forestrie/mcp-resolve) depends on @forestrie/mcp-verify
 * (exact pin, see package.json#dependencies) to know the shapes it fetches
 * material for. The verifier must never depend back on this package: a
 * cycle here would mean mcp-verify's own dependency tree
 * pulls in a second, possibly divergent copy of mcp-resolve, and would make
 * "install mcp-verify alone" pull in an MCP server nobody asked for.
 *
 * Two invocations, both required:
 *   1. The repo's whole installed tree (node_modules, including pnpm's
 *      `.pnpm` store with every transitive dependency), failing closed if
 *      the walk errors, hits its depth limit, or never sees mcp-verify.
 *      Offline.
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
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = "@forestrie/mcp-resolve";
const HOST = "@forestrie/mcp-verify";
// A little deeper than check-encoding-single-copy's 12: a scratch npm
// install adds one more nesting level than pnpm's own store layout does.
const MAX_DEPTH = 16;

/**
 * Pure: walk `rootDir/node_modules` and report what the tree contains.
 * Returns `{ hits, sawHost, errors }`:
 *   hits    every directory whose own package.json declares
 *           `name === "@forestrie/mcp-resolve"`;
 *   sawHost whether a package named `@forestrie/mcp-verify` was seen, so a
 *           caller can refuse a vacuous pass over a tree that never held it;
 *   errors  everything that stopped the walk being exhaustive: a readdir
 *           error other than ENOENT, a package.json that exists but does
 *           not parse, or the depth limit. Any entry here is a FAILURE.
 *
 * Handles pnpm's `.pnpm/<key>/node_modules/<scope>/<name>` store layout and
 * plain nested `node_modules/<scope>/<name>` alike, because both fall out of
 * the same walk: an entry with its own package.json is a package (checked,
 * then recursed into via its own node_modules); an entry without one — a
 * scope directory, `.pnpm` itself, or one of its store-key directories — is
 * a container, recursed into directly. Visited realpaths are remembered so
 * pnpm's symlinks (and any cycle) are each walked once.
 */
export function scanInstalledTree(rootDir, maxDepth = MAX_DEPTH) {
  const hits = [];
  const errors = [];
  let sawHost = false;
  const visited = new Set();

  const code = (err) =>
    err && typeof err === "object" ? err.code : undefined;

  /** @returns {{kind:"package", name?:string} | {kind:"container"} | {kind:"error"}} */
  function classify(dir) {
    let text;
    try {
      text = readFileSync(join(dir, "package.json"), "utf8");
    } catch (err) {
      if (code(err) === "ENOENT" || code(err) === "ENOTDIR")
        return { kind: "container" };
      errors.push(`cannot read ${join(dir, "package.json")}: ${String(err)}`);
      return { kind: "error" };
    }
    try {
      const pkg = JSON.parse(text);
      return {
        kind: "package",
        name: typeof pkg?.name === "string" ? pkg.name : undefined,
      };
    } catch (err) {
      errors.push(
        `unparseable ${join(dir, "package.json")}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: "error" };
    }
  }

  function walk(dir, depth) {
    if (depth > maxDepth) {
      errors.push(`depth limit ${maxDepth} reached at ${dir}`);
      return;
    }
    let real;
    try {
      real = realpathSync(dir);
    } catch (err) {
      if (code(err) !== "ENOENT")
        errors.push(`cannot resolve ${dir}: ${String(err)}`);
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (code(err) !== "ENOENT")
        errors.push(`cannot read directory ${dir}: ${String(err)}`);
      return;
    }
    for (const e of entries) {
      if (e.name === ".bin" || e.name === ".cache") continue;
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        try {
          if (!statSync(p).isDirectory()) continue;
        } catch (err) {
          if (code(err) !== "ENOENT")
            errors.push(`cannot stat ${p}: ${String(err)}`);
          continue;
        }
      } else if (!e.isDirectory()) {
        continue;
      }
      const c = classify(p);
      if (c.kind === "error") continue;
      if (c.kind === "package") {
        if (c.name === TARGET) hits.push(p);
        if (c.name === HOST) sawHost = true;
        walk(join(p, "node_modules"), depth + 1);
      } else {
        walk(p, depth + 1);
      }
    }
  }

  walk(join(rootDir, "node_modules"), 0);
  return { hits, sawHost, errors };
}

/** Just the hits of `scanInstalledTree`. */
export function findMcpResolveCopies(rootDir, maxDepth = MAX_DEPTH) {
  return scanInstalledTree(rootDir, maxDepth).hits;
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

/** Report a full scan: hits, walk errors, and (optionally) host-not-seen. */
function reportScan(label, scan, requireHost) {
  let ok = report(label, scan.hits);
  if (scan.errors.length > 0) {
    console.error(
      `reverse-dependency check FAILED: ${label} — the walk was not exhaustive:`,
    );
    for (const e of scan.errors) console.error(`  ${e}`);
    ok = false;
  }
  if (requireHost && !scan.sawHost) {
    console.error(
      `reverse-dependency check FAILED: ${label} — never saw ${HOST}, so ` +
        `an empty result would prove nothing. Is the install done?`,
    );
    ok = false;
  }
  return ok;
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  let ok = true;

  // --- Part 1: the repo's whole installed tree --------------------------
  // Under pnpm a package's dependencies are siblings in
  // `.pnpm/<key>/node_modules/`, not nested inside it, so walking only
  // mcp-verify's own directory checks nothing. Walk everything: this
  // package is never installed into its own node_modules, so ANY copy means
  // some dependency depends back on it. Requires seeing mcp-verify so it
  // cannot pass vacuously.
  ok =
    reportScan(
      `repo node_modules (${repoRoot})`,
      scanInstalledTree(repoRoot),
      true,
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
      reportScan(
        `scratch install tree (${scratchDir})`,
        scanInstalledTree(scratchDir),
        true,
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
