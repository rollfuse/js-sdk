---
"@rollfuse/sdk-js": minor
"@rollfuse/sdk-browser": minor
---

Add a Server-Sent-Events streaming consumer alongside polling: both packages now attempt a `GET /v1/config/stream` connection on `start()`, revalidate and fetch only when a notified Configuration Version is genuinely newer than the one held, fall back to (and never stop) polling when streaming is unavailable, refused, or breaks, and expose the currently active transport via a new `Client.transport()` diagnostic method. Streaming can be disabled with the new `streamingDisabled` option.
