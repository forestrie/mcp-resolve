/**
 * Outward-facing text for the MCP adapter: the server `instructions` string
 * and the six tool descriptions. Orchestrator prose (plan-2609-05
 * execution-model item 12): the vocabulary is "trust roots" and "the four
 * questions", and nothing here ranks the roots. Workers wire these strings
 * in; they do not rephrase them. The `supports` notes themselves live in
 * `src/core/provenance.ts` and are asserted verbatim by
 * `test/core/supports-table.test.ts`.
 */
import type { ToolName } from "../core/index.js";

export const INSTRUCTIONS = `@forestrie/mcp-resolve fetches the material @forestrie/mcp-verify verifies: a receipt, a genesis document, an accumulator snapshot, a registration status, a service configuration. It is a courier, not a verifier; the verifier runs in your process with no network, and this package exists so that installing the verifier never implies one.

Every result says where its bytes came from (provenance: fetched from a URL, read from a chain at an RPC URL, or supplied by you) and which of the four questions of the trust model they can support, under which trust root (supports). The four questions are sealing, split-view, append-authority and attribution; the four trust roots are genesis, known-log-key, known-accumulator and checkpoint-chain (forestrie/protocol spec/receipt-trust-model.md). The roots are not ordered: which one is right depends on what you hold, and a fetched copy changes what you hold. A fetch tool's supports row is usually empty: a receipt is the operator's claim until you verify it under a root you hold.

Inputs. baseUrl is any SCRAPI base URL; rpcUrl is your own chain access. Neither has a built-in default. If your MCP client sets FORESTRIE_BASE_URL or FORESTRIE_RPC_URL in the server's environment, those are used when a call omits the argument; they are your values, not this package's. Two public lanes exist as examples, not defaults: https://api-a.forest-2.forestrie.dev (service id canopy-dev-1) and https://api-b.forest-2.forestrie.dev (service id canopy-prod-1). The univocity contract address and chain id are properties of a forest, bound in its genesis document: fetch_accumulator and the chain path of verify_fetched_receipt take them from a genesis you hold, or explicitly, never from the operator and never from an environment variable.

verify_fetched_receipt fetches a receipt and verifies it under a root you supply as bytes (genesis, keyXy, accumulator or checkpoints) or under an accumulator read from the chain in the same call (root known-accumulator). It never uses a genesis fetched in the same call as the root: a genesis obtained from the operator at check time makes the operator the supplier of both the receipt and the root, which proves consistency with a document the operator chose to serve today and nothing more. fetch_genesis exists so you can obtain the document once, keep it, and pass it as bytes from then on. The verifier's own questions object is passed through unaltered; this package adds diagnostics saying where the bytes came from. not_answered_by_this_root is a real answer; show it.

Requests. Each call makes one request per URL and never polls: query_registration returns pending or the receipt location, and you decide whether to call it again. An HTTP 429 comes back as a structured problem with status 429 and retryAfterMs when the server said so, not as an error. Bytes are returned base64-encoded, and a receipt also comes decoded so you can read what you fetched without a second call.`;

export const TOOL_TITLES: Record<ToolName, string> = {
  fetch_scitt_configuration: "Fetch SCITT configuration",
  query_registration: "Query registration status",
  fetch_receipt: "Fetch receipt",
  fetch_genesis: "Fetch genesis document",
  fetch_accumulator: "Fetch accumulator from chain",
  verify_fetched_receipt: "Fetch and verify receipt",
};

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  fetch_scitt_configuration:
    "GET {baseUrl}/.well-known/scitt-configuration: the transparency service's self-description (service id, base URL, supported algorithms), returned as JSON. Provenance: fetched. Supports: none of the four questions; this is what the operator says about itself.",

  query_registration:
    "One GET of {baseUrl}/logs/{bootstrapLogId}/{logId}/entries/{contentHash}, where contentHash is the hex sha256 of the signed statement bytes. Returns pending (with retryAfterMs when the server said so) or the receipt's URL and entry id. Never polls: call again yourself if you want to. Provenance: fetched. Supports: none of the four questions; this is registration status.",

  fetch_receipt:
    "GET a receipt: either by receiptUrl (as returned by query_registration) or by {baseUrl, bootstrapLogId, logId, massifHeight, entryId}. Returns the receipt bytes base64-encoded plus the verifier's decoding of them. Provenance: fetched. Supports: none on its own; a receipt is the operator's claim, so verify it under a trust root you hold (or use verify_fetched_receipt).",

  fetch_genesis:
    "GET {baseUrl}/api/forest/{logId}/genesis: the forest's genesis document as CBOR, base64-encoded, with the bootstrap key and the chain binding (univocity contract address, chain id) decoded. For capture: obtain it once, keep it, and pass it as bytes from then on. A copy obtained at check time is not the genesis trust root as intended, and its chain binding is likewise the operator's claim today; keep the copy from registration, or cross-check it against a source you trust independently. Provenance: fetched. Supports: sealing, as known-log-key with the key this copy carries.",

  fetch_accumulator:
    "Read the log's published accumulator from the univocity contract at your rpcUrl: eth_chainId, then eth_getBlockByNumber latest, then one eth_call logState(logId) at that block. The contract address and chain id come from a genesis you hold ({genesis, rpcUrl, logId}) or are given explicitly ({rpcUrl, univocity, logId, chainId?}); a chain id mismatch is reported as a problem before any call. Returns the snapshot CBOR the verifier's known-accumulator root consumes, base64-encoded, with size, block number and block hash. Provenance: chain-read. Supports: split-view under known-accumulator, against the chain rather than the operator; sealing and append-authority by inheritance from the contract's publish-time checks, not by a local signature check.",

  verify_fetched_receipt:
    "Fetch a receipt (as fetch_receipt) and verify it with @forestrie/mcp-verify's core under a trust root you supply as bytes (genesis, keyXy, accumulator, or checkpoints) or under an accumulator read from the chain in this call ({root: 'known-accumulator', chain: {genesis, rpcUrl, logId} or {rpcUrl, univocity, logId, chainId?}}). A genesis fetched in the same call is never the root. The result is the verifier's own: stages, the four questions (sealing, split-view, append-authority, attribution; not_answered_by_this_root is a real answer) and diagnostics, passed through unaltered, plus receipt_fetched_from_operator always and root_read_from_chain when the chain path was taken. Supply payload bytes and the entry id to have attribution answered.",
};
