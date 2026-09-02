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
});
