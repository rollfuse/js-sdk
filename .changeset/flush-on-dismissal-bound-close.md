---
"@rollfuse/sdk": minor
"@rollfuse/sdk-browser": minor
---

`sdk-browser` now flushes queued exposure events on page dismissal
(`visibilitychange`/`pagehide`) using `fetch(..., {keepalive: true})`, so
events queued just before a tab close are no longer lost. `close()` on
both packages now accepts a bound via `closeTimeoutMs`
(`DEFAULT_CLOSE_TIMEOUT_MS`) instead of waiting indefinitely for an
in-flight flush, and releases config-change subscribers. Fixed a bug
where calling `start()` again after `stop()` left the client's poll loop
permanently inert instead of resuming polling.
