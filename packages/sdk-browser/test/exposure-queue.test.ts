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
      publicCredential: "pub_cred",
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

    const queue = new ExposureQueue({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

    queue.enqueue(sampleEvent);
    queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });

    await queue.flush();

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(2);
    expect(body.events[0].correlation_id).not.toBe(body.events[1].correlation_id);
    expect(body.events[0].occurred_at).toEqual(expect.any(String));
  });

  it("close() flushes remaining events and stops the timer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));

    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
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
    const queue = new ExposureQueue({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

    await queue.flush();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drops new events and reports them once the queue is at capacity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 0 }));
    const onExposureDropped = vi.fn();

    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      capacity: 1,
      fetchImpl,
      onExposureDropped,
    });

    queue.enqueue(sampleEvent);
    queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });

    // Drops are now aggregated and reported once per flush tick (task
    // 7.5), rather than synchronously inside enqueue() — reported when
    // the queue actually runs a flush cycle (close(), here, since this
    // queue was never start()ed).
    expect(onExposureDropped).not.toHaveBeenCalled();

    await queue.close();

    expect(onExposureDropped).toHaveBeenCalledWith(1);

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(1);
  });

  it("attaches one traceparent header per flush request, covering the whole batch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 2 }));
    const queue = new ExposureQueue({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

    queue.enqueue(sampleEvent);
    queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });
    await queue.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];

    expect(init.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it("gives two independent flushes their own traceparent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));
    const queue = new ExposureQueue({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

    queue.enqueue(sampleEvent);
    await queue.flush();
    queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });
    await queue.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [, firstInit] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    const [, secondInit] = fetchImpl.mock.calls[1] as [string, { headers: Record<string, string> }];

    expect(firstInit.headers.traceparent).not.toBe(secondInit.headers.traceparent);
  });

  it("generates a well-formed UUID correlation id via the Web Crypto API, not node:crypto", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));

    const queue = new ExposureQueue({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

    queue.enqueue(sampleEvent);
    await queue.flush();

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events[0].correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("defaults to a fetch that works when the global fetch is a `this`-sensitive wrapper (e.g. OpenTelemetry's instrumentation)", async () => {
    // See configuration-client.test.ts's identical case for the full
    // rationale — same bug, same fix, in this class's own fetchImpl default.
    const thisSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }

      return Promise.resolve(jsonResponse({ accepted: 1 }));
    });
    vi.stubGlobal("fetch", thisSensitiveFetch);

    const onExposureSubmitError = vi.fn();
    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      onExposureSubmitError,
    });

    queue.enqueue(sampleEvent);
    await queue.flush();

    expect(onExposureSubmitError).not.toHaveBeenCalled();
    expect(thisSensitiveFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("a throwing onExposureDropped does not propagate out of enqueue() (task 3.1)", () => {
    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      capacity: 1,
      onExposureDropped: () => {
        throw new Error("integrator's dropped-exposure callback itself throws");
      },
    });

    queue.enqueue(sampleEvent);

    expect(() => queue.enqueue(sampleEvent)).not.toThrow();
  });

  it("a throwing onExposureSubmitError does not stop the background flush timer from continuing on schedule (task 3.1, 3.3)", async () => {
    // See parity.test.ts's own note: this package's tests carry no
    // @types/node/`process`, so unlike @rollfuse/sdk-js's equivalent test
    // (which asserts directly via `process.on("unhandledRejection")`),
    // this proves the same property behaviorally — the flush timer keeps
    // firing on schedule despite the callback throwing on every attempt —
    // while relying on vitest's own run-level unhandled-rejection
    // detection (confirmed: it fails `npm test`'s exit code regardless of
    // per-test assertions) as the backstop against a real regression.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
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

    // A different subject: the same identity as the first enqueue would
    // now be deduplicated within the default window (task 7.1), which
    // isn't what this test is about.
    queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    queue.stop();
  });

  it("a hung flush is abandoned by its deadline and does not block subsequent flushes (task 4.3)", async () => {
    // See configuration-client.test.ts's identical case for why this
    // runs under real time. Manually verified: removing the signal from
    // the flush fetchImpl call made this test itself fail (the first
    // flush's promise never settled); restored before committing.
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
        publicCredential: "pub_cred",
        requestTimeoutMs: 50,
        fetchImpl,
        onExposureSubmitError,
      });

      queue.enqueue(sampleEvent);
      await queue.flush();

      expect(onExposureSubmitError).toHaveBeenCalledTimes(1);
      expect(hungRequestCount).toBe(1);

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
    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      fetchImpl,
      dedupeWindowMs: 60_000,
    });

    queue.enqueue(sampleEvent);
    queue.enqueue(sampleEvent);
    queue.enqueue(sampleEvent);

    await queue.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(1);
  });

  it("once the dedupe window elapses, the same identity is reported again (task 7.1) — this is also what lets the React Provider's periodic snapshot rebuilds keep reporting a long-lived session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));
    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      fetchImpl,
      dedupeWindowMs: 1_000,
    });

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
    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      fetchImpl,
      dedupeWindowMs: 60_000,
    });

    queue.enqueue(sampleEvent);
    queue.enqueue({ ...sampleEvent, variationKey: "off" });

    await queue.flush();

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(2);
  });

  it("a changed configuration version is a new identity, even within the dedupe window (task 7.2)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 2 }));
    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      fetchImpl,
      dedupeWindowMs: 60_000,
    });

    queue.enqueue(sampleEvent);
    queue.enqueue({ ...sampleEvent, configVersion: sampleEvent.configVersion + 1 });

    await queue.flush();

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(2);
  });

  it("capacity drops are aggregated into one onExposureDropped(count) call per flush tick rather than one per drop (task 7.5)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));
    const onExposureDropped = vi.fn();

    const queue = new ExposureQueue({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      capacity: 1,
      flushIntervalMs: 2_000,
      fetchImpl,
      onExposureDropped,
    });

    queue.start();

    queue.enqueue(sampleEvent);
    for (let i = 0; i < 5; i++) {
      queue.enqueue({ ...sampleEvent, subjectKey: `overflow_${i}` });
    }

    expect(onExposureDropped).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);

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
      publicCredential: "pub_cred",
      batchSize: 2,
      flushIntervalMs: 2_000,
      fetchImpl,
    });

    queue.start();

    queue.enqueue({ ...sampleEvent, subjectKey: "user_1" });
    queue.enqueue({ ...sampleEvent, subjectKey: "user_2" });

    await vi.waitFor(() => expect(requestCount).toBe(1));

    queue.enqueue({ ...sampleEvent, subjectKey: "user_3" });
    queue.enqueue({ ...sampleEvent, subjectKey: "user_4" });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(requestCount).toBe(1);

    resolveFirstRequest(jsonResponse({ accepted: 2 }));
    await vi.waitFor(() => expect(requestCount).toBe(2));

    queue.stop();
  });
});
