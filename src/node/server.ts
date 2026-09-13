/**
 * `createServer()` — the MCP adapter. No transport: the caller connects one
 * (stdio from `cli.ts`, `InMemoryTransport` from the smoke test), which is
 * also what lets an embedder mount tools on their own transport without the
 * CLI.
 *
 * Phase 1 (this repo's bootstrap, plan-2609-05 step 1.5) registers NO tools.
 * The six tools of N2 — `fetch_scitt_configuration`, `query_registration`,
 * `fetch_receipt`, `fetch_genesis`, `fetch_accumulator` and the composed
 * `verify_fetched_receipt` — arrive in phase 2, each annotated
 * `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true,
 * openWorldHint: true }` per N5: every one of them fetches, unlike the
 * verifier's own tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PACKAGE_VERSION } from "../core/index.js";

const SERVER_NAME = "forestrie-mcp-resolve";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: PACKAGE_VERSION },
    {
      instructions:
        "Fetches material for @forestrie/mcp-verify to verify. Tools " +
        "arrive in a later release; this build registers none.",
    },
  );

  // `registerTool` is what normally turns on the `tools` capability and its
  // `tools/list` handler (mcp.ts's setToolRequestHandlers, called lazily on
  // first registration); with zero tools registered that never happens, and
  // `tools/list` would answer "Method not found" instead of an empty list.
  // Declare the capability and the handler directly on the underlying
  // `Server` — the SDK's own documented escape hatch for "advanced usage" —
  // so a client sees an empty, well-formed tool list rather than a missing
  // capability. Phase 2's `registerTool` calls make this explicit wiring
  // unnecessary again.
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [],
  }));

  return server;
}
