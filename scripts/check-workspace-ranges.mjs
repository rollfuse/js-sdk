#!/usr/bin/env node
// restore-sdk-release-pipeline task 3.2: fails when a package's declared
// dependency on a workspace sibling no longer resolves to that sibling's
// current version. This is what stopped `js-sdk` v0.7.0 of @rollfuse/contracts
// from ever reaching any consumer for months — every dependent package
// declared a range five minor versions behind, which `npm install` silently
// satisfied by installing an old published copy instead of linking the
// workspace, and nothing failed because nothing checked.
//
// Deliberately re-derives "does it resolve" from the same rule npm itself
// uses (semver range satisfaction), rather than trusting package-lock.json's
// own recorded resolution — the lockfile itself was the thing found stale
// (recording contracts at 0.6.1 while package.json already said 0.7.0) the
// one time this was audited by hand, so checking against it would have kept
// passing on exactly the state this check exists to catch.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { satisfies } from "semver";

const packagesDir = new URL("../packages", import.meta.url).pathname;

const manifests = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const path = join(packagesDir, entry.name, "package.json");
    return { dir: entry.name, path, manifest: JSON.parse(readFileSync(path, "utf8")) };
  });

const versionByName = new Map(manifests.map(({ manifest }) => [manifest.name, manifest.version]));

let failures = 0;

for (const { dir, manifest } of manifests) {
  for (const field of ["dependencies", "peerDependencies"]) {
    const deps = manifest[field] ?? {};

    for (const [depName, range] of Object.entries(deps)) {
      const currentVersion = versionByName.get(depName);
      if (currentVersion === undefined) continue; // not a workspace sibling

      if (!satisfies(currentVersion, range)) {
        console.error(
          `✗ packages/${dir}: ${field}["${depName}"] = "${range}" does not resolve to ` +
            `the workspace's current ${depName}@${currentVersion} — a clean install would ` +
            `link a stale published copy instead of this workspace.`,
        );
        failures += 1;
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} sibling dependency range(s) do not resolve to the workspace.`);
  process.exit(1);
}

console.log("✓ every sibling dependency range resolves to its workspace version");
