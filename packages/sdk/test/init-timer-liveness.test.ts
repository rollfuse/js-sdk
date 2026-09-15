import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * Task 11.2 (harden-sdk-runtime): running this package against a real
 * deployment surfaced a case no mocked-fetch unit test can: `start()`'s
 * init-timeout timer was `unref()`'d, same as the poll/retry timer it sits
 * next to. That's correct for the poll/retry timer (background polling
 * must never keep a process alive on its own) but wrong for the init
 * timer: when the platform is unreachable and rejects the connection
 * immediately (not a slow hang), nothing else is left pending, so an
 * unref'd init timer lets the whole process exit silently before it ever
 * fires — `start()`'s returned Promise is abandoned forever unsettled and
 * unreported, exit code 0, instead of the process staying alive long
 * enough to reject with `InitializationTimeoutError`.
 *
 * Only a real child process (a real event loop, real handle-counting) can
 * observe this — a fake-timer/mocked-fetch unit test cannot, since vitest
 * itself is the thing keeping the test process alive regardless of what
 * the library under test does.
 */
it("keeps the process alive until start() rejects, even with no other pending work (task 11.2)", async () => {
  const script = `
    import { RollfuseClient } from ${JSON.stringify(distEntry)};
    const client = new RollfuseClient({
      baseUrl: "http://127.0.0.1:1",
      credential: "test-credential", streamingDisabled: true,
      initTimeoutMs: 300,
    });
    client.start().catch(() => { process.stdout.write("rejected\\n"); });
  `;

  const start = Date.now();
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], (err, out) => {
      if (err) {
        reject(err);

        return;
      }

      resolve(out);
    });
  });
  const elapsedMs = Date.now() - start;

  expect(stdout).toContain("rejected");
  // A bug reintroducing unref() on the init timer makes the process exit in
  // well under 50ms (measured ~79ms with an even less aggressive timeout in
  // manual verification) instead of waiting out initTimeoutMs.
  expect(elapsedMs).toBeGreaterThanOrEqual(250);
});
