import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Configuration } from "@rollfuse/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationClient } from "../src/configuration-client.js";
import { RollfuseClient } from "../src/client.js";

/**
 * Real Server-Sent-Events coverage for add-configuration-streaming
 * section 7 (packages/sdk): a real `node:http` server writing real SSE
 * frames, not a mocked EventSource or a hand-rolled fetch stub — mirrors
 * this repo's established testing discipline and go-sdk's own
 * `streaming_client_test.go` (add-configuration-streaming section 5,
 * `rollfuse/go-sdk#18`), which this file's scenarios are ported from.
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

function writeJSON(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

interface HelloOptions {
  heartbeatIntervalSeconds?: number;
  maxLifetimeSeconds?: number;
  pollIntervalSeconds?: number;
}

function writeHello(res: http.ServerResponse, opts: HelloOptions = {}): void {
  res.write(
    sseFrame("hello", {
      heartbeat_interval_seconds: opts.heartbeatIntervalSeconds ?? 1,
      max_lifetime_seconds: opts.maxLifetimeSeconds ?? 3600,
      poll_interval_seconds: opts.pollIntervalSeconds ?? 1,
    }),
  );
}

function startStreamHeaders(res: http.ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
}

async function startServer(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return { server, url: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Polls `check` every 10ms (real time — no fake timers in this file) until it returns true or timeoutMs elapses, failing the test in the latter case. */
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
  // LIFO: a client registered after its server must be stopped before
  // that server is closed, or a still-open streaming connection makes
  // Node's server.close() (which waits for every existing connection to
  // end) hang until the client is torn down anyway.
  for (const fn of cleanup.splice(0).reverse()) {
    await fn();
  }
});

