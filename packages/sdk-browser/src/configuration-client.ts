import type { Configuration } from "@rollfuse/contracts";
import { applyTraceHeaders, resolveTraceHeaders } from "@rollfuse/evaluation-core";

import { CredentialRejectedError, InitializationTimeoutError } from "./errors.js";

/** Default interval between successful-poll refreshes. */
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
/** Starting delay before retrying a failed poll. */
const BASE_BACKOFF_MS = 1_000;
/** Upper bound on the capped-exponential retry backoff. */
const MAX_BACKOFF_MS = 30_000;
/**
 * Default bound on `start()`'s returned Promise, per sdk-conformance's
 * "Initialization Completes Or Fails Within A Bounded Time" requirement.
 * Comfortably above one full request timeout plus first retry, so a
 * single transient failure inside the bound still has room to succeed on
 * retry, per the "A transient failure inside the bound" scenario.
 */
const DEFAULT_INIT_TIMEOUT_MS = 15_000;

export interface ConfigurationClientOptions {
  /** The platform API's base URL, e.g. "https://api.rollfuse.com". */
  baseUrl: string;
  /** The Public Credential's bearer token. */
  publicCredential: string;
  /** Interval between successful-poll refreshes, in milliseconds. */
  refreshIntervalMs?: number;
  /**
   * If set, `isStale()` reports true once this many milliseconds have
   * passed since the last successful fetch. Off by default: per
   * `feature-evaluation`'s "Failure Isolation" requirement, a
   * successfully-cached Configuration keeps serving indefinitely unless
   * an integrator explicitly opts into a staleness bound.
   */
  maxConfigAgeMs?: number;
  /**
   * Bounds `start()`'s returned Promise: it rejects with
   * `InitializationTimeoutError` if no fetch has succeeded within this
   * many milliseconds of the first `start()` call. Background polling is
   * not stopped by this — a later successful fetch still populates the
   * cache for subsequent `evaluate()` calls — only the integrator's own
   * await on `start()` is bounded. Default 15s.
   */
  initTimeoutMs?: number;
  /**
   * Injectable for tests; defaults to the browser's global `fetch`. Unlike
   * `@rollfuse/sdk-js`'s equivalent, no undici connection pool is created
   * here — the browser's own networking stack already pools and reuses
   * connections per-origin, and `undici` itself is a Node-only dependency
   * this package must never pull in.
   */
  fetchImpl?: typeof fetch;
  /** Called after each successful refresh, with the new Configuration Version. */
  onConfigRefreshed?: (version: number) => void;
  /** Called after each failed or invalid refresh attempt. */
  onConfigRefreshError?: (error: unknown) => void;
}

/**
 * Fetches, caches and background-refreshes a Public-Credential-scoped
 * Configuration from `GET /v1/config`, mirroring `@rollfuse/sdk-js`'s
 * `ConfigurationClient` behavior: construction does not fetch; `start()`
 * begins polling and returns a Promise resolving on the first successful
 * fetch (an integrator that doesn't want to block on it can call `start()`
 * without awaiting, and let `evaluate` use a fallback until the first
 * fetch lands). A failed or invalid poll leaves the previously cached
 * Configuration untouched and retries with capped exponential backoff; a
 * successfully cached Configuration keeps serving indefinitely once
 * fetched at least once, regardless of subsequent poll failures
 * (`feature-evaluation`'s "Failure Isolation").
 */
export class ConfigurationClient {
  private readonly baseUrl: string;
  private readonly publicCredential: string;
  private readonly refreshIntervalMs: number;
  private readonly maxConfigAgeMs: number | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onConfigRefreshed: ((version: number) => void) | undefined;
  private readonly onConfigRefreshError: ((error: unknown) => void) | undefined;

  private config: Configuration | undefined;
  private lastFetchedAt: number | undefined;
  private backoffMs = BASE_BACKOFF_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly initTimeoutMs: number;
  private started = false;
  private stopped = false;
  /** True once initialization has terminally failed (a rejected credential): pollLoop stops scheduling further retries, since retrying can only reproduce the same rejection. */
  private terminallyFailed = false;
  /** True once the ready Promise has settled (resolved or rejected), so a later settlement attempt (e.g. a success after an init-timeout rejection) is a harmless no-op rather than an error. */
  private readySettled = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly readyPromise: Promise<void>;

