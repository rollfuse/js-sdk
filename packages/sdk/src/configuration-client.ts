import type { Configuration } from "@rollfuse/contracts";
import { CLIENT_FORMAT_VERSION, applyTraceHeaders, resolveTraceHeaders } from "@rollfuse/evaluation-core";

import { CredentialRejectedError, InitializationTimeoutError } from "./errors.js";
import { type PooledFetch, createPooledFetch } from "./pooled-fetch.js";
import { safeInvoke } from "./safe-invoke.js";
import { SSEParser } from "./sse-reader.js";

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
/** Default undici pool timeouts for the polling fetch — see design.md Decision 3. */
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/**
 * Default bound on `start()`'s returned Promise, per sdk-conformance's
 * "Initialization Completes Or Fails Within A Bounded Time" requirement.
 * Comfortably above one full request-timeout-plus-first-retry
 * (DEFAULT_HEADERS_TIMEOUT_MS + BASE_BACKOFF_MS) so a single transient
 * failure inside the bound still has room to succeed on retry, per the
 * "A transient failure inside the bound" scenario.
 */
const DEFAULT_INIT_TIMEOUT_MS = 15_000;
/**
 * Default deadline applied to every GET /v1/config request via
 * AbortSignal.timeout, regardless of whether fetchImpl is this class's
 * own pooled fetch or one the integrator injected — see
 * requestTimeoutMs's own doc comment.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Starting delay before retrying a broken/refused GET /v1/config/stream connection (add-configuration-streaming task 5.3). */
const STREAM_BASE_BACKOFF_MS = 1_000;
/** Upper bound on the capped-exponential stream-reconnect backoff. */
const STREAM_MAX_BACKOFF_MS = 30_000;
/** Bounds only the connect-and-hello-handshake phase of a stream connection, never the unbounded read loop that follows — see streamConnectOnce's own doc comment. */
const STREAM_SETUP_TIMEOUT_MS = 10_000;
/** Used only if a hello event's own heartbeat_interval_seconds is missing or non-positive — should not happen against this platform's real endpoint, but a stale/incompatible server should never leave the watchdog with no threshold at all. */
const DEFAULT_HEARTBEAT_SECONDS = 30;
/** A connection with no frame (heartbeat or version) for this many multiples of the disclosed heartbeat interval is treated as silently broken (task 5.3). */
const MISSED_HEARTBEAT_MULTIPLIER = 3;

/** The platform's GET /v1/config/stream first event, disclosing the heartbeat interval, this connection's own maximum lifetime, and the poll interval a connected client should fall back to. */
interface StreamHelloEvent {
  heartbeat_interval_seconds?: number;
  max_lifetime_seconds?: number;
  poll_interval_seconds?: number;
}

/** add-configuration-streaming task 5.7's diagnostic path: which mechanism is currently delivering Configuration changes to this client. Streaming is always an optimization layered on top of polling, which never stops regardless of this value. */
export interface TransportInfo {
  /** True while a GET /v1/config/stream connection is currently established. False before the first connection attempt completes, while reconnecting after a break, or when streamingDisabled was supplied. */
  streaming: boolean;
}

