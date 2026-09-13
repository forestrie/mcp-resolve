#!/usr/bin/env node
/**
 * The registry-listing version guard (plan-2609-05 N6 gate 5, copied from
 * @forestrie/mcp-verify's scripts/assert-server-json.mjs).
 *
 * server.json's `version` (and `packages[0].version`) cannot be read from
 * package.json at build time — it is a static file the MCP registry fetches
 * over HTTP, not a build artifact — so a version bump can silently leave it
 * behind. This script is the release gate that makes that impossible:
 *
 *   - server.json#version         === package.json#version
 *   - server.json#packages[0].version === package.json#version
 *   - server.json#name            === package.json#mcpName
 *   - server.json#description     non-empty, at most 100 characters (registry schema)
 *
 * A mismatch on any of the three is a hard failure, not a warning — an
 * out-of-date server.json is a false claim to a registry an outside agent
 * queries directly, and package.json#mcpName is what the registry checks
 * to verify npm package ownership (official-registry-requirements.md).
 *
 * Wired into `pnpm test` (ci.yml), exactly like
 * scripts/check-encoding-single-copy.mjs.
 *
 * Usage: node scripts/assert-server-json.mjs [repoDir]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const pkg = readJson(join(root, "package.json"));
const server = readJson(join(root, "server.json"));

const failures = [];

if (server.version !== pkg.version) {
  failures.push(
    `server.json#version is "${server.version}" but package.json#version is "${pkg.version}"`,
  );
}

const firstPackage = server.packages?.[0];
if (!firstPackage) {
  failures.push("server.json#packages[0] is missing");
} else if (firstPackage.version !== pkg.version) {
  failures.push(
    `server.json#packages[0].version is "${firstPackage.version}" but package.json#version is "${pkg.version}"`,
  );
}

if (!pkg.mcpName) {
  failures.push(
    "package.json#mcpName is missing; the registry checks it to verify npm package ownership",
  );
} else if (server.name !== pkg.mcpName) {
  failures.push(
    `server.json#name is "${server.name}" but package.json#mcpName is "${pkg.mcpName}"`,
  );
}

// The registry schema (2025-12-11) caps `description` and `title` at 100
// characters and requires a non-empty description; mcp-publisher only finds
// out at publish time with a 422, after `npm publish` has already shipped
// the version (release v0.1.1, 2026-09-13). Fail here instead.
const DESCRIPTION_MAX = 100;
if (
  typeof server.description !== "string" ||
  server.description.length === 0
) {
  failures.push("server.json#description is missing or empty");
} else if (server.description.length > DESCRIPTION_MAX) {
  failures.push(
    `server.json#description is ${server.description.length} characters; the registry schema allows at most ${DESCRIPTION_MAX}`,
  );
}
if (
  typeof server.title === "string" &&
  server.title.length > DESCRIPTION_MAX
) {
  failures.push(
    `server.json#title is ${server.title.length} characters; the registry schema allows at most ${DESCRIPTION_MAX}`,
  );
}

if (failures.length > 0) {
  console.error("assert-server-json FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `assert-server-json OK: server.json and package.json agree at ${pkg.version} (${pkg.mcpName}).`,
);
