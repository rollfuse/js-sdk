import type { ExposureEventSubmission } from "@rollfuse/contracts";
import { applyTraceHeaders, resolveTraceHeaders } from "@rollfuse/evaluation-core";

import { safeInvoke } from "./safe-invoke.js";

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
/**
 * Deadline applied to every flush request via AbortSignal.timeout,
 * regardless of which fetchImpl is in use. A hung flush is abandoned
 * once this elapses rather than blocking subsequent flushes.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/**
 * Default width of the window an observation identity (flag, subject,
 * served variation, configuration version) is reported once within — see
 * dedupeWindowMs's own doc comment.
 */
const DEFAULT_DEDUPE_WINDOW_MS = 60_000;
/** None of an identity's fields can validly contain a NUL byte, so unlike a space or comma this can never collide two distinct identities into the same key. */
const DEDUPE_KEY_SEPARATOR = String.fromCharCode(0);
/**
 * The platform's declared maximum for SubmitExposureEventsRequest.events
 * (apps/api/openapi/openapi.yaml's ExposureEventSubmission maxItems) — see
 * flush()'s own doc comment for why exceeding it here would be a real
 * failure mode, not just a style preference.
 */
const PLATFORM_MAX_EXPOSURE_BATCH_SIZE = 100;

export interface ExposureQueueOptions {
  baseUrl: string;
  publicCredential: string;
  capacity?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  /** Injectable for tests; defaults to the browser's global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Deadline applied to every flush request via `AbortSignal.timeout`,
   * regardless of which `fetchImpl` is in use, including one the
   * integrator injected. Default 10s.
   */
  requestTimeoutMs?: number;
  /**
   * Width of the window an observation identity (flag, subject, served
   * variation, configuration version) is reported once within, per
   * design.md's "Deduplication is by observation identity" decision and
   * sdk-conformance's "Exposure Is Reported Once Per Distinct
   * Observation" requirement. A repeated evaluation with the same
   * identity inside the window is not re-enqueued; once the window
   * elapses since the identity was last reported, the next matching
   * evaluation is treated as a new observation. A changed variation or
   * configuration version is always a different identity, regardless of
   * timing. This is also what makes the React Provider's snapshot
   * rebuilds stop re-enqueueing on every re-render: `RollfusePublicClient
   * .evaluate`/`evaluateAll` route through this same queue, so a
   * rebuild that reaches the same identity again within the window is
   * deduplicated identically. Default 60s.
   */
  dedupeWindowMs?: number;
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
 *
 * Deduplicates by observation identity within a bounded window (task
 * 7.1), and guards against issuing more than one flush request at a time
 * (task 7.6) — see dedupeWindowMs and runFlush's own doc comments.
 */
export class ExposureQueue {
  private readonly baseUrl: string;
  private readonly publicCredential: string;
  private readonly capacity: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly dedupeWindowMs: number;
  private readonly onExposureDropped: ((count: number) => void) | undefined;
  private readonly onExposureSubmitError: ((error: unknown) => void) | undefined;

  private queue: ExposureEventSubmission[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Last time (epoch ms) each observation identity was actually enqueued.
   * Swept on every flush tick so an identity that stops recurring doesn't
   * pin memory forever — see pruneDedupeWindow.
   */
  private readonly lastReportedAt = new Map<string, number>();
  /**
   * Capacity drops accumulated since the last flush tick, reported as one
   * aggregated `onExposureDropped(count)` call per tick rather than once
   * per dropped event — sdk-conformance's "Sustained high-volume
   * evaluation" scenario requires drops to be counted and reported, but
   * calling an integrator callback once per event under a drop storm is
   * itself a destabilization risk, the same concern `safeInvoke` guards
   * against, just at the call-frequency level instead of per-call safety.
   */
  private droppedSinceLastReport = 0;
  /**
   * True while a flush's own submission (the fetchImpl call) is in
   * flight. Guards against a queue above batchSize issuing more than one
   * concurrent request (task 7.6): the periodic timer and enqueue's own
   * batchSize trigger can otherwise both call runFlush while an earlier
   * flush's network request hasn't resolved yet.
   */
  private flushing = false;

  constructor(options: ExposureQueueOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.publicCredential = options.publicCredential;
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    // See configuration-client.ts's identical fix and its full rationale:
    // must be `globalThis.fetch(...)` (member-call syntax), not a bare
    // `fetch` reference or even `(...args) => fetch(...args)` — both
    // break under OpenTelemetry's fetch instrumentation with a silent
    // "Illegal invocation" TypeError.
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));

    this.onExposureDropped = options.onExposureDropped;
    this.onExposureSubmitError = options.onExposureSubmitError;
  }