export interface ConfigurationClientOptions {
  /** The platform API's base URL, e.g. "https://api.rollfuse.com". */
  baseUrl: string;
  /** The Service Credential's bearer token. */
  credential: string;
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
   * Injectable for tests; defaults to an undici-pool-backed fetch bound to
   * baseUrl, with `headersTimeoutMs`/`bodyTimeoutMs`/`connectTimeoutMs`
   * (10s each by default) — closing the gap the bare global `fetch` left
   * (no per-request timeout at all) for this long-lived polling client.
   */
  fetchImpl?: typeof fetch;
  /** Only used when `fetchImpl` is not supplied — see `fetchImpl`'s own doc. */
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
  connectTimeoutMs?: number;
  /**
   * Deadline applied to every GET /v1/config request via
   * `AbortSignal.timeout`, in addition to (not instead of)
   * `headersTimeoutMs`/`bodyTimeoutMs`/`connectTimeoutMs`. Unlike those,
   * which only bound this class's own pooled fetch, this applies
   * regardless of which `fetchImpl` is in use — per sdk-conformance's "A
   * transport is injected" scenario, an integrator-supplied transport
   * gets this library's own deadline too, not only whatever (if
   * anything) that transport enforces on its own. Default 10s.
   */
  requestTimeoutMs?: number;
  /** Called after each successful refresh, with the new Configuration Version. */
  onConfigRefreshed?: (version: number) => void;
  /** Called after each failed or invalid refresh attempt. */
  onConfigRefreshError?: (error: unknown) => void;
  /**
   * When true, GET /v1/config/stream is never attempted at all (task 5.8)
   * — not merely ignored if it would connect. The client relies solely on
   * polling, identical to this class's behavior before streaming existed.
   * Streaming is attempted by default.
   */
  streamingDisabled?: boolean;
}

/**
 * Fetches, caches and background-refreshes a Credential-scoped
 * Configuration from `GET /v1/config`, per design.md decision 4:
 * construction does not fetch; `start()` begins polling and returns a
 * Promise resolving on the first successful fetch (an integrator that
 * doesn't want to block on it can call `start()` without awaiting, and let
 * `evaluate` use a fallback until the first fetch lands). A failed or
 * invalid poll leaves the previously cached Configuration untouched and
 * retries with capped exponential backoff; a successfully cached
 * Configuration keeps serving indefinitely once fetched at least once,
 * regardless of subsequent poll failures (`feature-evaluation`'s "Failure
 * Isolation").
 */
export class ConfigurationClient {
  private readonly baseUrl: string;
  private readonly credential: string;
  /** Undefined unless the integrator explicitly configured it — see currentRefreshIntervalMs's own doc comment for the resolution order. */
  private readonly explicitRefreshIntervalMs: number | undefined;
  private readonly maxConfigAgeMs: number | undefined;
  private readonly fetchImpl: typeof fetch;
  /** Only set when this instance created its own pooled fetch — never closes a caller-supplied fetchImpl it doesn't own. */
  private readonly ownedPooledFetch: PooledFetch | undefined;
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

  // --- Streaming (add-configuration-streaming section 7) ---
  private readonly streamingDisabled: boolean;
  private streamStarted = false;
  private streamRunning = false;
  private streamConnected = false;
  /** Valid only while streamConnected is true; currentRefreshIntervalMs never reads it otherwise. */
  private streamPollIntervalMs: number | undefined;
  /**
   * The highest Configuration Version this client has ever been notified
   * about via a `version` event. Guards considerVersionNotification
   * against an out-of-order or duplicate notification (task 5.6): a
   * lower/equal version is always a no-op. JS is single-threaded, so
   * unlike go-sdk's atomic CAS loop, a plain compare-then-assign is
   * sufficient — nothing can interleave between the check and the write.
   */
  private streamHighestNotified = 0;
  private streamLastFrameAt = 0;
  private streamAbortController: AbortController | undefined;
  private streamReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private streamSleepResolve: (() => void) | undefined;

