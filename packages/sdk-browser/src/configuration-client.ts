import type { Configuration } from "@rollfuse/contracts";
import { CLIENT_FORMAT_VERSION, applyTraceHeaders, resolveTraceHeaders } from "@rollfuse/evaluation-core";

import { CredentialRejectedError, InitializationTimeoutError } from "./errors.js";
import { safeInvoke } from "./safe-invoke.js";

/** Default interval between successful-poll refreshes, used only when neither an explicit refreshIntervalMs nor the platform's advised poll_interval_seconds is available (task 9.3). */
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
/** Starting delay before retrying a failed poll. */
const BASE_BACKOFF_MS = 1_000;
/** Upper bound on the capped-exponential retry backoff. */
const MAX_BACKOFF_MS = 30_000;
/**
 * Fraction of extra random delay added on top of every poll/retry delay
 * (task 9.2): spreads out many clients' schedules that would otherwise
 * synchronize (e.g. many processes started around the same time), per
 * sdk-conformance's "Polling Revalidates And Does Not Synchronize"
 * requirement. Always adds, never subtracts, so a client never polls less
 * frequently than its own configured/advised interval.
 */
const JITTER_RATIO = 0.2;
/**
 * Default bound on `start()`'s returned Promise, per sdk-conformance's
 * "Initialization Completes Or Fails Within A Bounded Time" requirement.
 * Comfortably above one full request timeout plus first retry, so a
 * single transient failure inside the bound still has room to succeed on
 * retry, per the "A transient failure inside the bound" scenario.
 */