  constructor(options: ConfigurationClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.publicCredential = options.publicCredential;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.maxConfigAgeMs = options.maxConfigAgeMs;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    // Not a bare `fetch` reference, and not just any wrapper around it:
    // some environments (e.g. OpenTelemetry's fetch auto-instrumentation)
    // replace `window.fetch` with a wrapper that only works when invoked
    // with `this === window`/globalThis. `this.fetchImpl(...)` (member
    // access on this class) breaks that binding; so, subtly, does
    // `(...args) => fetch(...args)` — a bare identifier call inside an ES
    // module is strict-mode, so `this` is `undefined` there too. Only
    // explicit member-call syntax on `globalThis` (`globalThis.fetch(...)`)
    // reliably sets `this === globalThis` for the call. Getting this wrong
    // fails silently (this class never surfaces it beyond
    // `onConfigRefreshError`, which callers may not have wired up),
    // breaking every fetch forever.
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));

    this.onConfigRefreshed = options.onConfigRefreshed;
    this.onConfigRefreshError = options.onConfigRefreshError;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = () => {
        if (this.readySettled) {
          return;
        }

        this.readySettled = true;
        this.clearInitTimer();
        resolve();
      };
      this.readyReject = (error: Error) => {
        if (this.readySettled) {
          return;
        }

        this.readySettled = true;
        this.clearInitTimer();
        reject(error);
      };
    });

    // A rejected Promise that nobody attaches a handler to (a non-blocking
    // `start()` call, per the "Initialization is configured to be
    // non-blocking" scenario) would otherwise surface as an unhandled
    // rejection.
    this.readyPromise.catch(() => undefined);
  }

  private clearInitTimer(): void {
    if (this.initTimer !== undefined) {
      clearTimeout(this.initTimer);
      this.initTimer = undefined;
    }
  }

  /**
   * Begins polling. Returns a Promise resolving the first time a poll
   * succeeds (immediately, if one already has by the time this is
   * called), or rejecting once `initTimeoutMs` elapses without a success,
   * or immediately if the platform rejects the credential. Safe to call
   * more than once; only the first call starts the polling loop and the
   * init-timeout bound.
   */
  start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.initTimer = setTimeout(() => {
        this.readyReject(new InitializationTimeoutError(this.initTimeoutMs));
      }, this.initTimeoutMs);
      void this.pollLoop();
    }

    return this.readyPromise;
  }

  /** Stops polling. Safe to call whether or not `start()` was ever called. */
  stop(): void {
    this.stopped = true;
    this.clearInitTimer();

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** The currently cached Configuration, or undefined if none has ever been fetched. */
  getConfig(): Configuration | undefined {
    return this.config;
  }

  /**
   * True if `maxConfigAgeMs` is set and the cached Configuration (if any)
   * is older than it, or if nothing has ever been cached. Always false
   * when `maxConfigAgeMs` is not set.
   */
  isStale(): boolean {
    if (this.lastFetchedAt === undefined) {
      return true;
    }

    if (this.maxConfigAgeMs === undefined) {
      return false;
    }

    return Date.now() - this.lastFetchedAt > this.maxConfigAgeMs;
  }

  private async pollLoop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const succeeded = await this.attemptFetch();

    if (this.stopped || this.terminallyFailed) {
      return;
    }

    const delay = succeeded ? this.refreshIntervalMs : this.nextBackoff();

    this.timer = setTimeout(() => {
      void this.pollLoop();
    }, delay);
  }

  private nextBackoff(): number {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);

    return delay;
  }

  private async attemptFetch(): Promise<boolean> {
    try {
      const trace = await resolveTraceHeaders();
      const headers = applyTraceHeaders({ Authorization: `Bearer ${this.publicCredential}` }, trace);
      const response = await this.fetchImpl(`${this.baseUrl}/v1/config`, { headers });

      if (response.status === 401 || response.status === 403) {
        // Per sdk-conformance's "The credential is rejected" scenario:
        // fails immediately and is never retried, since retrying can only
        // ever reproduce the same rejection. terminallyFailed stops
        // pollLoop from scheduling another attempt.
        const error = new CredentialRejectedError(response.status);

        this.terminallyFailed = true;
        this.onConfigRefreshError?.(error);
        this.readyReject(error);

        return false;
      }

      if (!response.ok) {
        throw new Error(`GET /v1/config returned status ${response.status}`);
      }

      const body: unknown = await response.json();

      if (!isValidConfiguration(body)) {
        throw new Error("GET /v1/config response did not match the expected Configuration shape");
      }

      this.config = body;
      this.lastFetchedAt = Date.now();
      this.backoffMs = BASE_BACKOFF_MS;
      this.onConfigRefreshed?.(body.version);
      this.readyResolve();

      return true;
    } catch (error) {
      this.onConfigRefreshError?.(error);

      return false;
    }
  }
}

/**
 * A lightweight structural check — not full schema validation — sufficient
 * to reject a garbled or unexpectedly-shaped response before it ever
 * replaces a good cache, mirroring `@rollfuse/sdk-js`'s equivalent check.
 */
function isValidConfiguration(value: unknown): value is Configuration {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.environment_id !== "string") {
    return false;
  }

  if (typeof candidate.version !== "number") {
    return false;
  }

  if (!Array.isArray(candidate.flags)) {
    return false;
  }

  return candidate.flags.every(isValidFlagConfig);
}

function isValidFlagConfig(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.flag_key === "string" &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.default_variation === "string" &&
    Array.isArray(candidate.variations) &&
    Array.isArray(candidate.rules)
  );
}
