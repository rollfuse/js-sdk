import type { Configuration, EvaluationResult } from "@rollfuse/contracts";
import { evaluateFlag } from "@rollfuse/evaluation-core";
import { ConfigurationClient } from "./configuration-client.js";
import { ConfigNotReadyError, FlagNotFoundError, PublicCredentialRequiredError } from "./errors.js";
import { ExposureQueue } from "./exposure-queue.js";

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

  constructor(options: RollfusePublicClientOptions) {
    if (!options.publicCredential) {
      throw new PublicCredentialRequiredError();
    }

    this.configurationClient = new ConfigurationClient({
      baseUrl: options.baseUrl,
      publicCredential: options.publicCredential,
      refreshIntervalMs: options.refreshIntervalMs,
      maxConfigAgeMs: options.maxConfigAgeMs,
      fetchImpl: options.fetchImpl,
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
   */
  start(): Promise<void> {
    this.exposureQueue.start();

    return this.configurationClient.start();
  }

  /** Stops background polling and flushing without submitting queued exposures. */
  stop(): void {
    this.configurationClient.stop();
    this.exposureQueue.stop();
  }

  /** Stops background work and submits any remaining queued exposures. */
  async close(): Promise<void> {
    this.configurationClient.stop();
    await this.exposureQueue.close();
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

    const result = evaluateFlag(flag, config.version, subjectKey, options.attributes ?? {});

    this.trackExposure(subjectKey, result);

    return result;
  }

  /**
   * Evaluates every flag in the cached Configuration for subjectKey.
   * Synchronous — never performs a network request. Throws
   * `ConfigNotReadyError` if no Configuration is available yet (there is
   * no per-flag fallback concept for "evaluate everything").
   */
  evaluateAll(subjectKey: string, options: EvaluateAllOptions = {}): EvaluationResult[] {
    if (this.configurationClient.isStale()) {
      throw new ConfigNotReadyError();
    }

    const config = this.configurationClient.getConfig();

    if (!config) {
      throw new ConfigNotReadyError();
    }

    return config.flags.map((flag: Configuration["flags"][number]) => {
      const result = evaluateFlag(flag, config.version, subjectKey, options.attributes ?? {});

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
