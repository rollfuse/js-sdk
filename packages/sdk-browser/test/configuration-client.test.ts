import type { Configuration } from "@rollfuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationClient } from "../src/configuration-client.js";
import { CredentialRejectedError, InitializationTimeoutError } from "../src/errors.js";

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
      publicCredential: "pub_cred",
      fetchImpl,
      onConfigRefreshed,
    });

    await client.start();

    expect(client.getConfig()).toEqual(validConfig);
    expect(onConfigRefreshed).toHaveBeenCalledWith(3);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.test/v1/config",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer pub_cred" }),
      }),
    );

    client.stop();
  });

  it("attaches a valid traceparent header to the GET /v1/config request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      fetchImpl,
    });

    await client.start();
    client.stop();

    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];

    expect(init.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it("evaluate does not perform a network request: start() does not block on refreshIntervalMs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
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
      publicCredential: "pub_cred",
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

  it("a config whose containers are well-formed but whose elements are not is rejected without replacing the cache (task 5.1, 5.2)", async () => {
    // The containers (flags/variations/rules arrays) are all present and
    // correctly typed here — only a single element deep inside is
    // malformed (a Variation with no `key`). A validation check that only
    // asked "is this an array" would have accepted this and cached it,
    // and evaluateFlag could then crash on it later, at evaluation time,
    // rather than this being rejected here at fetch time.
    // Manually verified: replacing the `candidate.variations.every(isValidVariation)`
    // check with a bare `Array.isArray(candidate.variations)` check made this
    // test fail (onConfigRefreshError never called); restored before committing.
    const configWithMalformedElement = {
      ...validConfig,
      version: 4,
      flags: [
        {
          ...validConfig.flags[0],
          variations: [{ value: true }, { key: "off", value: false }],
        },
      ],
    };

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(validConfig))
      .mockResolvedValueOnce(jsonResponse(configWithMalformedElement));

    const onConfigRefreshError = vi.fn();

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
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
      publicCredential: "pub_cred",
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
      publicCredential: "pub_cred",
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
      publicCredential: "pub_cred",
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
    const client = new ConfigurationClient({ baseUrl: "http://api.test", publicCredential: "pub_cred" });

    expect(client.isStale()).toBe(true);
  });

  it("isStale() is always false without maxConfigAgeMs, however old the cache", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));

    const client = new ConfigurationClient({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

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
      publicCredential: "pub_cred",
      maxConfigAgeMs: 1_000,
      fetchImpl,
    });

    await client.start();
    expect(client.isStale()).toBe(false);

    vi.advanceTimersByTime(1_500);
    expect(client.isStale()).toBe(true);

    client.stop();
  });

  it("start() rejects with InitializationTimeoutError once initTimeoutMs elapses against an unreachable platform (task 2.1)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network unreachable"));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      initTimeoutMs: 3_000,
      fetchImpl,
    });

    const started = client.start();

    started.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(3_000);

    await expect(started).rejects.toThrow(InitializationTimeoutError);

    client.stop();
  });

  it("start()'s wait terminates within the bound even under continuous failure (task 2.1's own scenario)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network unreachable"));
    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      initTimeoutMs: 5_000,
      fetchImpl,
    });

    const started = client.start();

    started.catch(() => undefined);

    let settled = false;

    started.then(
      () => (settled = true),
      () => (settled = true),
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    client.stop();
  });

  it("fails initialization immediately, without retry, on a 401 credential rejection (task 2.2)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const onConfigRefreshError = vi.fn();

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "wrong-cred",
      initTimeoutMs: 60_000,
      fetchImpl,
      onConfigRefreshError,
    });

    const started = client.start();

    await expect(started).rejects.toThrow(CredentialRejectedError);
    expect(onConfigRefreshError).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    client.stop();
  });

  it("fails initialization immediately, without retry, on a 403 credential rejection (task 2.2)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "cred-without-permission",
      fetchImpl,
    });

    const started = client.start();

    await expect(started).rejects.toThrow(CredentialRejectedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    client.stop();
  });

  it("a transient failure followed by a success inside the bound still resolves start() (task 2.3)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient network failure"))
      .mockResolvedValueOnce(jsonResponse(validConfig));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      initTimeoutMs: 5_000,
      fetchImpl,
    });

    const started = client.start();

    // First attempt fails immediately; retried at the base backoff (1000ms,
    // matching configuration-client.ts's own BASE_BACKOFF_MS).
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(started).resolves.toBeUndefined();
    expect(client.getConfig()).toEqual(validConfig);

    client.stop();
  });

  it("a throwing onConfigRefreshError does not stop the background poll loop from continuing on schedule (task 3.1)", async () => {
    // This package's tests carry no @types/node/`process` (it represents
    // literal browser-only code — see parity.test.ts's own note), so this
    // asserts the same property configuration-client.test.ts's Node
    // counterpart proves directly via `process.on("unhandledRejection")`:
    // a throwing callback here would otherwise surface as an unhandled
    // rejection that vitest's own run-level detection fails the whole
    // suite on regardless (confirmed: this package's `npm test` script
    // exits non-zero on any unhandled rejection during any test, whether
    // or not that test's own assertions pass). The behavioral assertion
    // below — that polling keeps going — is the same proof
    // configuration-client.ts's own doc comment on `runPollLoop` makes:
    // background work must survive a throwing callback, not just avoid
    // literally crashing.
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      refreshIntervalMs: 5_000,
      fetchImpl,
      onConfigRefreshError: () => {
        throw new Error("integrator's error callback itself throws");
      },
    });

    const started = client.start();

    started.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Retried at the base backoff (1000ms) despite the callback throwing
    // on the first attempt.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    client.stop();
  });

  it("a throwing onConfigRefreshed success callback still resolves start() and records the refresh as successful (task 3.2)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      fetchImpl,
      onConfigRefreshed: () => {
        throw new Error("integrator's success callback itself throws");
      },
    });

    // Before this fix (calling onConfigRefreshed directly, before
    // readyResolve()), a throwing callback was caught by this method's
    // own outer catch and misreported as a refresh failure, leaving
    // start() unresolved forever even though the fetch had genuinely
    // succeeded and this.config was already set.
    await expect(client.start()).resolves.toBeUndefined();
    expect(client.getConfig()).toEqual(validConfig);

    client.stop();
  });

  it("the background poll loop survives many consecutive failures without an unhandled rejection (task 3.3)", async () => {
    // See the task 3.1 test above for why this asserts survival
    // behaviorally rather than via `process.on`. This exercises
    // `runPollLoop`'s own terminal `.catch()` across several of the
    // unawaited, setTimeout-scheduled recursive calls, not only the
    // very first attempt.
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      refreshIntervalMs: 5_000,
      fetchImpl,
    });

    const started = client.start();

    started.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(3);

    client.stop();
  });

  it("applies a deadline even to an injected transport, per its own AbortSignal (task 4.2)", async () => {
    // AbortSignal.timeout's internal timer is not hooked by vitest's fake
    // timers (confirmed: with vi.useFakeTimers() active, advancing fake
    // time never fires the abort at all), so this one test runs under
    // real time instead, with a short real deadline. Manually verified:
    // removing the signal from the fetchImpl call made this test itself
    // fail (0 calls instead of 1); restored before committing.
    vi.useRealTimers();

    try {
      const hangingFetchImpl: typeof fetch = vi.fn((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit).signal;

          signal?.addEventListener("abort", () => {
            reject(signal.reason);
          });
        });
      });

      const onConfigRefreshError = vi.fn();

      const client = new ConfigurationClient({
        baseUrl: "http://api.test",
        publicCredential: "pub_cred",
        requestTimeoutMs: 50,
        fetchImpl: hangingFetchImpl,
        onConfigRefreshError,
      });

      const started = client.start();

      started.catch(() => undefined);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(onConfigRefreshError).toHaveBeenCalledTimes(1);

      client.stop();
    } finally {
      vi.useFakeTimers();
    }
  });

  it("stop() prevents any further polling", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validConfig));

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      refreshIntervalMs: 10,
      fetchImpl,
    });

    await client.start();
    client.stop();

    const callsAtStop = fetchImpl.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchImpl.mock.calls.length).toBe(callsAtStop);
  });

  it("defaults to a fetch that works when the global fetch is a `this`-sensitive wrapper (e.g. OpenTelemetry's instrumentation)", async () => {
    // Reproduces a real bug: some environments replace `window.fetch`
    // with a wrapper that throws "Illegal invocation" unless called with
    // `this === window`/globalThis. A bare `fetchImpl: options.fetchImpl
    // ?? fetch` stores a detached reference and calls it as
    // `this.fetchImpl(...)`, hitting exactly that failure — silently,
    // forever, since no fetchImpl was supplied to catch it in a test
    // using a plain mock function.
    const thisSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }

      return Promise.resolve(jsonResponse(validConfig));
    });
    vi.stubGlobal("fetch", thisSensitiveFetch);

    const onConfigRefreshError = vi.fn();
    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      onConfigRefreshError,
    });

    await client.start();

    expect(onConfigRefreshError).not.toHaveBeenCalled();
    expect(client.getConfig()).toEqual(validConfig);

    vi.unstubAllGlobals();
  });
});
