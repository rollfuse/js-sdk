---
"@rollfuse/sdk": minor
"@rollfuse/sdk-browser": minor
---

Deduplicate exposure events by observation identity (subject key + flag
key + variation key) within a configurable window (`dedupeWindowMs`,
default 60s), so a component re-rendering or re-evaluating the same flag
for the same subject no longer inflates exposure counts. Drops caused by
dedup or a full queue are now aggregated and reported once per flush
instead of being silently discarded. Also guards `runFlush()` against
overlapping concurrent flushes.
