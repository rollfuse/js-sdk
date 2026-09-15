import type { Configuration } from "@rollfuse/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationClient } from "../src/configuration-client.js";
import { RollfusePublicClient } from "../src/client.js";

/**
 * Real Server-Sent-Events coverage for add-configuration-streaming
 * section 7 (packages/sdk-browser): a real, controllable `ReadableStream`
 * response body driven through a fetchImpl mock — not a mocked
 * EventSource (this platform authenticates with a bearer credential,
 * which the browser's native `EventSource` cannot send) and not a
 * `node:http` server (this package deliberately pulls in zero Node-only
 * dependencies, even in tests — see `configuration-client.ts`'s own doc
 * comment on why no undici-style pool exists here). The stream bytes and
 * the `AbortController`/`fetch` wiring are the real runtime primitives
 * this client actually uses; only the network transport itself is
 * in-memory. Scenarios ported from `@rollfuse/sdk-js`'s sibling file and
 * go-sdk's `streaming_client_test.go` (add-configuration-streaming
 * section 5, `rollfuse/go-sdk#18`).
 */

function validConfig(version: number): Configuration {
  return {
    environment_id: "env_1",
    version,
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
}

function configResponse(version: number): Response {
  return new Response(JSON.stringify(validConfig(version)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

interface HelloOptions {
  heartbeatIntervalSeconds?: number;
  maxLifetimeSeconds?: number;
  pollIntervalSeconds?: number;
}

function helloFrame(opts: HelloOptions = {}): string {
  return sseFrame("hello", {
    heartbeat_interval_seconds: opts.heartbeatIntervalSeconds ?? 1,
    max_lifetime_seconds: opts.maxLifetimeSeconds ?? 3600,
    poll_interval_seconds: opts.pollIntervalSeconds ?? 1,
  });
}

/**
 * A fake `GET /v1/config/stream` connection: a `ReadableStream` whose
 * bytes the test controls directly via `write`, wired so that aborting
 * `signal` (exactly what the client's own missed-heartbeat watchdog and
 * `stop()` both do to the real `AbortController`) errors the stream —
 * causing the client's `reader.read()` to reject, precisely like a real
 * aborted `fetch` does.
 */
function fakeStreamConnection(signal: AbortSignal): { response: Response; write: (text: string) => void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const onAbort = (): void => {
    try {
      controller?.error(new DOMException("Aborted", "AbortError"));
    } catch {
      // Already closed/errored — fine.
    }
  };

  signal.addEventListener("abort", onAbort, { once: true });

  return {
    response: new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    write: (text: string) => {
      try {
        controller?.enqueue(encoder.encode(text));
      } catch {
        // Stream already closed/errored — fine, matches a write racing a
        // just-aborted real connection.
      }
    },
  };
}

/** Polls `check` every 10ms (real time) until it returns true or timeoutMs elapses, failing the test in the latter case. */
async function waitFor(check: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  if (!check()) {
    throw new Error(`waitFor timed out: ${message}`);
  }
}

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    await fn();
  }
});

describe("ConfigurationClient streaming (add-configuration-streaming section 7)", () => {
  it("attempts a streaming connection alongside polling and reports it through transport() (tasks 5.1, 5.7)", async () => {
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/v1/config/stream")) {
        const conn = fakeStreamConnection(init!.signal!);
        conn.write(helloFrame());

        return conn.response;
      }

      return configResponse(1);
    }) as typeof fetch;

    const client = new ConfigurationClient({ baseUrl: "http://api.test", publicCredential: "cred", fetchImpl });
    cleanup.push(() => client.stop());

    expect(client.transport().streaming).toBe(false);

    // start() resolves purely from GET /v1/config's own first success —
    // never blocks on the stream connecting (task 5.1).
    await client.start();
    expect(client.getConfig()?.version).toBe(1);

    await waitFor(() => client.transport().streaming, 2_000, "stream never reported connected");
  });

  it("falls back to polling and evaluation is unaffected when the stream endpoint refuses the connection (task 5.2)", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith("/v1/config/stream")) {
        // The platform's documented refusal shape — task 4.1/4.2's 429/503.
        return new Response(JSON.stringify({ error: "streaming_capacity_exceeded" }), { status: 503 });
      }

      return configResponse(1);
    }) as typeof fetch;

    const client = new RollfusePublicClient({ baseUrl: "http://api.test", publicCredential: "cred", fetchImpl });
    cleanup.push(() => client.close());

    await client.start();

    expect(client.evaluate("subject-1", "checkout-redesign")).toMatchObject({ variation_key: "off" });
    expect(client.transport().streaming).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.evaluate("subject-1", "checkout-redesign")).toMatchObject({ variation_key: "off" });
  });

  it("never attempts a stream connection when streamingDisabled is set (task 5.8)", async () => {
    let streamRequests = 0;

    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/v1/config/stream")) {
        streamRequests += 1;

        return fakeStreamConnection(init!.signal!).response;
      }

      return configResponse(1);
    }) as typeof fetch;

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "cred",
      streamingDisabled: true,
      fetchImpl,
    });
    cleanup.push(() => client.stop());

    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(streamRequests).toBe(0);
    expect(client.transport().streaming).toBe(false);
  });

  it("does not re-fetch for a version notification it already holds, and delivers a genuinely newer one (tasks 5.4, 5.5)", async () => {
    let configFetches = 0;
    let servedVersion = 1;
    let streamWrite: ((text: string) => void) | undefined;

    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/v1/config/stream")) {
        const conn = fakeStreamConnection(init!.signal!);
        streamWrite = conn.write;
        conn.write(helloFrame({ heartbeatIntervalSeconds: 1, pollIntervalSeconds: 1 }));

        return conn.response;
      }

      configFetches += 1;

      return configResponse(servedVersion);
    }) as typeof fetch;

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "cred",
      refreshIntervalMs: 60_000,
      fetchImpl,
    });
    cleanup.push(() => client.stop());

    await client.start();
    expect(configFetches).toBe(1);

    await waitFor(() => client.transport().streaming, 2_000, "stream never connected");
    // Connecting itself wakes a pending poll wait (task 5.4); depending
    // on exact timing that may or may not have already produced a
    // second, content-unchanged revalidation fetch — either is correct,
    // so the baseline below is read fresh rather than assumed fixed.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const baseline = configFetches;

    streamWrite?.(sseFrame("version", "1"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(configFetches).toBe(baseline);

    servedVersion = 2;
    streamWrite?.(sseFrame("version", "2"));
    await waitFor(() => client.getConfig()?.version === 2, 2_000, "did not fetch the newer notified version");
    expect(configFetches).toBe(baseline + 1);
  });

  it("converges on the newest version when notifications arrive out of order (task 5.6)", async () => {
    let servedVersion = 1;
    let streamWrite: ((text: string) => void) | undefined;

    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/v1/config/stream")) {
        const conn = fakeStreamConnection(init!.signal!);
        streamWrite = conn.write;
        conn.write(helloFrame());

        return conn.response;
      }

      return configResponse(servedVersion);
    }) as typeof fetch;

    const client = new ConfigurationClient({
      baseUrl: "http://api.test",
      publicCredential: "cred",
      refreshIntervalMs: 60_000,
      fetchImpl,
    });
    cleanup.push(() => client.stop());

    await client.start();
    await waitFor(() => client.transport().streaming, 2_000, "stream never connected");

    servedVersion = 7;
    streamWrite?.(sseFrame("version", "7"));
    await waitFor(() => client.getConfig()?.version === 7, 2_000, "did not converge on version 7");

    // An out-of-order, lower version arriving after 7 must be a no-op.
    streamWrite?.(sseFrame("version", "5"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.getConfig()?.version).toBe(7);
  });

  it("detects a silently broken connection via missed heartbeats and reconnects with backoff (task 5.3)", async () => {
    let attempt = 0;

    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/v1/config/stream")) {
        attempt += 1;

        const conn = fakeStreamConnection(init!.signal!);
        // Whole-seconds heartbeat (the real wire contract's own
        // resolution) — 1s is the smallest representable value, so this
        // is the slowest test in this file (missed-heartbeat threshold =
        // 3 * 1s = 3s).
        conn.write(helloFrame({ heartbeatIntervalSeconds: 1 }));

        if (attempt === 1) {
          // Go silent forever after hello: no heartbeats, no version
          // events — the exact "intermediary silently drops the
          // connection" scenario the watchdog exists to detect.
          return conn.response;
        }

        // Every later (reconnected) attempt heartbeats normally.
        const heartbeat = setInterval(() => conn.write(":heartbeat\n\n"), 1_000);
        init!.signal!.addEventListener("abort", () => clearInterval(heartbeat), { once: true });

        return conn.response;
      }

      return configResponse(1);
    }) as typeof fetch;

    const client = new ConfigurationClient({ baseUrl: "http://api.test", publicCredential: "cred", fetchImpl });
    cleanup.push(() => client.stop());

    await client.start();

    await waitFor(() => attempt >= 2, 6_000, "client never reconnected after the first connection went silent");
    await waitFor(() => client.transport().streaming, 2_000, "reconnected stream never reported connected");
  }, 10_000);

  it("produces identical evaluations whether a version change is learned via streaming or via polling alone (tasks 5.9, 7.2)", async () => {
    let servedVersion = 1;
    let streamWrite: ((text: string) => void) | undefined;

    const streamingFetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/v1/config/stream")) {
        const conn = fakeStreamConnection(init!.signal!);
        streamWrite = conn.write;
        conn.write(helloFrame());

        return conn.response;
      }

      return configResponse(servedVersion);
    }) as typeof fetch;

    const pollingFetchImpl = (async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith("/v1/config/stream")) {
        throw new Error("streamingDisabled client must never call this");
      }

      return configResponse(servedVersion);
    }) as typeof fetch;

    const streamingClient = new RollfusePublicClient({
      baseUrl: "http://api.test",
      publicCredential: "cred",
      fetchImpl: streamingFetchImpl,
    });
    cleanup.push(() => streamingClient.close());

    const pollingClient = new RollfusePublicClient({
      baseUrl: "http://api.test",
      publicCredential: "cred",
      streamingDisabled: true,
      refreshIntervalMs: 30,
      fetchImpl: pollingFetchImpl,
    });
    cleanup.push(() => pollingClient.close());

    await streamingClient.start();
    await pollingClient.start();

    await waitFor(() => streamingClient.transport().streaming, 2_000, "streaming client never connected");

    servedVersion = 2;
    streamWrite?.(sseFrame("version", "2"));

    await waitFor(
      () => streamingClient.evaluate("subject-1", "checkout-redesign").config_version === 2,
      2_000,
      "streaming client never picked up version 2",
    );
    await waitFor(
      () => pollingClient.evaluate("subject-1", "checkout-redesign").config_version === 2,
      2_000,
      "polling-only client never picked up version 2",
    );

    expect(streamingClient.evaluate("subject-1", "checkout-redesign")).toEqual(
      pollingClient.evaluate("subject-1", "checkout-redesign"),
    );
  });
});

describe("RollfusePublicClient.transport() (task 5.7)", () => {
  it("is queryable through the public Client, not only the internal ConfigurationClient", async () => {
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/v1/config/stream")) {
        const conn = fakeStreamConnection(init!.signal!);
        conn.write(helloFrame());

        return conn.response;
      }

      return configResponse(1);
    }) as typeof fetch;

    const client = new RollfusePublicClient({ baseUrl: "http://api.test", publicCredential: "cred", fetchImpl });
    cleanup.push(() => client.close());

    await client.start();

    await waitFor(() => client.transport().streaming, 2_000, "RollfusePublicClient.transport() never reported streaming");
  });
});