  constructor(options: ConfigurationClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.credential = options.credential;
    this.explicitRefreshIntervalMs = options.refreshIntervalMs;
    this.maxConfigAgeMs = options.maxConfigAgeMs;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.streamingDisabled = options.streamingDisabled ?? false;

    if (options.fetchImpl) {
      this.fetchImpl = options.fetchImpl;
      this.ownedPooledFetch = undefined;
    } else {
      const pooled = createPooledFetch(this.baseUrl, {
        headersTimeoutMs: options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
        bodyTimeoutMs: options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS,
        connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      });
      this.fetchImpl = pooled;
      this.ownedPooledFetch = pooled;
    }

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
    // rejection; harden-sdk-runtime task 3 covers integrator-callback
    // isolation generally, but this specific case is this class's own
    // responsibility since readyPromise is constructed here.
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
      // Deliberately NOT unref'd, unlike this class's other internal
      // timers (the poll/retry timer): a caller's primary task is almost
      // always `await client.start()` itself, so this timer is the one
      // thing standing between an unreachable platform and the whole
      // process exiting silently (code 0) with start()'s Promise left
      // forever unsettled — found running go-sdk's sibling fix's test
      // scenario against a real deployment for harden-sdk-runtime task
      // 11.2 and confirming the same class of gap existed here too.
      this.runPollLoop();
    } else if (!this.looping && !this.terminallyFailed) {
      // Resuming after stop(): no attempt is currently in flight (if one
      // were, it will itself pick the resumed `stopped = false` state back
      // up once it settles, per pollLoop's own check), and no timer is
      // pending either (stop() cleared it) — kick the loop immediately
      // rather than waiting for a timer that no longer exists.
      this.runPollLoop();
    }

    if (!this.streamingDisabled) {
      if (!this.streamStarted) {
        this.streamStarted = true;
        this.runStreamLoop();
      } else if (!this.streamRunning) {
        // Resuming after stop(), mirroring the poll loop's own restart
        // logic immediately above.
        this.runStreamLoop();
      }
    }

