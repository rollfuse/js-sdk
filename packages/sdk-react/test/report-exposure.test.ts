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
});
