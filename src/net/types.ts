/**
 * Shared network-layer types: the raw HTTP response every `src/net`
 * function returns undecoded (classification is `src/core/classify.ts`'s
 * job, never this layer's), the options every function accepts, the error
 * thrown only when no response was obtained at all, and the mapping from a
 * `RawResponse` onto core's `ClassifyView`.
 */
import type { ClassifyView } from "../core/index.js";

/**
 * Every function in `src/net` resolves to this instead of throwing on a
 * non-2xx status — a 404, a 429, a 5xx are all results for
 * `src/core/classify.ts` to interpret, never a throw (N8).
 */
export type RawResponse = {
  url: string;
  status: number;
  /** Lowercase header names, as iterated off the Fetch API's `Headers` —
   *  never re-cased by this layer. */
  headers: Record<string, string>;
  body: Uint8Array;
  /** ISO time the request was made. */
  at: string;
};

/**
 * Every `src/net` function takes this. `fetchImpl` defaults to
 * `globalThis.fetch`, so `test/net/**` can exercise this layer entirely
 * through injected fakes and the unit project's forbidden-fetch setup (N6
 * gate 2) never sees a real network call. `timeoutMs` defaults to 30s and
 * is enforced by both an `AbortSignal` (for a well-behaved `fetchImpl`) and
 * a timer race (so a `fetchImpl` that never settles, and ignores the
 * signal, still yields a `timeout` `NetError` rather than hanging the
 * caller forever).
 */
export type FetchOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Thrown only when no response was obtained at all: a rejected `fetchImpl`
 * (`code: "network"`) or one that did not settle within `timeoutMs`
 * (`code: "timeout"`). Anything a server actually answered — including a
 * 429, a 5xx, or a malformed body — comes back as a `RawResponse` (or, on
 * the chain side, a structured `problem`) for the caller to interpret; it
 * is never thrown.
 */
export class NetError extends Error {
  readonly code: "network" | "timeout";
  constructor(
    code: "network" | "timeout",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "NetError";
    this.code = code;
  }
}

/**
 * Map a `RawResponse` onto core's `ClassifyView`: lowercase header lookups
 * for `content-type`, `location` and `retry-after`. `classify()` itself
 * decides what a status/content-type/body combination means — this is
 * purely the field mapping between the two layers' shapes.
 */
export function toClassifyView(raw: RawResponse): ClassifyView {
  return {
    status: raw.status,
    ...(raw.headers["content-type"] !== undefined
      ? { contentType: raw.headers["content-type"] }
      : {}),
    ...(raw.headers["location"] !== undefined
      ? { location: raw.headers["location"] }
      : {}),
    ...(raw.headers["retry-after"] !== undefined
      ? { retryAfter: raw.headers["retry-after"] }
      : {}),
    body: raw.body,
  };
}
