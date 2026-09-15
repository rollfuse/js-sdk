import type { Configuration } from "@rollfuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationClient } from "../src/configuration-client.js";
import { CredentialRejectedError, InitializationTimeoutError } from "../src/errors.js";

const validConfig: Configuration = {
  environment_id: "env_1",
  version: 3,
  format_version: 1,
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

let randomSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  // Neutralizes task 9.2's jitter for every test that doesn't explicitly
  // test it: with Math.random() pinned to 0, withJitter(base) === base,
  // so every existing exact-interval advanceTimersByTimeAsync(...)
  // assertion still holds. The jitter tests below call
  // randomSpy.mockRestore() to get real randomness back.
  randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
      format_version: 1,
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

  describe("Polling Revalidates And Does Not Synchronize", () => {
    it("presents the last ETag via If-None-Match, and a 304 leaves the cache in place without replacing it (task 9.1)", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(validConfig), {
            status: 200,
            headers: { "Content-Type": "application/json", ETag: '"v3"' },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 304 }));

      const onConfigRefreshed = vi.fn();
      const onConfigRefreshError = vi.fn();

      const client = new ConfigurationClient({
        baseUrl: "http://api.test",
        publicCredential: "pub_cred",
        refreshIntervalMs: 10,
        fetchImpl,
        onConfigRefreshed,
        onConfigRefreshError,
      });

      await client.start();
      expect(onConfigRefreshed).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);

      expect(fetchImpl).toHaveBeenCalledTimes(2);

      const [, secondInit] = fetchImpl.mock.calls[1] as [string, { headers: Record<string, string> }];
      expect(secondInit.headers["If-None-Match"]).toBe('"v3"');

      // A 304 is a successful poll, NOT an error (a mutation that made
      // this fall through to the generic `!response.ok` error branch
      // instead of a dedicated 304 success branch would still leave the
      // cache untouched and onConfigRefreshed uncalled, so those alone
      // wouldn't catch it — this is the assertion that actually
      // distinguishes the two).
      expect(onConfigRefreshError).not.toHaveBeenCalled();
      expect(onConfigRefreshed).toHaveBeenCalledTimes(1);
      expect(client.getConfig()).toEqual(validConfig);

      client.stop();
    });

    it("a 304 still counts as a successful poll for isStale()/maxConfigAgeMs purposes", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ ...validConfig }, 200))
        .mockResolvedValueOnce(new Response(null, { status: 304 }));

      const client = new ConfigurationClient({
        baseUrl: "http://api.test",
        publicCredential: "pub_cred",
        refreshIntervalMs: 100,
        maxConfigAgeMs: 150,
        fetchImpl,
      });

      await client.start();

      await vi.advanceTimersByTimeAsync(100); // the 304
      await vi.advanceTimersByTimeAsync(100);

      expect(client.isStale()).toBe(false);

      client.stop();
    });

    it("applies randomized jitter on top of the refresh interval, so successive scheduled delays differ (task 9.2)", async () => {
      randomSpy.mockRestore(); // real randomness for this test specifically

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      // A fresh Response per call: mockResolvedValue would return the
      // same Response instance every time, and a Response body can only
      // be read once — a second .json() on a reused instance throws,
      // which would make every poll after the first look like a failure.
      const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(validConfig)));

      const client = new ConfigurationClient({
        baseUrl: "http://api.test",
        publicCredential: "pub_cred",
        refreshIntervalMs: 10_000,
        fetchImpl,
      });

      await client.start();

      const delaysScheduledAtBase10000 = () =>
        setTimeoutSpy.mock.calls
          .map(([, delay]) => delay as number)
          .filter((delay) => delay >= 10_000 && delay < 12_000); // the poll timer, not the (unrelated) init timer

      await vi.advanceTimersByTimeAsync(10_000 * 1.2);
      await vi.advanceTimersByTimeAsync(10_000 * 1.2);
      await vi.advanceTimersByTimeAsync(10_000 * 1.2);

      const delays = delaysScheduledAtBase10000();

      expect(delays.length).toBeGreaterThanOrEqual(3);
      expect(new Set(delays).size).toBeGreaterThan(1);
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(10_000); // task 9.2: jitter only adds, never polls less often than configured
      }

      client.stop();
    });

    it("applies randomized jitter on top of retry backoff too, so many clients recovering together don't retry in lockstep (task 9.2)", async () => {
      // Backoff itself doubles on every successive retry, so two retries
      // from the SAME client never land at the same nominal delay —
      // several independent clients each experiencing their own FIRST
      // failure (same nominal base backoff, 1000ms) is what proves
      // jitter spreads them apart.
      randomSpy.mockRestore();

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const fetchImpl = vi.fn().mockRejectedValue(new Error("network unreachable"));

      const clients = Array.from(
        { length: 5 },
        () => new ConfigurationClient({ baseUrl: "http://api.test", publicCredential: "pub_cred", initTimeoutMs: 60_000, fetchImpl }),
      );

      for (const client of clients) {
        void client.start().catch(() => undefined);
      }

      await vi.advanceTimersByTimeAsync(0);

      const firstBackoffDelays = setTimeoutSpy.mock.calls
        .map(([, delay]) => delay as number)
        .filter((delay) => delay >= 1_000 && delay < 1_200);

      expect(firstBackoffDelays.length).toBe(5);
      expect(new Set(firstBackoffDelays).size).toBeGreaterThan(1);

      for (const delay of firstBackoffDelays) {
        expect(delay).toBeGreaterThanOrEqual(1_000);
      }

      for (const client of clients) {
        client.stop();
      }
    });

    it("uses the platform's advised poll_interval_seconds in preference to its own default when refreshIntervalMs isn't set (task 9.3)", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...validConfig, poll_interval_seconds: 5 }));

      const client = new ConfigurationClient({
        baseUrl: "http://api.test",
        publicCredential: "pub_cred",
        fetchImpl,
      });

      await client.start();
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      client.stop();
    });

    it("an explicitly configured refreshIntervalMs still wins over the platform's advised interval", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...validConfig, poll_interval_seconds: 5 }));

      const client = new ConfigurationClient({
        baseUrl: "http://api.test",
        publicCredential: "pub_cred",
        refreshIntervalMs: 20_000,
        fetchImpl,
      });

      await client.start();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      client.stop();
    });
  });
});
