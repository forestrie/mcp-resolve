/**
 * `createServer(deps?)` — the MCP adapter. No transport: the caller connects
 * one (stdio from `cli.ts`, `InMemoryTransport` from the smoke test), which
 * is also what lets an embedder mount tools on their own transport without
 * the CLI.
 *
 * Phase 2 (plan-2609-05 step 2.4) registers the six N2 tools —
 * `fetch_scitt_configuration`, `query_registration`, `fetch_receipt`,
 * `fetch_genesis`, `fetch_accumulator` and the composed
 * `verify_fetched_receipt` — each annotated `{ readOnlyHint: true,
 * destructiveHint: false, idempotentHint: true, openWorldHint: true }` per
 * N5: every one of them fetches, unlike the verifier's own tools. Calling
 * `registerTool` at all turns the `tools` capability on and wires
 * `tools/list`, so the phase 1 empty-tools escape hatch
 * (`registerCapabilities` + a hand-set `ListToolsRequestSchema` handler) is
 * gone.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_VERSION } from "../core/index.js";
import { INSTRUCTIONS, TOOL_DESCRIPTIONS, TOOL_TITLES } from "./text.js";
import {
  fetchAccumulatorInputShape,
  fetchAccumulatorOutputShape,
  fetchGenesisInputShape,
  fetchGenesisOutputShape,
  fetchReceiptInputShape,
  fetchReceiptOutputShape,
  fetchScittConfigurationInputShape,
  fetchScittConfigurationOutputShape,
  queryRegistrationInputShape,
  queryRegistrationOutputShape,
  verifyFetchedReceiptInputShape,
  verifyFetchedReceiptOutputShape,
  makeFetchAccumulatorTool,
  makeFetchGenesisTool,
  makeFetchReceiptTool,
  makeFetchScittConfigurationTool,
  makeQueryRegistrationTool,
  makeVerifyFetchedReceiptTool,
  type ResolvedDeps,
} from "./tools.js";

const SERVER_NAME = "forestrie-mcp-resolve";

/** Every field optional; defaults to `process.env` / `globalThis.fetch` /
 *  `() => new Date()` so tests can inject a fake `fetch` and a fake `env`
 *  (N8: `FORESTRIE_BASE_URL` / `FORESTRIE_RPC_URL` are the caller's own
 *  supply, never a package default) without touching the real network or
 *  the real environment. */
export type Deps = {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

function resolveDeps(deps: Deps | undefined): ResolvedDeps {
  return {
    fetchImpl: deps?.fetchImpl ?? globalThis.fetch,
    env: deps?.env ?? process.env,
    now: deps?.now ?? (() => new Date()),
  };
}

/** Every networked tool carries the same annotations (N5): read-only,
 *  non-destructive, idempotent (a repeated GET/eth_call returns the same
 *  or a newer state, never a side effect), and open-world — unlike the
 *  verifier's own tools, every one of these fetches. */
const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createServer(deps?: Deps): McpServer {
  const resolved = resolveDeps(deps);

  const server = new McpServer(
    { name: SERVER_NAME, version: PACKAGE_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "fetch_scitt_configuration",
    {
      title: TOOL_TITLES.fetch_scitt_configuration,
      description: TOOL_DESCRIPTIONS.fetch_scitt_configuration,
      inputSchema: fetchScittConfigurationInputShape,
      outputSchema: fetchScittConfigurationOutputShape,
      annotations: ANNOTATIONS,
    },
    makeFetchScittConfigurationTool(resolved),
  );

  server.registerTool(
    "query_registration",
    {
      title: TOOL_TITLES.query_registration,
      description: TOOL_DESCRIPTIONS.query_registration,
      inputSchema: queryRegistrationInputShape,
      outputSchema: queryRegistrationOutputShape,
      annotations: ANNOTATIONS,
    },
    makeQueryRegistrationTool(resolved),
  );

  server.registerTool(
    "fetch_receipt",
    {
      title: TOOL_TITLES.fetch_receipt,
      description: TOOL_DESCRIPTIONS.fetch_receipt,
      inputSchema: fetchReceiptInputShape,
      outputSchema: fetchReceiptOutputShape,
      annotations: ANNOTATIONS,
    },
    makeFetchReceiptTool(resolved),
  );

  server.registerTool(
    "fetch_genesis",
    {
      title: TOOL_TITLES.fetch_genesis,
      description: TOOL_DESCRIPTIONS.fetch_genesis,
      inputSchema: fetchGenesisInputShape,
      outputSchema: fetchGenesisOutputShape,
      annotations: ANNOTATIONS,
    },
    makeFetchGenesisTool(resolved),
  );

  server.registerTool(
    "fetch_accumulator",
    {
      title: TOOL_TITLES.fetch_accumulator,
      description: TOOL_DESCRIPTIONS.fetch_accumulator,
      inputSchema: fetchAccumulatorInputShape,
      outputSchema: fetchAccumulatorOutputShape,
      annotations: ANNOTATIONS,
    },
    makeFetchAccumulatorTool(resolved),
  );

  server.registerTool(
    "verify_fetched_receipt",
    {
      title: TOOL_TITLES.verify_fetched_receipt,
      description: TOOL_DESCRIPTIONS.verify_fetched_receipt,
      inputSchema: verifyFetchedReceiptInputShape,
      outputSchema: verifyFetchedReceiptOutputShape,
      annotations: ANNOTATIONS,
    },
    makeVerifyFetchedReceiptTool(resolved),
  );

  return server;
}
