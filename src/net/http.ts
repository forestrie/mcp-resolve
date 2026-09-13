/**
 * Internal fetch plumbing shared by `scrapi.ts` and `chain.ts`: a single
 * request through an injected `fetchImpl`, a per-request timeout enforced
 * by both an `AbortSignal` (for a well-behaved `fetchImpl`) and a timer
 * race (so a `fetchImpl` that never settles, and ignores the signal, still
 * yields a `timeout` `NetError` rather than hanging the caller forever),
 * and `RawResponse` assembly (lowercase headers, body bytes, request time).
 *
 * Not exported from `./net` — `scrapi.ts` and `chain.ts` are the public
 * surface; this is plumbing underneath both, so the "one place fetch is
 * called" of `src/net`'s two source files.
 */
import { NetError, type FetchOptions, type RawResponse } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 30_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new NetError("timeout", `timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function toHeaderRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

async function toRawResponse(
  url: string,
  res: Response,
  at: string,
): Promise<RawResponse> {
  const body = new Uint8Array(await res.arrayBuffer());
  return {
    url,
    status: res.status,
    headers: toHeaderRecord(res.headers),
    body,
    at,
  };
}

/**
 * One GET, `redirect: "manual"` so a 303 comes back as a 303 with its
 * `Location` header rather than being followed — the plan's one-request
 * rule: a followed redirect is a second request. Throws `NetError` only
 * when no response was obtained at all.
 */
export async function rawGet(
  url: string,
  opts: FetchOptions | undefined,
  accept?: string,
): Promise<RawResponse> {
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const at = new Date().toISOString();
  let res: Response;
  try {
    res = await withTimeout(
      (signal) =>
        fetchImpl(url, {
          redirect: "manual",
          signal,
          ...(accept !== undefined ? { headers: { accept } } : {}),
        }),
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof NetError) throw err;
    throw new NetError(
      "network",
      `network error fetching ${url}: ${errorMessage(err)}`,
      { cause: err },
    );
  }
  return toRawResponse(url, res, at);
}

/**
 * One JSON-RPC 2.0 POST (`content-type: application/json`). Throws
 * `NetError` only when no response was obtained at all; a JSON-RPC-level
 * `error` member or a non-2xx status comes back as the `RawResponse` for
 * `chain.ts` to interpret into a structured `problem`.
 */
export async function rawJsonRpcPost(
  url: string,
  body: unknown,
  opts: FetchOptions | undefined,
): Promise<RawResponse> {
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const at = new Date().toISOString();
  let res: Response;
  try {
    res = await withTimeout(
      (signal) =>
        fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }),
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof NetError) throw err;
    throw new NetError(
      "network",
      `network error posting to ${url}: ${errorMessage(err)}`,
      { cause: err },
    );
  }
  return toRawResponse(url, res, at);
}
