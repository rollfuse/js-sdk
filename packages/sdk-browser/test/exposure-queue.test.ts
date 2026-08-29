import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

    expect(onExposureDropped).toHaveBeenCalledWith(1);

    await queue.flush();

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(1);
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
});
