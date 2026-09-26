/**
 * `createServer(deps?)` — the MCP adapter. No transport: the caller connects
 * one (stdio from `cli.ts`, `InMemoryTransport` from the smoke test), which
 * is also what lets an embedder mount tools on their own transport without
 * the CLI.
 *
 * Registers the seven tools, each annotated `{ readOnlyHint: true,
 * destructiveHint: false, idempotentHint: true, openWorldHint: true }`:
 * every one of them fetches, unlike the verifier's own tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_VERSION } from "../core/index.js";
import {
  INSTRUCTIONS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  TOOL_TITLES,
} from "./text.js";
import {
  fetchAccumulatorInputShape,
  fetchAccumulatorOutputShape,
  fetchCheckpointHistoryInputShape,
  fetchCheckpointHistoryOutputShape,
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
  makeFetchCheckpointHistoryTool,
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
 *  (`FORESTRIE_BASE_URL` / `FORESTRIE_RPC_URL` are the caller's own
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

/** Every networked tool carries the same annotations: read-only,
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

  // One registerTool per name in TOOL_NAMES, in that order; the smoke test
  // asserts tools/list equals TOOL_NAMES and help.test.ts asserts --help
  // prints the same list.
  server.registerTool(
    TOOL_NAMES[0],
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
    TOOL_NAMES[1],
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
    TOOL_NAMES[2],
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
    TOOL_NAMES[3],
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
    TOOL_NAMES[4],
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
    TOOL_NAMES[5],
    {
      title: TOOL_TITLES.fetch_checkpoint_history,
      description: TOOL_DESCRIPTIONS.fetch_checkpoint_history,
      inputSchema: fetchCheckpointHistoryInputShape,
      outputSchema: fetchCheckpointHistoryOutputShape,
      annotations: ANNOTATIONS,
    },
    makeFetchCheckpointHistoryTool(resolved),
  );

  server.registerTool(
    TOOL_NAMES[6],
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