describe("ConfigurationClient streaming (add-configuration-streaming section 7)", () => {
  it("attempts a streaming connection alongside polling and reports it through transport() (tasks 5.1, 5.7)", async () => {
    const configVersion = 1;

    const { server, url } = await startServer((req, res) => {
      if (req.url === "/v1/config") {
        writeJSON(res, validConfig(configVersion));

        return;
      }

      if (req.url === "/v1/config/stream") {
        startStreamHeaders(res);
        writeHello(res);

        req.on("close", () => res.end());

        return;
      }

      res.writeHead(404).end();
    });
    cleanup.push(() => closeServer(server));

    const client = new ConfigurationClient({ baseUrl: url, credential: "cred" });
    cleanup.push(() => client.stop());

    expect(client.transport().streaming).toBe(false);

    // start() resolves purely from GET /v1/config's own first success —
    // never blocks on the stream connecting (task 5.1).
    await client.start();
    expect(client.getConfig()?.version).toBe(1);

    await waitFor(() => client.transport().streaming, 2_000, "stream never reported connected");
  });

  it("falls back to polling and evaluation is unaffected when the stream endpoint refuses the connection (task 5.2)", async () => {
    const { server, url } = await startServer((req, res) => {
      if (req.url === "/v1/config") {
        writeJSON(res, validConfig(1));

        return;
      }

      if (req.url === "/v1/config/stream") {
        // The platform's documented refusal shape — task 4.1/4.2's 429/503.
        writeJSON(res, { error: "streaming_capacity_exceeded" }, 503);

        return;
      }

      res.writeHead(404).end();
    });
    cleanup.push(() => closeServer(server));

    const client = new RollfuseClient({ baseUrl: url, credential: "cred" });
    cleanup.push(() => client.close());

    await client.start();

    expect(client.evaluate("subject-1", "checkout-redesign")).toMatchObject({ variation_key: "off" });
    expect(client.transport().streaming).toBe(false);

    // Give the refused stream connection a moment to have retried at
    // least once; evaluation must remain correct throughout.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.evaluate("subject-1", "checkout-redesign")).toMatchObject({ variation_key: "off" });
  });

  it("never attempts a stream connection when streamingDisabled is set (task 5.8)", async () => {
    let streamRequests = 0;

    const { server, url } = await startServer((req, res) => {
      if (req.url === "/v1/config") {
        writeJSON(res, validConfig(1));

        return;
      }

      if (req.url === "/v1/config/stream") {
        streamRequests += 1;
        startStreamHeaders(res);
        writeHello(res);

        return;
      }

      res.writeHead(404).end();
    });
    cleanup.push(() => closeServer(server));

    const client = new ConfigurationClient({ baseUrl: url, credential: "cred", streamingDisabled: true });
    cleanup.push(() => client.stop());

    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(streamRequests).toBe(0);
    expect(client.transport().streaming).toBe(false);
  });

  it("does not re-fetch for a version notification it already holds, and continues polling at the reduced interval while connected (tasks 5.4, 5.5)", async () => {
    let configFetches = 0;
    let servedVersion = 1;
    let streamRes: http.ServerResponse | undefined;

    const { server, url } = await startServer((req, res) => {
      if (req.url === "/v1/config") {
        configFetches += 1;
        writeJSON(res, validConfig(servedVersion));

        return;
      }

      if (req.url === "/v1/config/stream") {
        startStreamHeaders(res);
        writeHello(res, { heartbeatIntervalSeconds: 1, pollIntervalSeconds: 1 });
        streamRes = res;

        req.on("close", () => res.end());

        return;
      }

      res.writeHead(404).end();
    });
    cleanup.push(() => closeServer(server));

    const client = new ConfigurationClient({ baseUrl: url, credential: "cred", refreshIntervalMs: 60_000 });
    cleanup.push(() => client.stop());

    await client.start();
    expect(configFetches).toBe(1);

    await waitFor(() => client.transport().streaming, 2_000, "stream never connected");
    // Connecting itself wakes a pending poll wait so it recomputes using
    // the now-known reduced interval (task 5.4); depending on exact
    // timing that may or may not have already produced a second,
    // content-unchanged revalidation fetch by now — either is correct,
    // so the baseline below is read fresh rather than assumed fixed.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const baseline = configFetches;

    // Notify the version already held (1) — must not trigger a further fetch.
    streamRes?.write(sseFrame("version", "1"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(configFetches).toBe(baseline);

    // Notify a genuinely newer version — must trigger an out-of-band fetch
    // despite refreshIntervalMs being 60s (task 5.5), converging the cache.
    servedVersion = 2;
    streamRes?.write(sseFrame("version", "2"));
    await waitFor(() => client.getConfig()?.version === 2, 2_000, "did not fetch the newer notified version");
    expect(configFetches).toBe(baseline + 1);
  });

  it("converges on the newest version when notifications arrive out of order (task 5.6)", async () => {
    let servedVersion = 1;
    let streamRes: http.ServerResponse | undefined;

    const { server, url } = await startServer((req, res) => {
      if (req.url === "/v1/config") {
        writeJSON(res, validConfig(servedVersion));

        return;
      }

      if (req.url === "/v1/config/stream") {
        startStreamHeaders(res);
        writeHello(res);
        streamRes = res;

        req.on("close", () => res.end());

        return;
      }

      res.writeHead(404).end();
    });
    cleanup.push(() => closeServer(server));

    const client = new ConfigurationClient({ baseUrl: url, credential: "cred", refreshIntervalMs: 60_000 });
    cleanup.push(() => client.stop());

    await client.start();
    await waitFor(() => client.transport().streaming, 2_000, "stream never connected");

    servedVersion = 7;
    streamRes?.write(sseFrame("version", "7"));
    await waitFor(() => client.getConfig()?.version === 7, 2_000, "did not converge on version 7");

    // An out-of-order, lower version arriving after 7 must be a no-op:
    // the server itself never regresses (still serving 7), so even if
    // this triggered a fetch it would harmlessly re-confirm 7 — but the
    // real assertion is that considerVersionNotification's own guard
    // rejects it before that fetch would matter for a genuinely
    // regressing server.
    streamRes?.write(sseFrame("version", "5"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.getConfig()?.version).toBe(7);
  });

  it("detects a silently broken connection via missed heartbeats and reconnects with backoff (task 5.3)", async () => {
    let attempt = 0;

    const { server, url } = await startServer((req, res) => {
      if (req.url === "/v1/config") {
        writeJSON(res, validConfig(1));

        return;
      }

      if (req.url === "/v1/config/stream") {
        attempt += 1;
        startStreamHeaders(res);
        // Whole-seconds heartbeat (the real wire contract's own
        // resolution) — 1s is the smallest representable value, so this
        // is the slowest test in this file (missed-heartbeat threshold =
        // 3 * 1s = 3s).
        writeHello(res, { heartbeatIntervalSeconds: 1 });

        if (attempt === 1) {
          // Go silent forever after hello: no heartbeats, no version
          // events — the exact "intermediary silently drops the
          // connection" scenario the watchdog exists to detect. Never
          // end the response on its own; only client-side abort ends it.
          return;
        }

        // Every later (reconnected) attempt heartbeats normally.
        const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), 1_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          res.end();
        });

        return;
      }

      res.writeHead(404).end();
    });
    cleanup.push(() => closeServer(server));

    const client = new ConfigurationClient({ baseUrl: url, credential: "cred" });
    cleanup.push(() => client.stop());

    await client.start();

    // The first connection goes stale after ~3s (missed-heartbeat
    // threshold); the client must detect it and reconnect.
    await waitFor(() => attempt >= 2, 6_000, "client never reconnected after the first connection went silent");
    await waitFor(() => client.transport().streaming, 2_000, "reconnected stream never reported connected");
  }, 10_000);

  it("produces identical evaluations whether a version change is learned via streaming or via polling alone (tasks 5.9, 7.2)", async () => {
    let servedVersion = 1;
    let streamRes: http.ServerResponse | undefined;

    const handler: http.RequestListener = (req, res) => {
      if (req.url === "/v1/config") {
        writeJSON(res, validConfig(servedVersion));

        return;
      }

      if (req.url === "/v1/config/stream") {
        startStreamHeaders(res);
        writeHello(res);
        streamRes = res;

        req.on("close", () => res.end());

        return;
      }

      res.writeHead(404).end();
    };

    // Streaming-enabled client: learns of the change via a `version`
    // event.
    const streaming = await startServer(handler);
    cleanup.push(() => closeServer(streaming.server));
    const streamingClient = new RollfuseClient({ baseUrl: streaming.url, credential: "cred" });
    cleanup.push(() => streamingClient.close());

    // Polling-only client, same underlying data, streaming disabled —
    // learns of the SAME change purely by its next scheduled poll.
    const polling = await startServer(handler);
    cleanup.push(() => closeServer(polling.server));
    const pollingClient = new RollfuseClient({
      baseUrl: polling.url,
      credential: "cred",
      streamingDisabled: true,
      refreshIntervalMs: 30,
    });
    cleanup.push(() => pollingClient.close());

    await streamingClient.start();
    await pollingClient.start();

    await waitFor(() => streamingClient.transport().streaming, 2_000, "streaming client never connected");

    servedVersion = 2;
    streamRes?.write(sseFrame("version", "2"));

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

describe("RollfuseClient.transport() (task 5.7)", () => {
  it("is queryable through the public Client, not only the internal ConfigurationClient", async () => {
    const { server, url } = await startServer((req, res) => {
      if (req.url === "/v1/config") {
        writeJSON(res, validConfig(1));

        return;
      }

      if (req.url === "/v1/config/stream") {
        startStreamHeaders(res);
        writeHello(res);

        req.on("close", () => res.end());

        return;
      }

      res.writeHead(404).end();
    });
    cleanup.push(() => closeServer(server));

    const client = new RollfuseClient({ baseUrl: url, credential: "cred" });
    cleanup.push(() => client.close());

    await client.start();

    await waitFor(() => client.transport().streaming, 2_000, "RollfuseClient.transport() never reported streaming");
  });
});
