/**
 * `@forestrie/mcp-resolve` — the browser-safe core.
 *
 * This is the `"."` export. Everything reachable from here is pure over
 * bytes: no `node:*`, no `fetch`, no filesystem, no MCP SDK. An importer who
 * takes `"."` gets URL construction, response classification and
 * provenance/supports labelling and nothing else; `"./net"` is the only
 * place `fetch` is called, and `"./server"` is where the MCP adapter lives.
 * `pnpm run check:browser-safe` bundles this file for `platform: "browser"`
 * and fails on any edge to a node builtin, so that boundary is proven on
 * every test run and before every publish, not asserted.
 *
 * Phase 1 (this repo's bootstrap, plan-2609-05 step 1.5) ships only the
 * version constants and a `COURIER` identity below. `src/core`'s actual
 * pure layer — endpoints, classification, provenance/supports, compose,
 * genesis-binding — is step 1.6.
 */

export {
  PACKAGE_VERSION,
  VERIFIER_VERSION,
  SCRAPI_CLIENT_VERSION,
  RECEIPT_VERIFY_VERSION,
  ENCODING_VERSION,
} from "./version.js";

import { PACKAGE_VERSION, VERIFIER_VERSION } from "./version.js";

/**
 * This package's identity as the courier that fetches for
 * `@forestrie/mcp-verify` to verify (N1): named alongside the verifier and
 * its pinned version, so a networked result can always name both packages.
 */
export const COURIER = {
  package: "@forestrie/mcp-resolve",
  version: PACKAGE_VERSION,
  verifier: "@forestrie/mcp-verify",
  verifierVersion: VERIFIER_VERSION,
} as const;
