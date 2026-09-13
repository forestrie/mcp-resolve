/**
 * Thin GET wrappers over the four SCRAPI routes `src/core/endpoints.ts`
 * builds. Each makes exactly one request — `redirect: "manual"`, so a 303
 * comes back as a 303 with its `Location` header rather than being
 * followed (the plan's one-request rule: a followed redirect is a second
 * request) — and returns the raw `{status, headers, body}` for
 * `src/core/classify.ts` to interpret. Never throws on a non-2xx status;
 * `NetError` is thrown only when no response was obtained at all
 * (plan-2609-05 step 2.3).
 *
 * This module does not call into `@forestrie/scrapi-client` for the GETs
 * themselves. Its two poll-once primitives each interpret the response and
 * discard the raw headers/body for every status but their one success
 * case, so neither can produce the uniform `RawResponse` this layer needs
 * for every status:
 *
 * - `resolveReceiptOnce` (`dist/resolve-receipt.js:8-28`,
 *   `dist/resolve-receipt.d.ts:26-33`) returns `headers` + `body` only for
 *   status 200; a 404 comes back as a bare `{status:"pending"}` and
 *   anything else as a bare `{status:"error", httpStatus}` — no body, no
 *   headers, so `toClassifyView`'s `content-type`/`location`/`retry-after`
 *   mapping would have nothing to read for those cases.
 * - `queryRegistrationOnce` (`dist/query-registration.js:23-62`,
 *   `dist/query-registration.d.ts:31-45`) never surfaces headers or body
 *   at all — it returns only the interpreted `{status, location |
 *   receiptUrl+entryIdHex | httpStatus+problem+detail}`.
 * - Neither `@forestrie/scrapi-client` 0.1.4 module exports a function for
 *   `.well-known/scitt-configuration` or `/api/forest/{logId}/genesis` at
 *   all (`dist/index.d.ts:9-17` lists only `register`,
 *   `query-registration`, `resolve-receipt` and `problem-details`).
 *
 * The primitives scrapi-client exports that classification actually needs
 * — `RECEIPT_LOCATION_RE`, `parseEntryIdFromReceiptLocation`,
 * `decodeProblemDetailsBytes`, `toAbsoluteScrapiUrl` — are already imported
 * directly by `src/core/classify.ts` (phase 1), so nothing scrapi-client
 * offers is left uncovered by going straight to `fetchImpl` here.
 */
import {
  genesisUrl,
  receiptUrl,
  registrationStatusUrl,
  scittConfigurationUrl,
} from "../core/index.js";
import { rawGet } from "./http.js";
import type { FetchOptions, RawResponse } from "./types.js";

/** `GET {baseUrl}/.well-known/scitt-configuration`. */
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

/** `GET {baseUrl}/logs/{bootstrap}/{logId}/entries/{contentHash}`. */
export async function queryRegistration(
  input: {
    baseUrl: string;
    bootstrapLogId: string;
    logId: string;
    contentHash: string;
  },
  opts?: FetchOptions,
): Promise<RawResponse> {
  return rawGet(
    registrationStatusUrl(
      input.baseUrl,
      input.bootstrapLogId,
      input.logId,
      input.contentHash,
    ),
    opts,
    "application/cbor",
  );
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
 * `receipt-location`).
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
  return rawGet(url, opts, "application/cbor");
}

/** `GET {baseUrl}/api/forest/{logId}/genesis`. */
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
