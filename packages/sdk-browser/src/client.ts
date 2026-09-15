import type { Configuration, EvaluationResult } from "@rollfuse/contracts";
import { evaluateFlag } from "@rollfuse/evaluation-core";
import { ConfigurationClient, type TransportInfo } from "./configuration-client.js";
import { ConfigNotReadyError, FlagNotEvaluableError, FlagNotFoundError, PublicCredentialRequiredError } from "./errors.js";
import { ExposureQueue } from "./exposure-queue.js";

/** Default bound on close() — see RollfusePublicClientOptions.closeTimeoutMs's own doc comment. */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

export interface RollfusePublicClientOptions {
  /** The platform API's base URL, e.g. "https://api.rollfuse.com". */
  baseUrl: string;
  /**
   * The bearer token of a Credential issued as Public (`config:read`
   * only) — see `service-credentials`' "Public Issuance Mode Restricted
   * To config:read". Named `publicCredential`, never `credential`, so
   * this option's shape never reads as accepting a regular Service
   * Credential: this package cannot verify server-side that a given
   * token is actually Public, so the guarantee is structural — see
   * `sdk-react`'s "Browser-Side Evaluation Never Uses A Non-Public
   * Credential" requirement. Never obtain this value from a regular
   * Service Credential; only from one issued with the Public option.
   */
  publicCredential: string;
  /** Interval between successful Configuration refreshes, in milliseconds. Default 30s. */
  refreshIntervalMs?: number;
  /**
   * If set, `evaluate`/`evaluateAll` treat the cached Configuration as
   * absent once it is older than this, falling back accordingly. Off by
   * default — see `ConfigurationClient`'s own doc comment.
   */
  maxConfigAgeMs?: number;
  /**
   * Bounds `start()`'s returned Promise: it rejects if no Configuration
   * fetch has succeeded within this many milliseconds — see
   * `ConfigurationClientOptions.initTimeoutMs`'s own doc comment. Default
   * 15s.
   */
  initTimeoutMs?: number;
  /**
   * Deadline applied to every Configuration fetch and exposure flush via
   * `AbortSignal.timeout`, regardless of which `fetchImpl` is in use —
   * see `ConfigurationClientOptions.requestTimeoutMs`'s own doc comment.
   * Default 10s.
   */
  requestTimeoutMs?: number;
  /**
   * Bounds `close()`: it returns once every pending exposure has flushed
   * or once this many milliseconds elapse, whichever comes first, per
   * sdk-conformance's "A server process shuts down" scenario. Default 5s.
   */
  closeTimeoutMs?: number;
  /** Maximum number of queued-but-unsubmitted ExposureEvents. Default 1000. */
  exposureQueueCapacity?: number;
  /** Queue length at which a submission batch is triggered early. Default 20. */
  exposureBatchSize?: number;
  /** Interval between periodic exposure-batch flushes, in milliseconds. Default 2s. */
  exposureFlushIntervalMs?: number;
  /** Injectable for tests; defaults to the browser's global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Called after each successful Configuration refresh, with the new version. */
  onConfigRefreshed?: (version: number) => void;
  /** Called after each failed or invalid Configuration refresh attempt. */
  onConfigRefreshError?: (error: unknown) => void;
  /** Called when one or more ExposureEvents are dropped due to a full queue. */
  onExposureDropped?: (count: number) => void;
  /** Called when a batch of ExposureEvents fails to submit. */
  onExposureSubmitError?: (error: unknown) => void;
  /** When true, GET /v1/config/stream is never attempted; the client relies solely on polling. Streaming is attempted by default. */
  streamingDisabled?: boolean;
}

export interface EvaluateOptions {
  attributes?: Record<string, string>;
  /**
   * Returned (never as a rule match, always `reason: "default_fallback"`)
   * when no Configuration is available yet.
   */
  fallback?: unknown;
}

export interface EvaluateAllOptions {
  attributes?: Record<string, string>;
}

/**
 * The platform's browser SDK entry point: fetches and caches a Public-
 * Credential-scoped Configuration, evaluates flags against it entirely
 * in-process (`evaluate`/`evaluateAll`, both synchronous, using the same
 * `@rollfuse/evaluation-core` algorithm `@rollfuse/sdk-js` uses), and
 * reports rule-matched exposures back to the platform asynchronously and
 * best-effort. Mirrors `@rollfuse/sdk-js`'s `RollfuseClient` contract —
 * see that package's docs for the shared behavioral guarantees — except
 * every option and constructor accepts only a Public Credential.
 */
