import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createPooledFetch } from "../src/pooled-fetch.js";

/**
 * A server that accepts the TCP connection but never writes a response —
 * exercises headersTimeout deterministically, without depending on
 * network conditions the way a black-hole IP address would.
 */
function startSilentServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(() => {
      // Deliberately never calls res.end() or writes anything.
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("createPooledFetch", () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.close();
    server = undefined;
  });

  it("rejects instead of hanging when headersTimeoutMs elapses with no response", async () => {
    const started = await startSilentServer();
    server = started.server;

    const pooledFetch = createPooledFetch(started.url, { headersTimeoutMs: 100 });

    try {
      await expect(pooledFetch(`${started.url}/v1/config`)).rejects.toThrow();
    } finally {
      await pooledFetch.close();
    }
  });

  it("close() releases the pool without throwing", async () => {
    const pooledFetch = createPooledFetch("http://127.0.0.1:9", {});

    await expect(pooledFetch.close()).resolves.toBeUndefined();
  });
});
