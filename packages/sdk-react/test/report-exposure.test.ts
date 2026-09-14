import { describe, expect, it, vi } from "vitest";
import { reportExposure } from "../src/report-exposure.js";

const payload = {
  flagKey: "checkout-redesign",
  subjectKey: "subject-1",
  variationKey: "treatment",
  reason: "rule_match",
  configVersion: 1,
};

describe("reportExposure", () => {
  it("POSTs the payload to the given endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await reportExposure("/api/rollfuse/exposure", payload, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/rollfuse/exposure",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  });

  it("attaches a valid traceparent header to the forwarded request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await reportExposure("/api/rollfuse/exposure", payload, { fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];

    expect(init.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it("does not throw and calls onError when the response is not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const onError = vi.fn();

    await expect(reportExposure("/api/rollfuse/exposure", payload, { fetchImpl, onError })).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not throw and calls onError when fetch itself rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const onError = vi.fn();

    await expect(reportExposure("/api/rollfuse/exposure", payload, { fetchImpl, onError })).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the request fails and no onError is given", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(reportExposure("/api/rollfuse/exposure", payload, { fetchImpl })).resolves.toBeUndefined();
  });

  it("defaults to a fetch that works when the global fetch is a `this`-sensitive wrapper (e.g. OpenTelemetry's instrumentation) (task 4.4)", async () => {
    // Matches @rollfuse/sdk-browser's ConfigurationClient/ExposureQueue's
    // identical fix and its own full rationale: some environments (e.g.
    // OpenTelemetry's fetch auto-instrumentation) replace `window.fetch`
    // with a wrapper that only works when invoked with `this ===
    // window`/globalThis. Before this fix, `options.fetchImpl ?? fetch`
    // called as a bare identifier broke silently under exactly this
    // instrumented environment — never surfaced beyond onError, which
    // callers may not have wired up. Manually verified: reverting to the
    // bare `options.fetchImpl ?? fetch` made this test fail with the
    // Illegal-invocation TypeError; reverted back before committing.
    const thisSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }

      return Promise.resolve({ ok: true, status: 200 });
    });
    vi.stubGlobal("fetch", thisSensitiveFetch);

    const onError = vi.fn();

    try {
      await reportExposure("/api/rollfuse/exposure", payload, { onError });

      expect(onError).not.toHaveBeenCalled();
      expect(thisSensitiveFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("applies a deadline via AbortSignal, even to an injected transport (task 4.4)", async () => {
    vi.useRealTimers();

    try {
      const hangingFetchImpl: typeof fetch = vi.fn((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit).signal;

          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      });

      const onError = vi.fn();

      await reportExposure("/api/rollfuse/exposure", payload, {
        fetchImpl: hangingFetchImpl,
        requestTimeoutMs: 50,
        onError,
      });

      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
