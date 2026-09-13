/**
 * Pure URL construction: the four SCRAPI HTTP routes plan-2609-05 N2's table
 * names (`fetch_scitt_configuration`, `query_registration`, `fetch_receipt`,
 * `fetch_genesis`), and the calldata for the on-chain `logState` read (N4
 * amendment B). No `fetch`, no `node:*` — `src/net` (phase 2) is the only
 * place any of these URLs is dereferenced; this module only builds strings.
 */

/** A pure endpoint-construction failure: a bad `baseUrl`, log id, or
 *  address. Never thrown for anything a server sent back — that is
 *  `classify.ts`'s `Classified["kind"] === "problem"` job instead. */
export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointError";
  }
}

/** Trim exactly one trailing slash and reject an empty or non-http(s)
 *  base — every route is built on this. */
function trimBaseUrl(baseUrl: string): string {
  if (baseUrl.length === 0) {
    throw new EndpointError("baseUrl must not be empty");
  }
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new EndpointError(`baseUrl must be http(s), got '${baseUrl}'`);
  }
  return trimmed;
}

function joinSegments(base: string, segments: readonly string[]): string {
  return [base, ...segments.map((s) => encodeURIComponent(s))].join("/");
}

/** `GET {baseUrl}/.well-known/scitt-configuration`. */
export function scittConfigurationUrl(baseUrl: string): string {
  return `${trimBaseUrl(baseUrl)}/.well-known/scitt-configuration`;
}

/** `GET {baseUrl}/logs/{bootstrap}/{logId}/entries/{contentHash}`. */
export function registrationStatusUrl(
  baseUrl: string,
  bootstrapLogId: string,
  logId: string,
  contentHashHex: string,
): string {
  return joinSegments(trimBaseUrl(baseUrl), [
    "logs",
    bootstrapLogId,
    logId,
    "entries",
    contentHashHex,
  ]);
}

/** `GET {baseUrl}/logs/{bootstrap}/{logId}/{massifHeight}/entries/{entryId}/receipt`. */
export function receiptUrl(
  baseUrl: string,
  bootstrapLogId: string,
  logId: string,
  massifHeight: number,
  entryIdHex: string,
): string {
  return joinSegments(trimBaseUrl(baseUrl), [
    "logs",
    bootstrapLogId,
    logId,
    String(massifHeight),
    "entries",
    entryIdHex,
    "receipt",
  ]);
}

/** `GET {baseUrl}/api/forest/{logId}/genesis`. */
export function genesisUrl(baseUrl: string, logId: string): string {
  return joinSegments(trimBaseUrl(baseUrl), [
    "api",
    "forest",
    logId,
    "genesis",
  ]);
}

/* ---- Chain: the `logState(bytes32)` selector and calldata (N4 amendment B) ---- */

/** `logState(bytes32)` — `forestrie fetch-accumulator`'s selector. */
export const LOG_STATE_SELECTOR = "0xeecac1b7";

/**
 * A UUID (with dashes), 32-hex, or 64-hex log id -> the 32-byte contract
 * key (UUID in the low bytes, zero-padded on the left). Byte-identical to
 * `@forestrie/receipt-verify`'s local (unexported) `toContractLogId` in
 * `known-accumulator.js`, and to `forestrie-cli`'s copy — duplicated here
 * rather than imported because neither package exports it.
 */
export function toContractLogId(logId: string): string {
  const hex = logId.replace(/-/g, "").replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex) && !/^[0-9a-f]{64}$/.test(hex)) {
    throw new EndpointError(
      `log id must be a UUID or 16/32-byte hex id, got '${logId}'`,
    );
  }
  return `0x${hex.padStart(64, "0")}`;
}

/** `logState(bytes32)` calldata: selector ‖ the 32-byte contract log id. */
export function logStateCalldata(logId: string): string {
  return LOG_STATE_SELECTOR + toContractLogId(logId).slice(2);
}

/** Accepts a `0x`-prefixed or bare 40-hex address; returns `0x` + 40
 *  lowercase hex, or throws. */
export function normalizeAddress(addr: string): string {
  const hex = addr.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new EndpointError(
      `address must be 0x-prefixed or bare 40 hex, got '${addr}'`,
    );
  }
  return `0x${hex}`;
}
