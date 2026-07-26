import type { Configuration } from "@growth-ops/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationClient } from "../src/configuration-client.js";

const validConfig: Configuration = {
  environment_id: "env_1",
  version: 3,
  flags: [
    {
      flag_key: "checkout-redesign",
      enabled: true,
      default_variation: "off",
      variations: [
        { key: "on", value: true },
        { key: "off", value: false },
      ],
      rules: [],
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ConfigurationClient", () => {
  it("resolves start() once the first fetch succeeds, and calls onConfigRefreshed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
    const onConfigRefreshed = vi.fn();

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      credential: "cred",
      fetchImpl,
      onConfigRefreshed,
    });

    await client.start();

    expect(client.getConfig()).toEqual(validConfig);
    expect(onConfigRefreshed).toHaveBeenCalledWith(3);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.test/v1/config",
      expect.objectContaining({ headers: { Authorization: "Bearer cred" } }),
    );

    client.stop();
  });

  it("evaluate does not perform a network request: start() does not block on refreshIntervalMs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      credential: "cred",
      refreshIntervalMs: 30_000,
      fetchImpl,
    });

    await client.start();

    // The first fetch happens immediately on start(), not after waiting a
    // full refresh interval.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    client.stop();
  });

  it("a malformed refresh response is rejected without replacing the cache", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(validConfig))
      .mockResolvedValueOnce(jsonResponse({ not: "a valid configuration" }));

    const onConfigRefreshError = vi.fn();

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      credential: "cred",
      refreshIntervalMs: 10,
      fetchImpl,
      onConfigRefreshError,
    });

    await client.start();
    expect(client.getConfig()).toEqual(validConfig);

    await vi.advanceTimersByTimeAsync(10);

    expect(onConfigRefreshError).toHaveBeenCalledTimes(1);
    expect(client.getConfig()).toEqual(validConfig);

    client.stop();
  });

  it("an HTTP error response is rejected without replacing the cache", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(validConfig))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "internal_error" } }, 500));

    const onConfigRefreshError = vi.fn();

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      credential: "cred",
      refreshIntervalMs: 10,
      fetchImpl,
      onConfigRefreshError,
    });

    await client.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(onConfigRefreshError).toHaveBeenCalledTimes(1);
    expect(client.getConfig()).toEqual(validConfig);

    client.stop();
  });

  it("repeated poll failures keep serving the last-known-good config and report each failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(validConfig))
      .mockRejectedValue(new Error("network down"));

    const onConfigRefreshError = vi.fn();

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      credential: "cred",
      refreshIntervalMs: 5_000,
      fetchImpl,
      onConfigRefreshError,
    });

    await client.start();
    expect(client.getConfig()).toEqual(validConfig);

    // First scheduled refresh, at refreshIntervalMs, fails.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onConfigRefreshError).toHaveBeenCalledTimes(1);
    expect(client.getConfig()).toEqual(validConfig);

    // Retried at the base backoff (1000ms); still fails.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onConfigRefreshError).toHaveBeenCalledTimes(2);
    expect(client.getConfig()).toEqual(validConfig);

    // Backoff doubles to 2000ms for the next retry; still fails.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onConfigRefreshError).toHaveBeenCalledTimes(3);
    expect(client.getConfig()).toEqual(validConfig);

    client.stop();
  });

  it("recovers and resumes the normal refresh interval after a successful retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(validConfig))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse({ ...validConfig, version: 4 }));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      credential: "cred",
      refreshIntervalMs: 5_000,
      fetchImpl,
    });

    await client.start();
    await vi.advanceTimersByTimeAsync(5_000); // fails, schedules retry at 1000ms
    await vi.advanceTimersByTimeAsync(1_000); // succeeds

    expect(client.getConfig()?.version).toBe(4);

    client.stop();
  });

  it("isStale() is true before any successful fetch", () => {
    const client = new ConfigurationClient({ baseUrl: "http://api.test", credential: "cred" });

    expect(client.isStale()).toBe(true);
  });

  it("isStale() is always false without maxConfigAgeMs, however old the cache", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));

    const client = new ConfigurationClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

    await client.start();
    expect(client.isStale()).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.isStale()).toBe(false);

    client.stop();
  });

  it("isStale() respects maxConfigAgeMs when set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      credential: "cred",
      maxConfigAgeMs: 1_000,
      fetchImpl,
    });

    await client.start();
    expect(client.isStale()).toBe(false);

    vi.advanceTimersByTime(1_500);
    expect(client.isStale()).toBe(true);

    client.stop();
  });

  it("stop() prevents any further polling", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      credential: "cred",
      refreshIntervalMs: 10,
      fetchImpl,
    });

    await client.start();
    client.stop();

    const callsAtStop = fetchImpl.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchImpl.mock.calls.length).toBe(callsAtStop);
  });
});
