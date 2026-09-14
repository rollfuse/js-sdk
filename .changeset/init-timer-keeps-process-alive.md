---
"@rollfuse/sdk-js": patch
---

Fixed `start()`'s init-timeout timer being `unref()`'d, the same as the
poll/retry timer beside it. That's correct for the poll/retry timer, but
wrong for the init timer: against a platform that refuses the connection
immediately rather than hanging, nothing else was left pending, so the
whole process could exit silently (code 0) before the timer ever fired,
leaving `start()`'s returned Promise abandoned forever unsettled instead
of rejecting with `InitializationTimeoutError`. Found running against a
real deployment (task 11.2), not reproducible against a mocked fetch.
