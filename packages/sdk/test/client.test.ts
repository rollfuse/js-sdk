import type { Configuration } from "@rollfuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RollfuseClient } from "../src/client.js";
import { ConfigNotReadyError, CredentialRequiredError, FlagNotFoundError } from "../src/errors.js";

const validConfig: Configuration = {
  environment_id: "env_1",
  version: 3,
  poll_interval_seconds: 30,
  flags: [
    {
      flag_key: "checkout-redesign",
      enabled: true,
      default_variation: "off",
      variations: [
        { key: "on", value: true },
        { key: "off", value: false },
      ],
      rules: [
        { conditions: [{ attribute: "plan", value: "enterprise" }], outcome: { variation_key: "on" } },
      ],
    },
    {
      flag_key: "always-off",
      enabled: false,
      default_variation: "off",
      variations: [{ key: "off", value: false }],
      rules: [],
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RollfuseClient", () => {
  describe("Explicit Credential Configuration", () => {
    it("throws CredentialRequiredError when constructed without a credential", () => {
      expect(() => new RollfuseClient({ baseUrl: "http://api.test", credential: "" })).toThrow(
        CredentialRequiredError,
      );
    });

    it("does not fall back to process.env for the credential", () => {
      const originalEnv = process.env.ROLLFUSE_CREDENTIAL;
      process.env.ROLLFUSE_CREDENTIAL = "svc_from_env.secret";

      try {
        expect(() => new RollfuseClient({ baseUrl: "http://api.test", credential: "" })).toThrow(
          CredentialRequiredError,
        );
      } finally {
        if (originalEnv === undefined) {
          delete process.env.ROLLFUSE_CREDENTIAL;
        } else {
          process.env.ROLLFUSE_CREDENTIAL = originalEnv;
        }
      }
    });
  });

  describe("Safe Fallback Behavior", () => {
    it("returns the fallback value when no Configuration has been fetched yet", () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new RollfuseClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      // start() not called/awaited: no Configuration is cached yet.
      const result = client.evaluate("user_1", "checkout-redesign", { fallback: "fallback-value" });

      expect(result.value).toBe("fallback-value");
      expect(result.reason).toBe("default_fallback");
      expect(result.track_exposure).toBe(false);
    });

    it("a non-blocking start() (called but not awaited) still returns the fallback synchronously, without blocking or throwing (task 2.4)", () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new RollfuseClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      // Fire-and-forget, exactly as the "Initialization is configured to
      // be non-blocking" scenario describes — deliberately not awaited.
      const started = client.start();

      started.catch(() => undefined);

      const result = client.evaluate("user_1", "checkout-redesign", { fallback: "fallback-value" });

      expect(result).toEqual({
        flag_key: "checkout-redesign",
        variation_key: "",
        value: "fallback-value",
        reason: "default_fallback",
        config_version: 0,
        track_exposure: false,
      });

      client.stop();
    });

    it("throws ConfigNotReadyError when no Configuration is cached and no fallback is supplied", () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new RollfuseClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      expect(() => client.evaluate("user_1", "checkout-redesign")).toThrow(ConfigNotReadyError);
    });

    it("evaluateAll throws ConfigNotReadyError when no Configuration is cached", () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new RollfuseClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      expect(() => client.evaluateAll("user_1")).toThrow(ConfigNotReadyError);
    });

    it("throws FlagNotFoundError for an unknown flag key once Configuration is cached, absent a fallback", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new RollfuseClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      await client.start();

      expect(() => client.evaluate("user_1", "does-not-exist")).toThrow(FlagNotFoundError);

      client.stop();
    });
  });

  describe("Failure Isolation From Platform Unavailability", () => {
    it("keeps evaluating successfully after a refresh failure, using the last-known-good config", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(validConfig))
        .mockRejectedValue(new Error("network down"));

      const client = new RollfuseClient({
        baseUrl: "http://api.test",
        credential: "cred",
        refreshIntervalMs: 5_000,
        fetchImpl,
      });

      await client.start();

      await vi.advanceTimersByTimeAsync(5_000); // scheduled refresh fails

      const result = client.evaluate("user_1", "checkout-redesign", { attributes: { plan: "enterprise" } });

      expect(result.variation_key).toBe("on");
      expect(result.reason).toBe("rule_match");

      client.stop();
    });
  });

  describe("Deterministic Local Evaluation", () => {
    it("evaluate does not perform a network request", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new RollfuseClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      await client.start();

      const callsBeforeEvaluate = fetchImpl.mock.calls.length;

      client.evaluate("user_1", "checkout-redesign", { attributes: { plan: "enterprise" } });

      expect(fetchImpl.mock.calls.length).toBe(callsBeforeEvaluate);

      client.stop();
    });

    it("evaluateAll returns a result for every flag in the Configuration", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new RollfuseClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      await client.start();

      const results = client.evaluateAll("user_1");

      expect(results.map((r) => r.flag_key).sort()).toEqual(["always-off", "checkout-redesign"]);

      client.stop();
    });
  });

  describe("Asynchronous, Best-Effort Exposure Reporting", () => {
    it("enqueues an exposure for a rule-matched evaluation without blocking evaluate", async () => {
      const configFetch = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const exposureFetch = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }));

      const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/exposure-events")) {
          return exposureFetch(url, init);
        }

        return configFetch(url, init);
      });

      const client = new RollfuseClient({
        baseUrl: "http://api.test",
        credential: "cred",
        exposureBatchSize: 1,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await client.start();

      const result = client.evaluate("user_1", "checkout-redesign", { attributes: { plan: "enterprise" } });
      expect(result.track_exposure).toBe(true);

      // Batch size 1 triggers an immediate flush; await a microtask turn
      // for that fire-and-forget flush to actually run.
      await vi.waitFor(() => expect(exposureFetch).toHaveBeenCalledTimes(1));

      const body = JSON.parse((exposureFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.events).toHaveLength(1);
      expect(body.events[0]).toMatchObject({
        flag_key: "checkout-redesign",
        subject_key: "user_1",
        variation_key: "on",
        reason: "rule_match",
        config_version: 3,
      });

      client.stop();
    });

    it("does not enqueue an exposure for a default/fallback evaluation", async () => {
      const exposureFetch = vi.fn().mockResolvedValue(jsonResponse({ accepted: 0 }));
      const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/exposure-events")) {
          return exposureFetch(url, init);
        }

        return Promise.resolve(jsonResponse(validConfig));
      });

      const client = new RollfuseClient({
        baseUrl: "http://api.test",
        credential: "cred",
        exposureBatchSize: 1,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await client.start();

      // "always-off" is disabled: default path, no exposure.
      const result = client.evaluate("user_1", "always-off");
      expect(result.track_exposure).toBe(false);

      client.stop();
      expect(exposureFetch).not.toHaveBeenCalled();
    });

    it("a submission failure does not affect the already-returned evaluate result", async () => {
      const exposureFetch = vi.fn().mockRejectedValue(new Error("network down"));
      const onExposureSubmitError = vi.fn();

      const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/exposure-events")) {
          return exposureFetch(url, init);
        }

        return Promise.resolve(jsonResponse(validConfig));
      });

      const client = new RollfuseClient({
        baseUrl: "http://api.test",
        credential: "cred",
        exposureBatchSize: 1,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onExposureSubmitError,
      });

      await client.start();

      const result = client.evaluate("user_1", "checkout-redesign", { attributes: { plan: "enterprise" } });

      await vi.waitFor(() => expect(onExposureSubmitError).toHaveBeenCalledTimes(1));

      // The result returned synchronously by evaluate() is unaffected by
      // the later, asynchronous submission failure.
      expect(result.variation_key).toBe("on");
      expect(result.reason).toBe("rule_match");

      client.stop();
    });

    it("a full exposure queue drops rather than blocks, and reports the drop", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const onExposureDropped = vi.fn();

      const client = new RollfuseClient({
        baseUrl: "http://api.test",
        credential: "cred",
        exposureQueueCapacity: 1,
        exposureBatchSize: 1_000_000, // never auto-flush during this test
        fetchImpl,
        onExposureDropped,
      });

      await client.start();

      client.evaluate("user_1", "checkout-redesign", { attributes: { plan: "enterprise" } });
      client.evaluate("user_2", "checkout-redesign", { attributes: { plan: "enterprise" } });

      // Drops are now aggregated and reported once per flush tick (task
      // 7.5), rather than synchronously inside evaluate()/enqueue() — so
      // not yet reported here.
      expect(onExposureDropped).not.toHaveBeenCalled();

      await client.close();

      expect(onExposureDropped).toHaveBeenCalledWith(1);
    });
  });

  describe("A Client Flushes Before It Stops", () => {
    it("close() returns once flushed and released, well before closeTimeoutMs, on the happy path (task 8.2)", async () => {
      vi.useRealTimers();

      try {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
        const client = new RollfuseClient({
          baseUrl: "http://api.test",
          credential: "cred",
          closeTimeoutMs: 5_000,
          fetchImpl,
        });

        await client.start();
        client.evaluate("user_1", "checkout-redesign", { attributes: { plan: "enterprise" } });

        const startedAt = Date.now();
        await client.close();
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(1_000);

        const exposureCall = fetchImpl.mock.calls.find(([url]) => (url as string).endsWith("/v1/exposure-events"));
        expect(exposureCall).toBeDefined();
      } finally {
        vi.useFakeTimers();
      }
    });

    it("close() returns once closeTimeoutMs elapses if the flush hangs, rather than awaiting it indefinitely (task 8.2). Manually verified: removing the Promise.race bound made this test itself hang past its own timeout; restored before committing.", async () => {
      vi.useRealTimers();

      try {
        const fetchImpl: typeof fetch = vi.fn((url) => {
          if (url.toString().endsWith("/v1/exposure-events")) {
            return new Promise<Response>(() => {
              // never resolves
            });
          }

          return Promise.resolve(jsonResponse(validConfig));
        });

        const client = new RollfuseClient({
          baseUrl: "http://api.test",
          credential: "cred",
          closeTimeoutMs: 100,
          fetchImpl,
        });

        await client.start();
        client.evaluate("user_1", "checkout-redesign", { attributes: { plan: "enterprise" } });

        const startedAt = Date.now();
        await client.close();
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeGreaterThanOrEqual(90);
        expect(elapsed).toBeLessThan(1_000);
      } finally {
        vi.useFakeTimers();
      }
    });

    it("a stopped client resumes polling and reporting once started again, rather than remaining inert (task 8.3)", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(validConfig))
        .mockResolvedValueOnce(
          jsonResponse({ ...validConfig, version: 4, flags: [{ ...validConfig.flags[0], rules: [] }] }),
        );

      const client = new RollfuseClient({
        baseUrl: "http://api.test",
        credential: "cred",
        refreshIntervalMs: 1_000,
        fetchImpl,
      });

      await client.start();
      expect(
        client.evaluate("user_1", "checkout-redesign", { attributes: { plan: "enterprise" } }).variation_key,
      ).toBe("on");

      client.stop();

      // While stopped, no further refresh happens even once the interval elapses.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Restarted: resumes with an immediate poll attempt rather than
      // waiting out a full interval it has no active timer for anymore.
      await client.start();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

      expect(
        client.evaluate("user_1", "checkout-redesign", { attributes: { plan: "enterprise" } }).variation_key,
      ).toBe("off");

      client.stop();
    });

    it("subscribe notifies on each Configuration change, alongside the integrator's own onConfigRefreshed, until unsubscribed (task 10.1)", async () => {
      const fetchImpl = vi.fn().mockImplementation(() =>
        Promise.resolve(jsonResponse({ ...validConfig, version: fetchImpl.mock.calls.length + 1 })),
      );

      const onConfigRefreshed = vi.fn();

      const client = new RollfuseClient({
        baseUrl: "http://api.test",
        credential: "cred",
        refreshIntervalMs: 10,
        fetchImpl,
        onConfigRefreshed,
      });

      const listener = vi.fn();
      const unsubscribe = client.subscribe(listener);

      await client.start();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(onConfigRefreshed).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(12); // 10ms base + task 9.2's jitter (up to +20%)
      expect(listener).toHaveBeenCalledTimes(2);
      expect(onConfigRefreshed).toHaveBeenCalledTimes(2);

      unsubscribe();

      await vi.advanceTimersByTimeAsync(12);
      expect(listener).toHaveBeenCalledTimes(2); // no further notifications
      expect(onConfigRefreshed).toHaveBeenCalledTimes(3); // the integrator's own callback is unaffected

      client.stop();
    });

    it("close() releases every registered subscriber, so no listener is retained (task 10.1, mirroring task 8.4)", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new RollfuseClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      await client.start();

      client.subscribe(vi.fn());
      client.subscribe(vi.fn());

      const listenerCount = () =>
        (client as unknown as { configChangeListeners: Set<unknown> }).configChangeListeners.size;

      expect(listenerCount()).toBe(2);

      await client.close();

      expect(listenerCount()).toBe(0);
    });
  });
});
