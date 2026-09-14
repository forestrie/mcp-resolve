/**
 * Version strings, as literals.
 *
 * Not read from `package.json`: `src/core` is browser-safe, so it has no
 * `node:fs`, and a JSON import would bake a resolveJsonModule edge into the
 * `"."` bundle for five strings. The MCP smoke test asserts
 * `PACKAGE_VERSION === package.json#version`, so a forgotten bump is a red
 * test rather than a silent lie in `initialize`'s serverInfo.
 *
 * Bump each one in the same commit as the dependency it names.
 */

/** Keep in sync with package.json#version. Asserted by test/node/mcp-smoke. */
export const PACKAGE_VERSION = "0.1.2";

/** Keep in sync with package.json#dependencies["@forestrie/mcp-verify"] — the
 *  verifier this package composes with (N4). 0.4.1, not 0.4.0: its only
 *  change is re-pinning @forestrie/receipt-verify to 1.1.0 (plan-2609-06
 *  F7), closing the skew that made check:encoding-single-copy red. Asserted
 *  by test/core/version.test.ts. */
export const VERIFIER_VERSION = "0.4.1";

/** Keep in sync with package.json#dependencies["@forestrie/chain-rpc"] —
 *  the injectable-`fetchImpl` JSON-RPC helpers `src/net/chain.ts`'s
 *  `callJsonRpc` now calls through (plan-2609-06 F7, replacing this
 *  package's own hand-rolled JSON-RPC POST). Asserted by
 *  test/core/version.test.ts. */
export const CHAIN_RPC_VERSION = "0.3.0";

/** Keep in sync with package.json#dependencies["@forestrie/scrapi-client"].
 *  0.2.2, not 0.2.1: 0.2.2's only change is a doc comment fix (0.2.1's was
 *  no longer true). Asserted by test/core/version.test.ts. */
export const SCRAPI_CLIENT_VERSION = "0.2.2";

/** Keep in sync with package.json#dependencies["@forestrie/receipt-verify"]
 *  (F7: the FOREST_GENESIS_LABEL_* constants, decodeChainBindingFromGenesis
 *  and decodeTrustRootDetailsFromGenesis, on top of N4 amendment A's
 *  encodeKnownAccumulator). Asserted by test/core/version.test.ts. */
export const RECEIPT_VERIFY_VERSION = "1.1.0";

/** Keep in sync with package.json#dependencies["@forestrie/encoding"].
 *  Asserted by test/core/version.test.ts. */
export const ENCODING_VERSION = "0.7.0";

/**
 * This package's identity as the courier that fetches for
 * `@forestrie/mcp-verify` to verify (N1): named alongside the verifier and
 * its pinned version, so a networked result can always name both packages.
 *
 * Lives here, not in index.ts: compose.ts needs it too, and importing it
 * from index.ts (the "." barrel that re-exports compose.ts) would be a
 * cycle. version.ts has no imports of its own, so both index.ts and
 * compose.ts can import COURIER from here without one.
 */
export const COURIER = {
  package: "@forestrie/mcp-resolve",
  version: PACKAGE_VERSION,
  verifier: "@forestrie/mcp-verify",
  verifierVersion: VERIFIER_VERSION,
} as const;
