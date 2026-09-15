/**
 * Response classification: status + content-type + body -> one of the
 * shapes `src/net` hands back to a tool, or a structured `problem` (a 429,
 * or anything else that is not the route's success contract, is a result,
 * never a throw). Pure over already-fetched bytes —
 * no `fetch`, no `node:*`.
 */
import type { ProblemDetails } from "@forestrie/scrapi-client";
import {
  RECEIPT_LOCATION_RE,
  decodeProblemDetailsBytes,
  parseEntryIdFromReceiptLocation,
  toAbsoluteScrapiUrl,
} from "@forestrie/scrapi-client";

export type ClassifyRoute =
  "configuration" | "registration" | "receipt" | "genesis";

/** The parts of an HTTP response `classify` needs. For a `receipt` route's
 *  404 ("still writing" — there is no Location header for a 404), the
 *  caller passes the receipt URL it requested as `location` so the
 *  resulting `pending` always carries a URL to retry. */
export type ClassifyView = {
  status: number;
  contentType?: string;
  location?: string;
  retryAfter?: string;
  body: Uint8Array;
};

export type Classified =
  | { kind: "configuration"; json: unknown }
  | { kind: "pending"; location: string; retryAfterMs?: number }
  | { kind: "receipt-location"; receiptUrl: string; entryIdHex: string }
  | { kind: "receipt"; bytes: Uint8Array }
  | { kind: "genesis"; bytes: Uint8Array }
  | {
      kind: "problem";
      status: number;
      retryAfterMs?: number;
      detail: string;
      problem?: ProblemDetails;
    };

function parseRetryAfterMs(
  retryAfter: string | undefined,
): number | undefined {
  if (retryAfter === undefined) return undefined;
  const seconds = Number.parseInt(retryAfter, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function bodyPreview(body: Uint8Array): string {
  if (body.length === 0) return "(empty body)";
  return new TextDecoder().decode(body.slice(0, 200));
}

function isProblemCbor(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return /^application\/problem\+cbor(?:\s*;|$)/i.test(contentType.trim());
}

function pendingResult(
  location: string,
  retryAfterMs: number | undefined,
): Classified {
  return {
    kind: "pending",
    location,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function problemResult(
  view: ClassifyView,
  fallbackDetail?: string,
): Classified {
  const retryAfterMs = parseRetryAfterMs(view.retryAfter);
  const problem = isProblemCbor(view.contentType)
    ? decodeProblemDetailsBytes(view.body)
    : undefined;
  const detail = problem?.detail ?? fallbackDetail ?? bodyPreview(view.body);
  return {
    kind: "problem",
    status: view.status,
    detail,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(problem !== undefined ? { problem } : {}),
  };
}

export function classify(
  route: ClassifyRoute,
  view: ClassifyView,
  baseUrl: string,
): Classified {
  // A 429 is always a structured problem, whichever route it came
  // back on — the package never polls, and never turns quota into a throw.
  if (view.status === 429) {
    return problemResult(view);
  }

  if (route === "configuration") {
    if (view.status >= 200 && view.status < 300) {
      try {
        const json = JSON.parse(
          new TextDecoder().decode(view.body),
        ) as unknown;
        return { kind: "configuration", json };
      } catch {
        return problemResult(view, "configuration response body is not JSON");
      }
    }
    return problemResult(view);
  }

  if (route === "registration") {
    if (view.status === 303) {
      if (view.location === undefined) {
        return problemResult(view, "303 without Location");
      }
      if (RECEIPT_LOCATION_RE.test(view.location)) {
        return {
          kind: "receipt-location",
          receiptUrl: toAbsoluteScrapiUrl(baseUrl, view.location),
          entryIdHex: parseEntryIdFromReceiptLocation(view.location),
        };
      }
      return pendingResult(
        toAbsoluteScrapiUrl(baseUrl, view.location),
        parseRetryAfterMs(view.retryAfter),
      );
    }
    return problemResult(view);
  }

  if (route === "receipt") {
    if (view.status === 200) {
      return { kind: "receipt", bytes: view.body };
    }
    if (view.status === 404) {
      return pendingResult(
        view.location ?? "",
        parseRetryAfterMs(view.retryAfter),
      );
    }
    return problemResult(view);
  }

  // route === "genesis"
  if (view.status === 200) {
    return { kind: "genesis", bytes: view.body };
  }
  return problemResult(view);
}
