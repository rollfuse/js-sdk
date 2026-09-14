import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTraceHeaders } from "@rollfuse/evaluation-core";
import { ExposureQueue } from "../src/exposure-queue.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const sampleEvent = {
  flagKey: "checkout-redesign",
  subjectKey: "user_1",
  variationKey: "on",
  reason: "rule_match",
  configVersion: 3,
};

beforeAll(async () => {
  // `resolveTraceHeaders` does a dynamic `import("@opentelemetry/api")` on
  // its first call, cached module-wide afterwards (trace-context.ts's
  // `otelApiPromise`). That first lookup runs real, unmocked async I/O;
  // warm it here under real timers so the fake-timer-driven tests below
  // never race an in-flight module resolution against
  // `advanceTimersByTimeAsync`'s bounded real-tick budget.
  await resolveTraceHeaders();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ExposureQueue", () => {
  it("flushes on the periodic timer even below the batch-size trigger", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));

    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      credential: "cred",
      batchSize: 1_000,
      flushIntervalMs: 5_000,
      fetchImpl,
    });

    queue.start();
    queue.enqueue(sampleEvent);

    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    queue.stop();
  });

  it("each generated ExposureEvent gets its own correlation id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 2 }));

    const queue = new ExposureQueue({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

    queue.enqueue(sampleEvent);
    queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });

    await queue.flush();

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(2);
    expect(body.events[0].correlation_id).not.toBe(body.events[1].correlation_id);
  });

  it("attaches one traceparent header per flush request, covering the whole batch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 2 }));
    const queue = new ExposureQueue({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

    queue.enqueue(sampleEvent);
    queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });
    await queue.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];

    expect(init.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it("gives two independent flushes their own traceparent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));
    const queue = new ExposureQueue({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

    queue.enqueue(sampleEvent);
    await queue.flush();
    queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });
    await queue.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [, firstInit] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    const [, secondInit] = fetchImpl.mock.calls[1] as [string, { headers: Record<string, string> }];

    expect(firstInit.headers.traceparent).not.toBe(secondInit.headers.traceparent);
  });

  it("close() flushes remaining events and stops the timer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));

    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      credential: "cred",
      flushIntervalMs: 5_000,
      fetchImpl,
    });

    queue.start();
    queue.enqueue(sampleEvent);

    await queue.close();

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const callsAtClose = fetchImpl.mock.calls.length;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl.mock.calls.length).toBe(callsAtClose);
  });

  it("flush() is a no-op when the queue is empty", async () => {
    const fetchImpl = vi.fn();
    const queue = new ExposureQueue({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

    await queue.flush();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a throwing onExposureDropped does not propagate out of enqueue() (task 3.1)", () => {
    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      credential: "cred",
      capacity: 1,
      onExposureDropped: () => {
        throw new Error("integrator's dropped-exposure callback itself throws");
      },
    });

    queue.enqueue(sampleEvent);

    // The queue is now at capacity; this second enqueue() triggers the
    // drop path and its (throwing) callback, synchronously, in the same
    // call frame evaluate() would be in — this must not throw back into
    // evaluate()'s own caller.
    expect(() => queue.enqueue(sampleEvent)).not.toThrow();
  });

  it("a throwing onExposureSubmitError does not produce an unhandled rejection from the background flush timer (task 3.1, 3.3)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);

    process.on("unhandledRejection", onUnhandled);

    try {
      const queue = new ExposureQueue({
        baseUrl: "http://api.test",
        credential: "cred",
        flushIntervalMs: 5_000,
        fetchImpl,
        onExposureSubmitError: () => {
          throw new Error("integrator's submit-error callback itself throws");
        },
      });

      queue.start();
      queue.enqueue(sampleEvent);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(unhandledRejections).toEqual([]);

      queue.stop();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a hung flush is abandoned by its deadline and does not block subsequent flushes (task 4.3)", async () => {
    // AbortSignal.timeout's internal timer is not hooked by vitest's fake
    // timers (see configuration-client.test.ts's identical case), so
    // this runs under real time. Manually verified: removing the signal
    // from the flush fetchImpl call made this test itself fail (the
    // first flush's promise never settled); restored before committing.
    vi.useRealTimers();

    try {
      let hungRequestCount = 0;
      const fetchImpl: typeof fetch = vi.fn((_url, init) => {
        hungRequestCount++;

        return new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit).signal;

          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      });

      const onExposureSubmitError = vi.fn();

      const queue = new ExposureQueue({
        baseUrl: "http://api.test",
        credential: "cred",
        requestTimeoutMs: 50,
        fetchImpl,
        onExposureSubmitError,
      });

      queue.enqueue(sampleEvent);
      await queue.flush();

      expect(onExposureSubmitError).toHaveBeenCalledTimes(1);
      expect(hungRequestCount).toBe(1);

      // A second flush, after the first was abandoned, is not itself
      // blocked by it.
      queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });
      await queue.flush();

      expect(hungRequestCount).toBe(2);
    } finally {
      vi.useFakeTimers();
    }
  });

  // Manually verified each of the following mechanisms is load-bearing:
  // (1) removing the dedupe check in enqueue() made the "repeated
  // identical evaluations" test below submit 3 events instead of 1; (2)
  // reverting droppedSinceLastReport back to a synchronous
  // safeInvoke(onExposureDropped, 1) per drop made the "aggregated" test
  // observe 5 separate calls instead of one call with 5; (3) removing the
  // `flushing` guard in runFlush made the "one flush request at a time"
  // test observe 2 concurrent requests instead of 1. Restored before
  // committing in every case.
  it("repeated identical evaluations within the dedupe window produce one exposure (task 7.1)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));
    const queue = new ExposureQueue({ baseUrl: "http://api.test", credential: "cred", fetchImpl, dedupeWindowMs: 60_000 });

    queue.enqueue(sampleEvent);
    queue.enqueue(sampleEvent);
    queue.enqueue(sampleEvent);

    await queue.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(1);
  });

  it("once the dedupe window elapses, the same identity is reported again (task 7.1)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));
    const queue = new ExposureQueue({ baseUrl: "http://api.test", credential: "cred", fetchImpl, dedupeWindowMs: 1_000 });

    queue.enqueue(sampleEvent);
    await queue.flush();

    vi.setSystemTime(Date.now() + 1_000);

    queue.enqueue(sampleEvent);
    await queue.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
    expect(secondBody.events).toHaveLength(1);
  });

  it("a changed served variation is a new identity, even within the dedupe window (task 7.2)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 2 }));
    const queue = new ExposureQueue({ baseUrl: "http://api.test", credential: "cred", fetchImpl, dedupeWindowMs: 60_000 });

    queue.enqueue(sampleEvent);
    queue.enqueue({ ...sampleEvent, variationKey: "off" });

    await queue.flush();

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(2);
  });

  it("a changed configuration version is a new identity, even within the dedupe window (task 7.2)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 2 }));
    const queue = new ExposureQueue({ baseUrl: "http://api.test", credential: "cred", fetchImpl, dedupeWindowMs: 60_000 });

    queue.enqueue(sampleEvent);
    queue.enqueue({ ...sampleEvent, configVersion: sampleEvent.configVersion + 1 });

    await queue.flush();

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(2);
  });

  it("a different subject is a new identity, even within the dedupe window", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 2 }));
    const queue = new ExposureQueue({ baseUrl: "http://api.test", credential: "cred", fetchImpl, dedupeWindowMs: 60_000 });

    queue.enqueue(sampleEvent);
    queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });

    await queue.flush();

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(2);
  });

  it("capacity drops are aggregated into one onExposureDropped(count) call per flush tick rather than one per drop (task 7.5)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));
    const onExposureDropped = vi.fn();

    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      credential: "cred",
      capacity: 1,
      flushIntervalMs: 5_000,
      fetchImpl,
      onExposureDropped,
    });

    queue.start();

    // Fills the one-item capacity, then five more distinct identities
    // (distinct subjects, so dedupe never suppresses them) overflow it.
    queue.enqueue(sampleEvent);
    for (let i = 0; i < 5; i++) {
      queue.enqueue({ ...sampleEvent, subjectKey: `overflow_${i}` });
    }

    // Not yet reported: aggregation happens on the next flush tick, not
    // synchronously inside enqueue().
    expect(onExposureDropped).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(onExposureDropped).toHaveBeenCalledTimes(1);
    expect(onExposureDropped).toHaveBeenCalledWith(5);

    queue.stop();
  });

  it("a queue above batch size issues only one flush request at a time (task 7.6)", async () => {
    let resolveFirstRequest!: (response: Response) => void;
    const firstRequest = new Promise<Response>((resolve) => {
      resolveFirstRequest = resolve;
    });

    let requestCount = 0;
    const fetchImpl = vi.fn(() => {
      requestCount++;

      return requestCount === 1 ? firstRequest : Promise.resolve(jsonResponse({ accepted: 1 }));
    });

    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      credential: "cred",
      batchSize: 2,
      flushIntervalMs: 5_000,
      fetchImpl,
    });

    queue.start();

    // Reaches batchSize, triggering the first (still-pending) flush.
    queue.enqueue({ ...sampleEvent, subjectKey: "user_1" });
    queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });

    await vi.waitFor(() => expect(requestCount).toBe(1));

    // More distinct identities accumulate to batchSize again while the
    // first request is still in flight; the periodic timer would also
    // fire here in real usage. Neither should start a second concurrent
    // request while the first hasn't resolved.
    queue.enqueue({ ...sampleEvent, subjectKey: "user_3" });
    queue.enqueue({ ...sampleEvent, subjectKey: "user_4" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(requestCount).toBe(1);

    // Once the first request resolves, the queued backlog is flushed
    // next, as its own single request.
    resolveFirstRequest(jsonResponse({ accepted: 2 }));
    await vi.waitFor(() => expect(requestCount).toBe(2));

    queue.stop();
  });
});
