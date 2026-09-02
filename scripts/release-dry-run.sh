#!/usr/bin/env bash
# Local preflight for a release: builds every package, then runs `npm
# publish --dry-run` for each one and confirms the version it would
# publish is NOT already on the npm registry (a sanity check that would
# have caught, for example, republishing an unchanged version by
# accident). Run this before merging a Changesets "Version Packages" PR,
# or any time you want to sanity-check what `npm run release` (CI's
# `changeset publish` step) is about to do without actually publishing.
#
# Exits non-zero if any package's dry-run fails for a reason other than
# "version already published" (e.g. a real packaging/build problem).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGES=(contracts evaluation-core sdk sdk-browser sdk-react openfeature-provider)

echo "==> Building every package"
(cd "$REPO_ROOT" && npm run build)

status=0

for pkg in "${PACKAGES[@]}"; do
  dir="$REPO_ROOT/packages/$pkg"
  name="$(node -p "require('$dir/package.json').name")"
  version="$(node -p "require('$dir/package.json').version")"

  echo ""
  echo "==> $name@$version"

  set +e
  output="$(cd "$dir" && npm publish --dry-run 2>&1)"
  exit_code=$?
  set -e

  if [ "$exit_code" -eq 0 ]; then
    echo "$output" | tail -5
    echo "would publish: $name@$version (not yet on the registry)"
  elif echo "$output" | grep -q "You cannot publish over the previously published versions"; then
    echo "already published: $name@$version — this is expected when no changeset targets this package"
  else
    echo "$output" >&2
    echo "error: unexpected dry-run failure for $name" >&2
    status=1
  fi
done

exit "$status"