export class RollfusePublicClient {
  private readonly configurationClient: ConfigurationClient;
  private readonly exposureQueue: ExposureQueue;
  private readonly configChangeListeners = new Set<() => void>();
  private readonly closeTimeoutMs: number;
  /**
   * Bound once so start()/close() can add and remove exactly the same
   * listener reference across a stop()/start() cycle (task 8.1: flush on
   * page dismissal or hidden, task 8.3: safe to restart).
   */
  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.flushOnDismissal();
    }
  };
  private readonly handlePageHide = (): void => {
    this.flushOnDismissal();
  };
  private dismissalListenersRegistered = false;

  constructor(options: RollfusePublicClientOptions) {
    if (!options.publicCredential) {
      throw new PublicCredentialRequiredError();
    }

    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;

    this.configurationClient = new ConfigurationClient({
      baseUrl: options.baseUrl,
      publicCredential: options.publicCredential,
      refreshIntervalMs: options.refreshIntervalMs,
      maxConfigAgeMs: options.maxConfigAgeMs,
      initTimeoutMs: options.initTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchImpl: options.fetchImpl,
      streamingDisabled: options.streamingDisabled,
      onConfigRefreshed: (version) => {
        options.onConfigRefreshed?.(version);
        this.notifyConfigChange();
      },
      onConfigRefreshError: options.onConfigRefreshError,
    });

    this.exposureQueue = new ExposureQueue({
      baseUrl: options.baseUrl,
      publicCredential: options.publicCredential,
      capacity: options.exposureQueueCapacity,
      batchSize: options.exposureBatchSize,
      flushIntervalMs: options.exposureFlushIntervalMs,
      fetchImpl: options.fetchImpl,
      requestTimeoutMs: options.requestTimeoutMs,
      onExposureDropped: options.onExposureDropped,
      onExposureSubmitError: options.onExposureSubmitError,
    });
  }

  /**
   * Begins background Configuration polling and exposure-batch flushing.
   * Returns a Promise resolving once the first Configuration fetch
   * succeeds; callers that don't want to block startup on it can call
   * `start()` without awaiting and rely on `evaluate`'s `fallback` option
   * until the first fetch lands.
   *
   * Also registers page-dismissal flush listeners (task 8.1), safe to
   * call again after `stop()` (task 8.3: `registerDismissalListeners`
   * guards against double-registration, and `ConfigurationClient.start`/
   * `ExposureQueue.start` are both themselves safe to call again after
   * their own `stop()`).
   */
  start(): Promise<void> {
    this.exposureQueue.start();
    this.registerDismissalListeners();

    return this.configurationClient.start();
  }

  /** Stops background polling and flushing without submitting queued exposures. */
  stop(): void {
    this.configurationClient.stop();
    this.exposureQueue.stop();
    this.unregisterDismissalListeners();
  }

  /**
   * Stops background work, releases every registered `subscribe`
   * listener (task 8.4), and submits any remaining queued exposures,
   * bounded by `closeTimeoutMs` (task 8.2): returns once flushed or once
   * the bound elapses, whichever comes first, rather than awaiting the
   * underlying flush's own network attempt unconditionally.
   */
  async close(): Promise<void> {
    this.configurationClient.stop();
    this.unregisterDismissalListeners();
    this.configChangeListeners.clear();

    await Promise.race([this.exposureQueue.close(), sleep(this.closeTimeoutMs)]);
  }

  /**
   * Registers the page-dismissal flush listeners (task 8.1): pending
   * exposures are flushed when the page becomes hidden (`visibilitychange`
   * firing with `document.visibilityState === "hidden"`, the recommended
   * signal for "the user is leaving," since `unload`/`beforeunload` are
   * unreliable, especially on mobile) or is literally torn down
   * (`pagehide`, covering back-forward-cache eviction `visibilitychange`
   * alone can miss). Guarded against `document`/`window` being absent
   * (a non-browser test or SSR environment) and against double
   * registration across a stop()/start() cycle.
   */
  private registerDismissalListeners(): void {
    if (this.dismissalListenersRegistered || typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("pagehide", this.handlePageHide);
    this.dismissalListenersRegistered = true;
  }

  private unregisterDismissalListeners(): void {
    if (!this.dismissalListenersRegistered) {
      return;
    }

    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("pagehide", this.handlePageHide);
    this.dismissalListenersRegistered = false;
  }

  /**
   * Flushes pending exposures using `keepalive: true` (task 8.1's "a
   * transport that survives page dismissal" — see `ExposureQueue.flush`'s
   * own doc comment for why `keepalive` rather than `sendBeacon`).
   * Deliberately not awaited by its caller (the dismissal event handlers):
   * the page may already be gone before the returned Promise would
   * settle, and `flush()` itself never throws (its own try/catch already
   * contains every failure path).
   */
  private flushOnDismissal(): void {
    void this.exposureQueue.flush({ keepalive: true });
  }

  /**
   * Subscribes to Configuration changes — invoked after each successful
   * background refresh that produces a new version, so a caller can
   * re-run `evaluate`/`evaluateAll` and react to the update. Returns an
   * unsubscribe function. Signature matches React's
   * `useSyncExternalStore(subscribe, getSnapshot)`, so
   * `@rollfuse/sdk-react`'s client-driven Provider mode can pass this
   * method directly as `subscribe`.
   */
  subscribe(listener: () => void): () => void {
    this.configChangeListeners.add(listener);

    return () => {
      this.configChangeListeners.delete(listener);
    };
  }

  /** add-configuration-streaming task 5.7's diagnostic path: which mechanism is currently delivering Configuration changes to this client. */
  transport(): TransportInfo {
    return this.configurationClient.transport();
  }

  private notifyConfigChange(): void {
    for (const listener of this.configChangeListeners) {
      listener();
    }
  }

  /**
   * Evaluates one flag for subjectKey, entirely in-process against the
   * cached Configuration. Synchronous — never performs a network request.
   */
  evaluate(subjectKey: string, flagKey: string, options: EvaluateOptions = {}): EvaluationResult {
    if (this.configurationClient.isStale()) {
      if (Object.hasOwn(options, "fallback")) {
        return fallbackResult(flagKey, options.fallback, this.configurationClient.getConfig()?.version ?? 0);
      }

      throw new ConfigNotReadyError(flagKey);
    }

    const config = this.configurationClient.getConfig();

    // Unreachable in practice (isStale() is false only once a
    // Configuration has been cached), narrows the type for what follows.
    if (!config) {
      throw new ConfigNotReadyError(flagKey);
    }

    const flag = config.flags.find((f: Configuration["flags"][number]) => f.flag_key === flagKey);

    if (!flag) {
      if (Object.hasOwn(options, "fallback")) {
        return fallbackResult(flagKey, options.fallback, config.version);
      }

      throw new FlagNotFoundError(flagKey);
    }

    if (flag.non_evaluable) {
      if (Object.hasOwn(options, "fallback")) {
        return fallbackResult(flagKey, options.fallback, config.version);
      }

      throw new FlagNotEvaluableError(flagKey);
    }

    const result = evaluateFlag(config.flags, flag, config.version, subjectKey, options.attributes ?? {});

    this.trackExposure(subjectKey, result);

    return result;
  }

  /**
   * Evaluates every flag in the cached Configuration for subjectKey.
   * Synchronous — never performs a network request. Throws
   * `ConfigNotReadyError` if no Configuration is available yet (there is
   * no per-flag fallback concept for "evaluate everything"). A flag the
   * platform marked `non_evaluable` (expand-targeting-model task 3.3) is
   * omitted entirely rather than guessed at.
   */
  evaluateAll(subjectKey: string, options: EvaluateAllOptions = {}): EvaluationResult[] {
    if (this.configurationClient.isStale()) {
      throw new ConfigNotReadyError();
    }

    const config = this.configurationClient.getConfig();

    if (!config) {
      throw new ConfigNotReadyError();
    }

    return config.flags
      .filter((flag: Configuration["flags"][number]) => !flag.non_evaluable)
      .map((flag: Configuration["flags"][number]) => {
        const result = evaluateFlag(config.flags, flag, config.version, subjectKey, options.attributes ?? {});

        this.trackExposure(subjectKey, result);

        return result;
      });
  }

  private trackExposure(subjectKey: string, result: EvaluationResult): void {
    if (!result.track_exposure) {
      return;
    }

    this.exposureQueue.enqueue({
      flagKey: result.flag_key,
      subjectKey,
      variationKey: result.variation_key,
      reason: result.reason,
      configVersion: result.config_version,
    });
  }
}

/** Resolves after ms — close()'s bound, raced against the underlying flush (task 8.2). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the result for an integrator-supplied fallback: never a rule
 * match, and never counted as an exposure (mirrors `evaluateFlag`'s own
 * default-path results).
 */
function fallbackResult(flagKey: string, value: unknown, configVersion: number): EvaluationResult {
  return {
    flag_key: flagKey,
    variation_key: "",
    value,
    reason: "default_fallback",
    config_version: configVersion,
    track_exposure: false,
  };
}
