/**
 * Thin GET wrappers over the four SCRAPI routes `src/core/endpoints.ts`
 * builds. Each makes exactly one request — `redirect: "manual"`, so a 303
 * comes back as a 303 with its `Location` header rather than being
 * followed (one request per call: a followed redirect would be a second
 * request) — and returns the raw `{status, headers, body, at}` for
 * `src/core/classify.ts` to interpret. Never throws on a non-2xx status;
 * `NetError` is thrown only when no response was obtained at all.
 *
 * `queryRegistration` and `fetchReceipt` go through `@forestrie/scrapi-client`
 * 0.2.2's `queryRegistrationRaw` / `resolveReceiptRaw`. These return the
 * uniform `{url, status, headers, body, at}` exchange
 * for EVERY status, structurally identical to this module's own
 * `RawResponse` (`./types.js`), so the mapping onto the classifier's view
 * is the identity: no field renaming, no status narrowing. Neither
 * function enforces a timeout or wraps a `fetchImpl` rejection on its own
 * — `http.ts`'s `withNetErrors` is what still draws this package's
 * `NetError`-only-when-no-response-at-all line for these two routes (see
 * that file's docstring).
 *
 * `fetchScittConfiguration` and `fetchGenesis` stay on `./http.js`'s own
 * `rawGet`: `@forestrie/scrapi-client` 0.2.2's `dist/index.d.ts` exports no
 * function for `.well-known/scitt-configuration` or
 * `/api/forest/{logId}/genesis` at all (only `register`,
 * `query-registration`, `resolve-receipt` and `problem-details`), so there
 * is nothing to replace these two routes with.
 *
 * The primitives scrapi-client exports that classification actually needs
 * — `RECEIPT_LOCATION_RE`, `parseEntryIdFromReceiptLocation`,
 * `decodeProblemDetailsBytes`, `toAbsoluteScrapiUrl` — are already imported
 * directly by `src/core/classify.ts`.
 */
import {
  queryRegistrationRaw,
  resolveReceiptRaw,
} from "@forestrie/scrapi-client";
import {
  genesisUrl,
  receiptUrl,
  registrationStatusUrl,
  scittConfigurationUrl,
} from "../core/index.js";
import { DEFAULT_TIMEOUT_MS, rawGet, withNetErrors } from "./http.js";
import type { FetchOptions, RawResponse } from "./types.js";

/** `GET {baseUrl}/.well-known/scitt-configuration`. No scrapi-client
 *  equivalent (see this file's docstring), so this route stays on
 *  `rawGet`. */
export async function fetchScittConfiguration(
  input: { baseUrl: string },
  opts?: FetchOptions,
): Promise<RawResponse> {
  return rawGet(
    scittConfigurationUrl(input.baseUrl),
    opts,
    "application/json",
  );
}

/** `GET {baseUrl}/logs/{bootstrap}/{logId}/entries/{contentHash}`, through
 *  `@forestrie/scrapi-client`'s `queryRegistrationRaw`: one request,
 *  `redirect: "manual"`, `Accept: application/cbor`. */
export async function queryRegistration(
  input: {
    baseUrl: string;
    bootstrapLogId: string;
    logId: string;
    contentHash: string;
  },
  opts?: FetchOptions,
): Promise<RawResponse> {
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return queryRegistrationRaw({
    statusUrl: registrationStatusUrl(
      input.baseUrl,
      input.bootstrapLogId,
      input.logId,
      input.contentHash,
    ),
    fetchImpl: withNetErrors(fetchImpl, timeoutMs),
  });
}

export type FetchReceiptInput =
  | { receiptUrl: string }
  | {
      baseUrl: string;
      bootstrapLogId: string;
      logId: string;
      massifHeight: number;
      entryId: string;
    };

/**
 * `GET {baseUrl}/logs/{bootstrap}/{logId}/{massifHeight}/entries/{entryId}/receipt`,
 * or a receipt URL already in hand (e.g. from `query_registration`'s
 * `receipt-location`), through `@forestrie/scrapi-client`'s
 * `resolveReceiptRaw`: one request, `redirect: "manual"`, with `Accept`
 * defaulting to `SCITT_RECEIPT_COSE_CONTENT_TYPE`
 * (`application/scitt.receipt+cose`) rather than the `application/cbor`
 * `queryRegistration` sends. The difference is deliberate; no fixture or test
 * pins the request's `Accept` header, only the response's `content-type`.
 */
export async function fetchReceipt(
  input: FetchReceiptInput,
  opts?: FetchOptions,
): Promise<RawResponse> {
  const url =
    "receiptUrl" in input
      ? input.receiptUrl
      : receiptUrl(
          input.baseUrl,
          input.bootstrapLogId,
          input.logId,
          input.massifHeight,
          input.entryId,
        );
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return resolveReceiptRaw({
    receiptUrl: url,
    fetchImpl: withNetErrors(fetchImpl, timeoutMs),
  });
}

/** `GET {baseUrl}/api/forest/{logId}/genesis`. No scrapi-client equivalent
 *  (see this file's docstring), so this route also stays on `rawGet`. */
export async function fetchGenesis(
  input: { baseUrl: string; logId: string },
  opts?: FetchOptions,
): Promise<RawResponse> {
  return rawGet(
    genesisUrl(input.baseUrl, input.logId),
    opts,
    "application/cbor",
  );
}