  /** Starts the periodic flush timer. Safe to call more than once. */
  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      this.runFlush();
    }, this.flushIntervalMs);
  }

  /**
   * Starts `flush()` without awaiting it, with a terminal `.catch()` —
   * sdk-conformance's "A background loop rejects" scenario. `flush()`
   * should never actually reject (its own try/catch already contains
   * every failure path), but an unawaited async call with no handler at
   * all becomes an unhandled rejection if a future change ever
   * reintroduces one; this is that backstop.
   *
   * Also sweeps expired dedupe entries and reports accumulated drops on
   * every call (task 7.1/7.5), and guards concurrent flush requests
   * (task 7.6): a flush already in flight is left alone rather than
   * starting a second concurrent request for whatever has accumulated
   * since. Once it settles, if the queue has climbed back to batchSize in
   * the meantime, immediately triggers another flush rather than waiting
   * out the rest of the timer interval.
   */
  private runFlush(): void {
    this.pruneDedupeWindow();
    this.reportAccumulatedDrops();

    if (this.flushing) {
      return;
    }

    this.flushing = true;

    this.flush()
      .catch((error: unknown) => {
        safeInvoke(this.onExposureSubmitError, error);
      })
      .finally(() => {
        this.flushing = false;

        if (this.queue.length >= this.batchSize) {
          this.runFlush();
        }
      });
  }

  private reportAccumulatedDrops(): void {
    if (this.droppedSinceLastReport === 0) {
      return;
    }

    const count = this.droppedSinceLastReport;
    this.droppedSinceLastReport = 0;

    safeInvoke(this.onExposureDropped, count);
  }

  /** Removes dedupe entries whose window has elapsed, bounding memory for identities that stop recurring. */
  private pruneDedupeWindow(): void {
    const now = Date.now();

    for (const [key, reportedAt] of this.lastReportedAt) {
      if (now - reportedAt >= this.dedupeWindowMs) {
        this.lastReportedAt.delete(key);
      }
    }
  }

  private dedupeKey(event: QueuedExposure): string {
    return [event.flagKey, event.subjectKey, event.variationKey, event.configVersion].join(DEDUPE_KEY_SEPARATOR);
  }

  /** Stops the periodic flush timer without flushing. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Enqueues one exposure for later submission. Never blocks.
   *
   * Deduplicated by observation identity (flag, subject, served
   * variation, configuration version) within `dedupeWindowMs` (task 7.1):
   * a repeat within the window is silently skipped rather than enqueued
   * again, matching sdk-conformance's "The same evaluation repeats"
   * scenario — including the React Provider's snapshot rebuilds, since
   * `RollfusePublicClient.evaluate`/`evaluateAll` both route through this
   * queue. A changed variation or configuration version is always a
   * different identity (task 7.2), so it is never skipped regardless of
   * timing.
   *
   * A full queue drops the new event; drops are accumulated and reported
   * in aggregate via `onExposureDropped` on the next flush tick (task
   * 7.5) rather than growing the queue unbounded or blocking the caller.
   */
  enqueue(event: QueuedExposure): void {
    const key = this.dedupeKey(event);
    const lastReportedAt = this.lastReportedAt.get(key);
    const now = Date.now();

    if (lastReportedAt !== undefined && now - lastReportedAt < this.dedupeWindowMs) {
      return;
    }

    if (this.queue.length >= this.capacity) {
      this.droppedSinceLastReport += 1;

      return;
    }

    this.lastReportedAt.set(key, now);

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
      this.runFlush();
    }
  }

  /**
   * Submits every currently queued event, chunked to the platform's
   * declared batch limit (task 9.4): `batchSize` can be configured above
   * that limit, and even at the default, a queue whose flush was delayed
   * (task 7.6's concurrent-flush guard) can accumulate more than one
   * batch's worth before it runs — POSTing all of it in one oversized
   * request would be rejected outright (400 `exposure_submission_batch_
   * too_large`) rather than partially accepted. Each chunk is submitted
   * as its own request, sequentially; one chunk failing doesn't stop the
   * others — each is dropped independently rather than retried or
   * re-queued: retrying risks unbounded queue growth under sustained
   * platform unavailability, and exposure recording is already
   * best-effort server-side.
   *
   * `keepalive` (task 8.1) requests a transport that survives page
   * dismissal: the browser guarantees a `fetch` with `keepalive: true`
   * is sent even if the document that initiated it is gone by the time
   * it would otherwise complete. `navigator.sendBeacon` is the more
   * commonly reached-for API for this, but it cannot set the
   * `Authorization` header this endpoint requires — `keepalive` can,
   * since it is a plain `fetch` option, not a different API.
   */
  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue;
    this.queue = [];

    for (const batchChunk of toChunks(batch, PLATFORM_MAX_EXPOSURE_BATCH_SIZE)) {
      await this.submitChunk(batchChunk, options);
    }
  }

  private async submitChunk(chunk: ExposureEventSubmission[], options: { keepalive?: boolean }): Promise<void> {
    try {
      const trace = await resolveTraceHeaders();
      const headers = applyTraceHeaders(
        { Authorization: `Bearer ${this.publicCredential}`, "Content-Type": "application/json" },
        trace,
      );
      const response = await this.fetchImpl(`${this.baseUrl}/v1/exposure-events`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        body: JSON.stringify({ events: chunk }),
        keepalive: options.keepalive,
      });

      if (!response.ok) {
        throw new Error(`POST /v1/exposure-events returned status ${response.status}`);
      }
    } catch (error) {
      safeInvoke(this.onExposureSubmitError, error);
    }
  }

  /** Stops the flush timer, reports any drops still pending, and submits any remaining queued events. */
  async close(): Promise<void> {
    this.stop();
    this.reportAccumulatedDrops();
    await this.flush();
  }
}

/** Splits items into consecutive groups of at most size each, preserving order (task 9.4). */
function toChunks<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}
