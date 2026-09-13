---
"@rollfuse/evaluation-core": patch
---

Republish with the correct `@rollfuse/contracts` dependency range. The
previously published `0.2.0` archive declared `^0.2.2`, five minor versions
behind the workspace's actual `contracts` dependency (`^0.7.0`), because the
package was published from a workstation, by hand, out of sync with the
source. This patch carries no functional change; it exists solely to get a
correct archive onto the registry under a new version, since an
already-published version is never overwritten.
