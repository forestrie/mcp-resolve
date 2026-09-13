#!/usr/bin/env node
/**
 * N4: exactly one copy each of @forestrie/encoding and
 * @forestrie/receipt-verify in the tree.
 *
 * Multiple copies of a WIRE-TYPE package (encoding: CBOR; receipt-verify:
 * the genesis label constants this package decodes chain bindings with)
 * means two disagreeing implementations of the same bytes, and a package
 * that fetches material for a verifier to check cannot afford that
 * ambiguity. This is a release gate, not a lint. Copied from
 * @forestrie/mcp-verify's scripts/check-encoding-single-copy.mjs and
 * extended (plan-2609-05 N4 amendment A, 2026-09-13) to loop over both
 * package names with the same mechanism, since both are exact pins for the
 * same reason.
 *
 * Works on both layouts:
 *   pnpm  — node_modules/.pnpm/@forestrie+<name>@<v>/node_modules/@forestrie/<name>
 *   npm   — nested/flat node_modules/@forestrie/<name>/package.json
 * so the same script gates the repo AND a scratch install of the tarball.
 * The second invocation is the one that matters: it asserts what an
 * `npx -y @forestrie/mcp-resolve` user actually gets, under npm's flat
 * resolver, which is not what pnpm's isolated store gives us locally.
 *
 * DO NOT "fix" a red run here with a pnpm `overrides` entry for either
 * package. An override SILENCES the exact skew this gate exists to detect,
 * by rewriting a transitive dep to a version its parent was never tested
 * against. Today both pins are naturally satisfiable — receipt-verify@1.0.0
 * and scrapi-client@0.1.4 both depend on @forestrie/encoding@0.7.0 exactly,
 * and this package declares both encoding@0.7.0 and receipt-verify@1.0.0
 * exactly, so there is exactly one copy of each without any coercion. If a
 * future dependency drags a second copy in, fix or drop that dependency (or
 * wait for its bump), never override.
 *
 * Usage: node scripts/check-encoding-single-copy.mjs [rootDir]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const MAX_DEPTH = 12;

// name -> expected exact pin (N4)
const EXPECTED = {
  "@forestrie/encoding": "0.7.0",
  "@forestrie/receipt-verify": "1.0.0",
};

/**
 * Walk every `node_modules` subtree looking for the named packages' own
 * package directories. Deliberately dumb and exhaustive rather than clever
 * about layouts: pnpm's store, npm's flat tree, npm's nested fallback and a
 * yarn `node_modules` all fall out of the same walk.
 */
function findCopies(rootDir, names) {
  // shortName -> full name, so the walk can match by directory name alone.
  const byShort = new Map(names.map((n) => [n.split("/")[1], n]));
  // name -> version -> [paths]
  const found = new Map(names.map((n) => [n, new Map()]));

  function record(dir) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      return;
    }
    if (!found.has(pkg.name)) return;
    const versions = found.get(pkg.name);
    const list = versions.get(pkg.version) ?? [];
    list.push(dir);
    versions.set(pkg.version, list);
  }

  function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
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
      if (byShort.has(e.name) && dir.endsWith("@forestrie")) {
        record(p);
        continue;
      }
      walk(p, depth + 1);
    }
  }

  walk(join(rootDir, "node_modules"), 0);
  return found;
}

const names = Object.keys(EXPECTED);
const found = findCopies(root, names);

let failed = false;
for (const name of names) {
  const versions = found.get(name);
  const expected = EXPECTED[name];

  if (versions.size === 0) {
    console.error(
      `encoding-copy check FAILED: no ${name} found under ${root}`,
    );
    failed = true;
    continue;
  }
  if (versions.size > 1) {
    console.error(`encoding-copy check FAILED: multiple ${name} versions:`);
    for (const [v, paths] of versions)
      for (const p of paths) console.error(`  ${v}  ${p}`);
    console.error(
      "Two copies of a wire-type package is two answers about the same bytes. Fix the pin, do not add an override.",
    );
    failed = true;
    continue;
  }
  const [version] = [...versions.keys()];
  if (version !== expected) {
    console.error(
      `encoding-copy check FAILED: ${name} expected exactly ${expected}, found ${version}`,
    );
    failed = true;
    continue;
  }
  console.log(`encoding-copy check passed: exactly one ${name} (${version}).`);
}

if (failed) process.exit(1);
