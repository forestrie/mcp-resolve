/**
 * The bin entry, reached via `bin/mcp-resolve.mjs`.
 *
 *   <no args>          → StdioServerTransport; this is what
 *                        `npx -y @forestrie/mcp-resolve` does.
 *   --help | --version → text on stdout, exit 0.
 *
 * TWO RULES, both silent-corruption bugs if broken:
 *
 * 1. **Nothing may write to stdout in stdio mode except the transport.** A
 *    stray `console.log` does not produce a warning — it produces a malformed
 *    JSON-RPC frame and an MCP client that mysteriously fails to initialise.
 *    All logging goes to stderr. `scripts/check-stdio-clean.mjs` proves it
 *    against a real spawned process on every CI run.
 *
 * 2. **`main` returns an exit code; it does not call `process.exit`.** Killing
 *    the process mid-write truncates whatever the stdio transport had
 *    buffered. The wrapper sets `process.exitCode` and lets node drain.
 *
 * Serves the seven tools `createServer()` (`server.ts`) registers. It is
 * called with no `deps`, so it reads `process.env` and calls the real
 * `globalThis.fetch` — exactly what `npx -y @forestrie/mcp-resolve` should do.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PACKAGE_VERSION, VERIFIER_VERSION } from "../core/index.js";
import { createServer } from "./server.js";

const HELP = `forestrie-mcp-resolve ${PACKAGE_VERSION}

  MCP server that fetches receipts, genesis documents and accumulator
  snapshots for @forestrie/mcp-verify to verify. Every result says where
  its bytes came from.

USAGE
  forestrie-mcp-resolve                start the MCP server on stdio (the default)
  forestrie-mcp-resolve --help
  forestrie-mcp-resolve --version

TOOLS
  fetch_scitt_configuration  fetch_receipt         fetch_accumulator
  query_registration         fetch_genesis         verify_fetched_receipt

ENVIRONMENT (optional; never a package default)
  FORESTRIE_BASE_URL   used when a call omits baseUrl
  FORESTRIE_RPC_URL    used when a call omits rpcUrl

CLIENT CONFIG
  {"mcpServers": {"forestrie-resolve":
    {"command": "npx", "args": ["-y", "@forestrie/mcp-resolve"]}}}

  Verifier: @forestrie/mcp-verify ${VERIFIER_VERSION}
  Docs:     https://github.com/forestrie/mcp-resolve#readme
`;

/** stdout is the transport in stdio mode; everything else is stderr. */
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];

  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    out(HELP);
    return 0;
  }
  if (args.includes("--version") || args.includes("-v")) {
    out(PACKAGE_VERSION);
    return 0;
  }

  const verb = args[0];
  if (verb !== undefined && !verb.startsWith("-")) {
    process.stderr.write(
      `forestrie-mcp-resolve: unknown command '${verb}'. Try --help.\n`,
    );
    return 1;
  }

  // Default: speak MCP on stdio. From here on, stdout belongs to the
  // transport and nothing else may touch it.
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Resolve when the transport closes, so the wrapper can set an exit code
  // rather than the process being torn down mid-write.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
  return 0;
}

/**
 * Entry point. `process.exitCode` rather than `process.exit()`: node then
 * drains stdout before exiting, which a hard exit would not.
 */
export async function run(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `forestrie-mcp-resolve: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

await run();