const DEFAULT_INIT_TIMEOUT_MS = 15_000;
/**
 * Default deadline applied to every GET /v1/config request via
 * AbortSignal.timeout, regardless of whether fetchImpl is the browser's
 * global fetch or one the integrator injected — see requestTimeoutMs's
 * own doc comment.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface ConfigurationClientOptions {
  /** The platform API's base URL, e.g. "https://api.rollfuse.com". */
  baseUrl: string;
  /** The Public Credential's bearer token. */
  publicCredential: string;
  /**
   * Interval between successful-poll refreshes, in milliseconds. When
   * unset, the platform's advised `poll_interval_seconds` (from the most
   * recently fetched Configuration) is used in preference to this
   * class's own hardcoded default, per sdk-conformance's "The platform
   * advises an interval" scenario (task 9.3) — an explicit value here
   * always wins over either.
   */
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
  /**
   * Deadline applied to every GET /v1/config request via
   * `AbortSignal.timeout`, regardless of which `fetchImpl` is in use —
   * per sdk-conformance's "A transport is injected" scenario, an
   * integrator-supplied transport gets this library's own deadline too,
   * not only whatever (if anything) that transport enforces on its own.
   * Default 10s.
   */
  requestTimeoutMs?: number;
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
  /** Undefined unless the integrator explicitly configured it — see currentRefreshIntervalMs's own doc comment for the resolution order. */
  private readonly explicitRefreshIntervalMs: number | undefined;
  private readonly maxConfigAgeMs: number | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onConfigRefreshed: ((version: number) => void) | undefined;
  private readonly onConfigRefreshError: ((error: unknown) => void) | undefined;

  private config: Configuration | undefined;
  private lastFetchedAt: number | undefined;
  /** The last GET /v1/config response's ETag, verbatim (quotes included) — echoed back via If-None-Match on the next poll (task 9.1). Undefined until the first successful (non-304) fetch. */
  private etag: string | undefined;
  private backoffMs = BASE_BACKOFF_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly initTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private started = false;
  private stopped = false;
  /**
   * True while a poll attempt (attemptFetch) is actually in flight,
   * distinct from `started`: `started` guards the one-time init-timer/
   * readyPromise setup and stays true forever, while `looping` reflects
   * whether the loop is between poll attempts (a timer pending) or
   * currently awaiting one, so `start()` after a `stop()` (task 8.3) can
   * tell whether it needs to kick the loop again itself or whether an
   * already-in-flight attempt will pick the resumed state back up once
   * it settles.
   */
  private looping = false;
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
    this.explicitRefreshIntervalMs = options.refreshIntervalMs;
    this.maxConfigAgeMs = options.maxConfigAgeMs;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
   * or immediately if the platform rejects the credential. The one-time
   * init-timeout bound and readiness Promise are only ever set up once,
   * but calling `start()` again after `stop()` resumes polling (task
   * 8.3): the client must not remain permanently inert after a
   * stop()/start() cycle.
   */
  start(): Promise<void> {
    this.stopped = false;

    if (!this.started) {
      this.started = true;
      this.initTimer = setTimeout(() => {
        this.readyReject(new InitializationTimeoutError(this.initTimeoutMs));
      }, this.initTimeoutMs);
      this.runPollLoop();
    } else if (!this.looping && !this.terminallyFailed) {
      // Resuming after stop(): no attempt is currently in flight (if one
      // were, it will itself pick the resumed `stopped = false` state back
      // up once it settles, per pollLoop's own check), and no timer is
      // pending either (stop() cleared it) — kick the loop immediately
      // rather than waiting for a timer that no longer exists.
      this.runPollLoop();
    }

    return this.readyPromise;
  }

  /**
   * Starts `pollLoop()` without awaiting it (it runs for the client's
   * whole lifetime), with a terminal `.catch()` — sdk-conformance's "A
   * background loop rejects" scenario: `pollLoop`/`attemptFetch` should
   * never actually reject (every path is already contained), but an
   * unawaited async call with no handler at all becomes an unhandled
   * rejection if a future change ever reintroduces one. This is the
   * backstop for that class of regression, not an expected path.
   */
  private runPollLoop(): void {
    this.looping = true;

    this.pollLoop()
      .catch((error: unknown) => {
        safeInvoke(this.onConfigRefreshError, error);
      })
      .finally(() => {
        this.looping = false;
      });
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

    const baseDelay = succeeded ? this.currentRefreshIntervalMs() : this.nextBackoff();
    const delay = withJitter(baseDelay);

    this.timer = setTimeout(() => {
      this.runPollLoop();
    }, delay);
  }

  /**
   * Resolution order (task 9.3): an explicitly configured
   * `refreshIntervalMs` always wins; otherwise the platform's advised
   * `poll_interval_seconds` (from the most recently fetched
   * Configuration, including one only confirmed unchanged via a 304)
   * wins over this class's own hardcoded default.
   */
  private currentRefreshIntervalMs(): number {
    if (this.explicitRefreshIntervalMs !== undefined) {
      return this.explicitRefreshIntervalMs;
    }

    const advisedSeconds = this.config?.poll_interval_seconds;

    if (advisedSeconds !== undefined && advisedSeconds > 0) {
      return advisedSeconds * 1000;
    }

    return DEFAULT_REFRESH_INTERVAL_MS;
  }

  private nextBackoff(): number {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);

    return delay;
  }

  private async attemptFetch(): Promise<boolean> {
    try {
      const trace = await resolveTraceHeaders();
      const headers = applyTraceHeaders(
        {
          Authorization: `Bearer ${this.publicCredential}`,
          // Declares this client's own configuration format capability
          // (expand-targeting-model task 3.1) — see evaluate.ts's
          // CLIENT_FORMAT_VERSION.
          "X-Rollfuse-Client-Format-Version": String(CLIENT_FORMAT_VERSION),
        },
        trace,
      );

      // Presents the last-seen validator (task 9.1): the platform
      // revalidates against it and responds 304 with no body if the
      // Configuration hasn't changed, instead of re-transferring one that
      // would just replace an identical cache.
      if (this.etag !== undefined) {
        headers["If-None-Match"] = this.etag;
      }

      const response = await this.fetchImpl(`${this.baseUrl}/v1/config`, {
        headers,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

      if (response.status === 401 || response.status === 403) {
        // Per sdk-conformance's "The credential is rejected" scenario:
        // fails immediately and is never retried, since retrying can only
        // ever reproduce the same rejection. terminallyFailed stops
        // pollLoop from scheduling another attempt.
        const error = new CredentialRejectedError(response.status);

        this.terminallyFailed = true;
        // Settle readiness before invoking any integrator callback (task
        // 3.2's ordering), and go through safeInvoke rather than calling
        // the callback directly (task 3.1): a throwing callback here must
        // not be caught by this method's own outer catch below and
        // misreported as a second, different failure.
        this.readyReject(error);
        safeInvoke(this.onConfigRefreshError, error);

        return false;
      }

      if (response.status === 304) {
        // The platform confirmed the cached Configuration is still
        // current (task 9.1): a successful poll in every sense that
        // matters for scheduling/staleness, but with nothing to replace
        // the cache with and nothing to notify onConfigRefreshed about.
        this.lastFetchedAt = Date.now();
        this.backoffMs = BASE_BACKOFF_MS;
        this.readyResolve();

        return true;
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
      this.etag = response.headers.get("etag") ?? undefined;
      // Readiness resolves before the integrator's own callback runs
      // (sdk-conformance's "Readiness resolves before callbacks run"
      // scenario), and goes through safeInvoke: previously, a throwing
      // onConfigRefreshed escaped into this method's own catch below,
      // which then reported an objectively successful fetch as a failure
      // and left start() unresolved — exactly the "A success callback
      // throws" scenario this now satisfies.
      this.readyResolve();
      safeInvoke(this.onConfigRefreshed, body.version);

      return true;
    } catch (error) {
      safeInvoke(this.onConfigRefreshError, error);

      return false;
    }
  }
}

/**
 * A lightweight structural check — not full schema validation — sufficient
 * to reject a garbled or unexpectedly-shaped response before it ever
 * replaces a good cache, mirroring `@rollfuse/sdk-js`'s equivalent check.
 * Validates every element within variations/rules, not only that the
 * containers are arrays (task 5.1): a malformed element (e.g. a null
 * entry, or a Variation with no `key`) previously passed this check and
 * could crash `evaluateFlag` later, at evaluation time, rather than being
 * rejected here at fetch time.
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
    candidate.variations.every(isValidVariation) &&
    Array.isArray(candidate.rules) &&
    candidate.rules.every(isValidRule)
  );
}

function isValidVariation(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return typeof (value as Record<string, unknown>).key === "string";
}

function isValidRule(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (candidate.conditions !== undefined) {
    if (!Array.isArray(candidate.conditions) || !candidate.conditions.every(isValidCondition)) {
      return false;
    }
  }

  return isValidOutcome(candidate.outcome);
}

function isValidCondition(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return typeof candidate.attribute === "string" && typeof candidate.value === "string";
}

/**
 * Mirrors evaluation-core's own resolveOutcome logic exactly: a rollout
 * with at least one split is used in preference to variation_key (so
 * variation_key is not required when a non-empty rollout is present),
 * and each split must itself be well-formed.
 */
function isValidOutcome(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (candidate.rollout !== undefined) {
    if (!Array.isArray(candidate.rollout)) {
      return false;
    }

    if (candidate.rollout.length > 0) {
      return candidate.rollout.every(isValidRolloutSplit);
    }
  }

  return typeof candidate.variation_key === "string";
}

function isValidRolloutSplit(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return typeof candidate.variation_key === "string" && typeof candidate.percentage === "number";
}

/**
 * Adds up to JITTER_RATIO extra random delay on top of baseMs (task 9.2),
 * so many clients' poll/retry schedules spread out rather than
 * synchronizing. Always >= baseMs: never polls less frequently than the
 * caller's own configured/advised interval intended.
 */
function withJitter(baseMs: number): number {
  return baseMs + baseMs * JITTER_RATIO * Math.random();
}
