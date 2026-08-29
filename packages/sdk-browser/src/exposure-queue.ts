import type { ExposureEventSubmission } from "@rollfuse/contracts";

const DEFAULT_CAPACITY = 1_000;
/**
 * Smaller than `@rollfuse/sdk-js`'s server-side defaults (100/5000ms): a
 * browser tab's lifetime is typically much shorter than a long-lived
 * server process, so exposures should flush sooner rather than risk being
 * lost when the tab closes — an implementation tuning choice, not a
 * spec-level requirement (see design.md decision 4).
 */
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;

export interface ExposureQueueOptions {
  baseUrl: string;
  publicCredential: string;
  capacity?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  /** Injectable for tests; defaults to the browser's global `fetch`. */
  fetchImpl?: typeof fetch;
  onExposureDropped?: (count: number) => void;
  onExposureSubmitError?: (error: unknown) => void;
}

/** What `RollfusePublicClient.evaluate` supplies per rule-matched evaluation. */
export interface QueuedExposure {
  flagKey: string;
  subjectKey: string;
  variationKey: string;
  reason: string;
  configVersion: number;
}

/**
 * A bounded, in-memory, best-effort exposure-submission queue, mirroring
 * `@rollfuse/sdk-js`'s `ExposureQueue`: `enqueue` never blocks the
 * evaluation call that produced the event, a full queue drops the new
 * event rather than blocking or growing unbounded, and a failed batch
 * submission is dropped without retry rather than risking unbounded queue
 * growth under sustained platform unavailability.
 */
export class ExposureQueue {
  private readonly baseUrl: string;
  private readonly publicCredential: string;
  private readonly capacity: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onExposureDropped: ((count: number) => void) | undefined;
  private readonly onExposureSubmitError: ((error: unknown) => void) | undefined;

  private queue: ExposureEventSubmission[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ExposureQueueOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.publicCredential = options.publicCredential;
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;

    this.onExposureDropped = options.onExposureDropped;
    this.onExposureSubmitError = options.onExposureSubmitError;
  }

  /** Starts the periodic flush timer. Safe to call more than once. */
  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  /** Stops the periodic flush timer without flushing. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Enqueues one exposure for later submission. Never blocks: a full
   * queue drops the new event and reports it via `onExposureDropped`
   * rather than growing unbounded or blocking the caller.
   */
  enqueue(event: QueuedExposure): void {
    if (this.queue.length >= this.capacity) {
      this.onExposureDropped?.(1);

      return;
    }

    this.queue.push({
      flag_key: event.flagKey,
      subject_key: event.subjectKey,
      variation_key: event.variationKey,
      reason: event.reason,
      config_version: event.configVersion,
      correlation_id: crypto.randomUUID(),
      occurred_at: new Date().toISOString(),
    });

    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  /**
   * Submits every currently queued event in a single request. On failure,
   * the batch is dropped rather than retried or re-queued: retrying risks
   * unbounded queue growth under sustained platform unavailability, and
   * exposure recording is already best-effort server-side.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue;
    this.queue = [];

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/exposure-events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.publicCredential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: batch }),
      });

      if (!response.ok) {
        throw new Error(`POST /v1/exposure-events returned status ${response.status}`);
      }
    } catch (error) {
      this.onExposureSubmitError?.(error);
    }
  }

  /** Stops the flush timer and submits any remaining queued events. */
  async close(): Promise<void> {
    this.stop();
    await this.flush();
  }
}