    return this.readyPromise;
  }

  /**
   * Starts streamLoop() without awaiting it (task 5.1: readiness never
   * depends on this succeeding — it runs purely alongside pollLoop, for
   * the client's whole lifetime), with a terminal `.catch()` mirroring
   * runPollLoop's own backstop against an unhandled rejection.
   */
  private runStreamLoop(): void {
    this.streamRunning = true;

    this.streamLoop()
      .catch((error: unknown) => {
        safeInvoke(this.onConfigRefreshError, error);
      })
      .finally(() => {
        this.streamRunning = false;
      });
  }

  /**
   * Starts `pollLoop()` without awaiting it (it runs for the client's
   * whole lifetime), with a terminal `.catch()` — sdk-conformance's "A
   * background loop rejects" scenario: `pollLoop`/`attemptFetch` should
   * never actually reject (every path is already contained), but an
   * unawaited async call with no handler at all becomes an unhandled
   * rejection, which by default terminates a Node process, if a future
   * change ever reintroduces one. This is the backstop for that class of
   * regression, not an expected path.
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

  /** Stops polling and streaming. Safe to call whether or not `start()` was ever called. */
  stop(): void {
    this.stopped = true;
    this.clearInitTimer();

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    // Unblocks a currently-connected GET /v1/config/stream request (its
    // reader.read() rejects with an AbortError, which streamConnectOnce
    // treats like any other ended connection) and a currently-pending
    // reconnect backoff sleep, so streamLoop observes `this.stopped` and
    // exits promptly instead of outliving stop() by up to
    // STREAM_MAX_BACKOFF_MS.
    this.streamAbortController?.abort();

    if (this.streamReconnectTimer !== undefined) {
      clearTimeout(this.streamReconnectTimer);
      this.streamReconnectTimer = undefined;
    }

    this.streamSleepResolve?.();
    this.streamSleepResolve = undefined;
  }

  /**
   * Releases the underlying undici connection pool, if this instance
   * created its own (i.e. no `fetchImpl` was supplied). A no-op when a
   * caller-supplied `fetchImpl` is in use — its lifecycle belongs to
   * whoever constructed it, not this client. Does not call `stop()`
   * itself; callers that want both should call `stop()` then `close()`.
   */
  async close(): Promise<void> {
    await this.ownedPooledFetch?.close();
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

  /** add-configuration-streaming task 5.7's diagnostic path. Safe to call at any time, including before start(). */
  transport(): TransportInfo {
    return { streaming: this.streamConnected };
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
    this.timer.unref?.();
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

    // While a streaming connection is live, the reduced poll interval its
    // own hello event disclosed wins (task 5.4) — the platform advises a
    // shorter floor specifically because a connected client already has a
    // faster primary signal and only needs polling as a safety net
    // (design.md's "Polling continues while connected, at a reduced
    // interval" decision).
    if (this.streamConnected && this.streamPollIntervalMs !== undefined) {
      return this.streamPollIntervalMs;
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
          Authorization: `Bearer ${this.credential}`,
          // Declares this client's own configuration format capability
          // (expand-targeting-model task 3.1), so the platform can mark
          // any flag using a construct newer than this client understands
          // as non-evaluable rather than serving a representation this
          // client would silently mis-evaluate. See evaluate.ts's
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

  // --- Streaming (add-configuration-streaming section 7) ---

  /**
   * Runs for the lifetime of one start()/stop() cycle: repeatedly
   * connects to GET /v1/config/stream and falls back to a randomized
   * backoff between attempts (task 5.3). Never touches readyResolve/
   * readyReject: readiness resolves entirely from the poll loop's own
   * first successful fetch (task 5.1) — this loop is purely additive.
   */
  private async streamLoop(): Promise<void> {
    let backoffMs = STREAM_BASE_BACKOFF_MS;

    while (!this.stopped) {
      try {
        await this.streamConnectOnce();
      } catch (error) {
        safeInvoke(this.onConfigRefreshError, error);
      }

      this.streamConnected = false;
      this.streamPollIntervalMs = undefined;

      if (this.stopped) {
        return;
      }

      await this.streamSleep(withJitter(backoffMs));
      backoffMs = Math.min(backoffMs * 2, STREAM_MAX_BACKOFF_MS);
    }
  }

  /** An interruptible sleep: stop() resolves it immediately via streamSleepResolve, so streamLoop never outlives stop() by up to a full backoff. */
  private streamSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.streamSleepResolve = resolve;

      this.streamReconnectTimer = setTimeout(() => {
        this.streamReconnectTimer = undefined;
        this.streamSleepResolve = undefined;
        resolve();
      }, ms);
      this.streamReconnectTimer.unref?.();
    });
  }

  /**
   * Opens one GET /v1/config/stream connection, reads its hello
   * handshake, then reads frames until the connection ends (cleanly, via
   * stop(), or because it went silently stale — task 5.3) or fails
   * outright. Every failure path (refused, non-2xx, malformed hello, a
   * connection that later breaks) is reported through onConfigRefreshError
   * by the caller (streamLoop) and otherwise treated identically: fall
   * back to polling and retry later with backoff (task 5.2) — this
   * platform's documented refusals (429 streaming_credential_limit_
   * exceeded, 503 streaming_capacity_exceeded) carry no special handling
   * beyond that, since polling remaining unaffected is the entire point.
   */
  private async streamConnectOnce(): Promise<void> {
    const controller = new AbortController();
    this.streamAbortController = controller;

    const trace = await resolveTraceHeaders();
    const headers = applyTraceHeaders(
      {
        Authorization: `Bearer ${this.credential}`,
        Accept: "text/event-stream",
      },
      trace,
    );

    const response = await this.fetchImpl(`${this.baseUrl}/v1/config/stream`, {
      headers,
      signal: controller.signal,
    });

    if (response.status !== 200) {
      await response.body
        ?.cancel()
        .catch(() => undefined);

      throw new Error(`configuration stream: status ${response.status}`);
    }

    if (!response.body) {
      throw new Error("configuration stream: response had no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser();

    let watchdog: ReturnType<typeof setInterval> | undefined;

    try {
      const hello = await this.readHello(reader, decoder, parser, controller);

      const heartbeatIntervalMs =
        (hello.heartbeat_interval_seconds && hello.heartbeat_interval_seconds > 0
          ? hello.heartbeat_interval_seconds
          : DEFAULT_HEARTBEAT_SECONDS) * 1000;

      this.streamPollIntervalMs =
        hello.poll_interval_seconds !== undefined && hello.poll_interval_seconds > 0
          ? hello.poll_interval_seconds * 1000
          : undefined;
      this.streamConnected = true;
      this.streamLastFrameAt = Date.now();

      // pollLoop may already be sleeping out a wait it computed BEFORE
      // this connection existed (the platform's own longer advised
      // interval, or the hardcoded default) — wake it so it recomputes
      // immediately using the now-known reduced interval, rather than
      // sleeping out a stale, longer one (task 5.4). The resulting fetch
      // is a cheap revalidation (a 304 in the common case) if nothing
      // actually changed.
      this.wakePollLoop();

      const threshold = heartbeatIntervalMs * MISSED_HEARTBEAT_MULTIPLIER;

      watchdog = setInterval(() => {
        if (Date.now() - this.streamLastFrameAt > threshold) {
          controller.abort();
        }
      }, heartbeatIntervalMs);
      watchdog.unref?.();

      for (;;) {
        const { value, done } = await reader.read();

        if (done) {
          return;
        }

        const events = parser.push(decoder.decode(value, { stream: true }));

        for (const event of events) {
          this.streamLastFrameAt = Date.now();

          if (event.type === "comment") {
            // The heartbeat itself: no payload to act on beyond having
            // already reset streamLastFrameAt above.
            continue;
          }

          if (event.event !== "version") {
            continue;
          }

          const version = Number(event.data.trim());

          if (Number.isFinite(version)) {
            this.considerVersionNotification(version);
          }
        }
      }
    } finally {
      if (watchdog !== undefined) {
        clearInterval(watchdog);
      }

      await reader.cancel().catch(() => undefined);
    }
  }

  /** Reads frames until the hello event arrives, bounded by STREAM_SETUP_TIMEOUT_MS — the unbounded read loop that follows is watched instead by the heartbeat-driven watchdog, never this timer. */
  private async readHello(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    parser: SSEParser,
    controller: AbortController,
  ): Promise<StreamHelloEvent> {
    const setupTimer = setTimeout(() => controller.abort(), STREAM_SETUP_TIMEOUT_MS);
    setupTimer.unref?.();

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done) {
          throw new Error("configuration stream: connection closed before hello");
        }

        const events = parser.push(decoder.decode(value, { stream: true }));

        for (const event of events) {
          if (event.type === "comment" || event.event !== "hello") {
            continue;
          }

          return JSON.parse(event.data) as StreamHelloEvent;
        }
      }
    } finally {
      clearTimeout(setupTimer);
    }
  }

  /**
   * Records version as the highest one this client has ever been
   * notified about, and — only when it is genuinely newer than both that
   * record and the Configuration currently cached — wakes the poll loop
   * to fetch immediately instead of waiting for its next scheduled tick.
   *
   * The compare-then-assign against streamHighestNotified makes an
   * out-of-order or duplicate notification a no-op (task 5.6: a
   * `version: 5` arriving after `version: 7` was already acted on never
   * regresses anything), and the separate check against the actually-
   * cached Configuration's own version makes an already-held version a
   * no-op even on a client's very first notification (task 5.5).
   */
  private considerVersionNotification(version: number): void {
    if (version <= this.streamHighestNotified) {
      return;
    }

    this.streamHighestNotified = version;

    if (this.config !== undefined && version <= this.config.version) {
      return;
    }

    this.wakePollLoop();
  }

  /** Cancels a pending poll timer and runs the loop immediately. A no-op if no timer is pending (a fetch is already in flight, or the loop hasn't started yet) — that in-flight fetch, or the next natural cycle, will observe current server state on its own. */
  private wakePollLoop(): void {
    if (this.timer === undefined) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = undefined;
    this.runPollLoop();
  }
}

/**
 * A lightweight structural check — not full schema validation — sufficient
 * to reject a garbled or unexpectedly-shaped response before it ever
 * replaces a good cache, per this file's own "validated ... before being
 * accepted" contract. Validates every element within variations/rules,
 * not only that the containers are arrays (task 5.1): a malformed
 * element (e.g. a null entry, or a Variation with no `key`) previously
 * passed this check and could crash `evaluateFlag` later, at evaluation
 * time, rather than being rejected here at fetch time.
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
