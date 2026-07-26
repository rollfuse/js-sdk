import type { Configuration } from "@growth-ops/contracts";

/** Default interval between successful-poll refreshes. */
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
/** Starting delay before retrying a failed poll. */
const BASE_BACKOFF_MS = 1_000;
/** Upper bound on the capped-exponential retry backoff. */
const MAX_BACKOFF_MS = 30_000;

export interface ConfigurationClientOptions {
  /** The platform API's base URL, e.g. "https://api.growth-ops.example". */
  baseUrl: string;
  /** The Service Credential's bearer token. */
  credential: string;
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
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Called after each successful refresh, with the new Configuration Version. */
  onConfigRefreshed?: (version: number) => void;
  /** Called after each failed or invalid refresh attempt. */
  onConfigRefreshError?: (error: unknown) => void;
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
  private readonly refreshIntervalMs: number;
  private readonly maxConfigAgeMs: number | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onConfigRefreshed: ((version: number) => void) | undefined;
  private readonly onConfigRefreshError: ((error: unknown) => void) | undefined;

  private config: Configuration | undefined;
  private lastFetchedAt: number | undefined;
  private backoffMs = BASE_BACKOFF_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopped = false;
  private readyResolve!: () => void;
  private readonly readyPromise: Promise<void>;

  constructor(options: ConfigurationClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.credential = options.credential;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.maxConfigAgeMs = options.maxConfigAgeMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onConfigRefreshed = options.onConfigRefreshed;
    this.onConfigRefreshError = options.onConfigRefreshError;

    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /**
   * Begins polling. Returns a Promise resolving the first time a poll
   * succeeds (immediately, if one already has by the time this is
   * called). Safe to call more than once; only the first call starts the
   * polling loop.
   */
  start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      void this.pollLoop();
    }

    return this.readyPromise;
  }

  /** Stops polling. Safe to call whether or not `start()` was ever called. */
  stop(): void {
    this.stopped = true;

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
    const delay = succeeded ? this.refreshIntervalMs : this.nextBackoff();

    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.pollLoop();
    }, delay);
    this.timer.unref?.();
  }

  private nextBackoff(): number {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);

    return delay;
  }

  private async attemptFetch(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/config`, {
        headers: { Authorization: `Bearer ${this.credential}` },
      });

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
 * replaces a good cache, per this file's own "validated ... before being
 * accepted" contract.
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
