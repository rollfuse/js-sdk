---
"@rollfuse/sdk-js": patch
"@rollfuse/sdk-browser": patch
---

Configuration polling now revalidates via `If-None-Match`/ETag (a 304
response keeps the current cache instead of re-decoding an unchanged
payload), applies random jitter on top of the configured interval to
avoid synchronized thundering-herd polling across clients, and honors a
server-advised poll interval when present. Exposure batches larger than
the platform's accepted request size are now split into chunks instead
of failing outright.
