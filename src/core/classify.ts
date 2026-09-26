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

/** The parts of an HTTP response `classify` needs. `location` is the
 *  `Location` header where one was sent (a 303); the receipt route's
 *  caller also passes the URL it requested, so a 404 there can name it. */
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

/** Any CBOR media type — `application/problem+cbor` (the spec'd type,
 *  what canopy's own API doc says it serves) or plain `application/cbor`
 *  (what the lanes actually serve their problem documents as today, and a
 *  content-type mismatch this decoder tolerates rather than handing the
 *  caller undecoded bytes). Only consulted on a non-2xx, so a receipt or a
 *  genesis is never mistaken for a problem document. */
function isCborMediaType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return /^application\/(?:[\w.-]+\+)?cbor(?:\s*;|$)/i.test(
    contentType.trim(),
  );
}

/** Does a decoded CBOR map look like an RFC 9457 / 9290 problem document?
 *  `title` or `status` is enough: a random CBOR map on an error status is
 *  not one. */
function isProblemShape(problem: ProblemDetails | undefined): boolean {
  return (
    problem !== undefined &&
    (typeof problem.title === "string" || typeof problem.status === "number")
  );
}

/** The human-readable line of a problem document, tolerating the canopy
 *  router quirk: its catch-all 404s put the human message in `type` (where
 *  a URI belongs) and send no `detail`. A `type` that is not a URI is that
 *  message; `about:blank` and anything with a scheme is not. */
function problemMessage(problem: ProblemDetails): string | undefined {
  if (typeof problem.detail === "string" && problem.detail.length > 0) {
    return problem.detail;
  }
  if (
    typeof problem.type === "string" &&
    problem.type.length > 0 &&
    !/^[a-z][a-z0-9+.-]*:/i.test(problem.type)
  ) {
    return problem.type;
  }
  if (typeof problem.title === "string" && problem.title.length > 0) {
    return problem.title;
  }
  return undefined;
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
  const decoded = isCborMediaType(view.contentType)
    ? decodeProblemDetailsBytes(view.body)
    : undefined;
  const problem = isProblemShape(decoded) ? decoded : undefined;
  const detail =
    (problem !== undefined ? problemMessage(problem) : undefined) ??
    fallbackDetail ??
    bodyPreview(view.body);
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
    // A 404 here is NOT "still sequencing": the registration route's 303
    // is the only pending signal. The operator answers 404 with a problem
    // document ("Entry receipt not found (checkpoint missing)", "(massif
    // height mismatch)", …) for a receipt URL it holds nothing at, and
    // `@forestrie/scrapi-client` classifies the same route's 404 as
    // not_found. Reported as a problem, carrying the operator's title.
    return problemResult(view);
  }

  // route === "genesis"
  if (view.status === 200) {
    return { kind: "genesis", bytes: view.body };
  }
  return problemResult(view);
}
