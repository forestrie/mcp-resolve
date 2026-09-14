/**
 * Internal fetch plumbing shared across `src/net`: a per-request timeout
 * enforced by both an `AbortSignal` (for a well-behaved `fetchImpl`) and a
 * timer race (so a `fetchImpl` that never settles, and ignores the signal,
 * still yields a `timeout` `NetError` rather than hanging the caller
 * forever), plus `RawResponse` assembly (lowercase headers, body bytes,
 * request time).
 *
 * `rawGet` is this module's own transport, used for the two SCRAPI routes
 * `@forestrie/scrapi-client` 0.2.2 has no function for —
 * `.well-known/scitt-configuration` and `/api/forest/{logId}/genesis`
 * (plan-2609-06 F7; `dist/index.d.ts` lists only `register`,
 * `query-registration`, `resolve-receipt` and `problem-details`).
 *
 * `withNetErrors` is what `chain.ts` and `scrapi.ts`'s two migrated routes
 * (`queryRegistration`, `fetchReceipt`) wrap a caller's `fetchImpl` in
 * before handing it to `@forestrie/chain-rpc`'s `ethRpc` or
 * `@forestrie/scrapi-client`'s `*Raw` functions (F7): neither library
 * enforces a timeout of its own or distinguishes "no response was obtained
 * at all" from a response it simply doesn't interpret — `ethRpc` treats a
 * signal-ignoring `fetchImpl` as a hang (its own `AbortController` has
 * nothing to cancel), and scrapi-client's `*Raw` functions have no timeout
 * logic whatsoever, one bare `await doFetch(...)`. Wrapping the `fetchImpl`
 * itself, rather than the library call, is what keeps this package's
 * "`NetError` only when no response was obtained at all" invariant true for
 * routes this layer no longer calls `fetch` for directly — both libraries
 * simply rethrow whatever their injected `fetchImpl` throws, `NetError`
 * included, so a `NetError` raised inside the wrapped `fetchImpl` reaches
 * `chain.ts`/`scrapi.ts` unchanged.
 *
 * Not exported from `./net` — `scrapi.ts` and `chain.ts` are the public
 * surface; this is plumbing underneath both, so the "one place fetch is
 * called" of `src/net`'s two source files (through an injected `fetchImpl`
 * in every case, direct or wrapped).
 */
import { NetError, type FetchOptions, type RawResponse } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 30_000;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function withTimeout<T>(
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

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wrap a `fetchImpl` so every call it makes races against `timeoutMs` and
 * classifies a failure exactly as `rawGet` above always has: `"timeout"` on
 * expiry (even against a `fetchImpl` that ignores the `AbortSignal` it is
 * given — the timer branch of `withTimeout`'s race wins regardless of
 * whether the callee ever looks at the signal), `"network"` for anything
 * else the underlying `fetchImpl` itself throws. See this file's docstring
 * for why `@forestrie/chain-rpc`'s `ethRpc` and `@forestrie/scrapi-client`'s
 * `*Raw` functions need this wrapped around the `fetchImpl` they are given,
 * rather than relying on either library's own (absent, in scrapi-client's
 * case; signal-only, in chain-rpc's) timeout handling.
 */
export function withNetErrors(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): typeof fetch {
  return (async (input, init) => {
    return withTimeout(async (signal) => {
      try {
        return await fetchImpl(input, { ...init, signal });
      } catch (err) {
        if (err instanceof NetError) throw err;
        throw new NetError(
          "network",
          `network error fetching ${requestUrl(input)}: ${errorMessage(err)}`,
          { cause: err },
        );
      }
    }, timeoutMs);
  }) as typeof fetch;
}
