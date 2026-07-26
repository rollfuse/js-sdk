import type { Configuration } from "@growth-ops/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrowthOpsClient } from "../src/client.js";
import { ConfigNotReadyError, CredentialRequiredError, FlagNotFoundError } from "../src/errors.js";

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

describe("GrowthOpsClient", () => {
  describe("Explicit Credential Configuration", () => {
    it("throws CredentialRequiredError when constructed without a credential", () => {
      expect(() => new GrowthOpsClient({ baseUrl: "http://api.test", credential: "" })).toThrow(
        CredentialRequiredError,
      );
    });

    it("does not fall back to process.env for the credential", () => {
      const originalEnv = process.env.GROWTH_OPS_CREDENTIAL;
      process.env.GROWTH_OPS_CREDENTIAL = "svc_from_env.secret";

      try {
        expect(() => new GrowthOpsClient({ baseUrl: "http://api.test", credential: "" })).toThrow(
          CredentialRequiredError,
        );
      } finally {
        if (originalEnv === undefined) {
          delete process.env.GROWTH_OPS_CREDENTIAL;
        } else {
          process.env.GROWTH_OPS_CREDENTIAL = originalEnv;
        }
      }
    });
  });

  describe("Safe Fallback Behavior", () => {
    it("returns the fallback value when no Configuration has been fetched yet", () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new GrowthOpsClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      // start() not called/awaited: no Configuration is cached yet.
      const result = client.evaluate("user_1", "checkout-redesign", { fallback: "fallback-value" });

      expect(result.value).toBe("fallback-value");
      expect(result.reason).toBe("default_fallback");
      expect(result.track_exposure).toBe(false);
    });

    it("throws ConfigNotReadyError when no Configuration is cached and no fallback is supplied", () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new GrowthOpsClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      expect(() => client.evaluate("user_1", "checkout-redesign")).toThrow(ConfigNotReadyError);
    });

    it("evaluateAll throws ConfigNotReadyError when no Configuration is cached", () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new GrowthOpsClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      expect(() => client.evaluateAll("user_1")).toThrow(ConfigNotReadyError);
    });

    it("throws FlagNotFoundError for an unknown flag key once Configuration is cached, absent a fallback", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new GrowthOpsClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

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

      const client = new GrowthOpsClient({
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
      const client = new GrowthOpsClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

      await client.start();

      const callsBeforeEvaluate = fetchImpl.mock.calls.length;

      client.evaluate("user_1", "checkout-redesign", { attributes: { plan: "enterprise" } });

      expect(fetchImpl.mock.calls.length).toBe(callsBeforeEvaluate);

      client.stop();
    });

    it("evaluateAll returns a result for every flag in the Configuration", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));
      const client = new GrowthOpsClient({ baseUrl: "http://api.test", credential: "cred", fetchImpl });

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

      const client = new GrowthOpsClient({
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

      const client = new GrowthOpsClient({
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

      const client = new GrowthOpsClient({
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

      const client = new GrowthOpsClient({
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

      expect(onExposureDropped).toHaveBeenCalledWith(1);

      client.stop();
    });
  });
});
