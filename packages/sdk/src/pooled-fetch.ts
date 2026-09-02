import { Pool, fetch as undiciFetch } from "undici";

/** Configurable per-connection timeouts, applied to every request the pool serves. */
export interface PooledFetchTimeouts {
  /** Time allowed to receive the response headers. Undici default: 300_000ms. */
  headersTimeoutMs?: number;
  /** Time allowed to receive the full response body. Undici default: 300_000ms. */
  bodyTimeoutMs?: number;
  /** Time allowed to establish the TCP/TLS connection. Undici default: 10_000ms. */
  connectTimeoutMs?: number;
}

/** A `fetch`-compatible function bound to one undici connection pool, closeable when done. */
export type PooledFetch = typeof fetch & { close(): Promise<void> };

/**
 * Builds a `fetch`-compatible function backed by an undici `Pool` scoped to
 * baseUrl, with configurable connect/headers/body timeouts — closing the
 * gap Node's global `fetch` leaves (no per-request timeout at all) for a
 * long-lived polling/flushing client that repeatedly calls the same host.
 * See design.md Decision 3 in `strengthen-contracts-typing`.
 *
 * Deliberately not used when a caller supplies their own `fetchImpl`
 * (tests inject a fake one) — this is only the *default*, same as the
 * bare `fetch` it replaces.
 */
export function createPooledFetch(baseUrl: string, timeouts: PooledFetchTimeouts = {}): PooledFetch {
  // headersTimeout/bodyTimeout/connectTimeout are Pool constructor options
  // in undici, not per-call fetch() options — they configure every
  // connection the pool opens, not one request at a time.
  const pool = new Pool(baseUrl, {
    connectTimeout: timeouts.connectTimeoutMs,
    headersTimeout: timeouts.headersTimeoutMs,
    bodyTimeout: timeouts.bodyTimeoutMs,
  });

  const pooledFetch = (async (input: string | URL, init?: RequestInit) =>
    undiciFetch(input as string, {
      ...(init as Record<string, unknown>),
      dispatcher: pool,
    } as never)) as unknown as PooledFetch;

  pooledFetch.close = async () => {
    await pool.close();
  };

  return pooledFetch;
}
