# @rollfuse/sdk-browser

The browser SDK for [rollfuse](https://rollfuse.com): evaluates feature
flags directly in client-side JavaScript, locally against cached, versioned
configuration — the same deterministic bucketing/evaluation algorithm
`@rollfuse/sdk-js` uses, shared via `@rollfuse/evaluation-core` so the two
packages can never silently drift. No proxy, no server round trip on the
evaluation path — just a fetch of published configuration, and every
`evaluate()` call after that is synchronous.

Part of the [rollfuse JS/TS SDK family](https://github.com/rollfuse/js-sdk)
— see that repo's README if you're not sure which package you want.

## Public Credential only — never a regular Service Credential

This package is meant to be embedded in browser-visible code, so it will
only ever work with a **Public Credential**: a Credential issued with the
`public` option set, which the platform restricts to exactly the
`config:read` scope (see `service-credentials`' "Public Issuance Mode
Restricted To config:read"). A regular Service Credential is a broader,
unscoped-by-design secret never meant to leave a server — do not paste one
here.

Every option in this package that accepts a credential is named
`publicCredential`, never `credential`, precisely so its shape never reads
as accepting a regular Service Credential (see `sdk-react`'s "Browser-Side
Evaluation Never Uses A Non-Public Credential" requirement). This package
cannot verify server-side that a token you pass it is actually Public —
that guarantee comes from issuing it correctly in the first place, via the
console's Credentials screen ("Issue as Public").

### The trade-off you're accepting

A Public Credential is safe to leak by design, not by obscurity — least
privilege, not secrecy:

- It can only read published configuration (`GET /v1/config`), evaluate
  flags, and submit exposure events. It cannot read or write anything
  else.
- Anyone inspecting your page's network traffic can see your flag
  targeting rules (rule conditions, rollout percentages, variation
  values) once your browser fetches them. This is the same trade-off
  every client-side flag SDK on the market makes.
- A leaked Public Credential is not a security incident requiring
  emergency revocation — revoke it if you want to rotate it, but there is
  no unscoped-secret blast radius to contain.

If that trade-off doesn't fit your use case (e.g. you need to keep
targeting rules private), evaluate flags server-side with
`@rollfuse/sdk-js` instead and pass the results down as props (see
`@rollfuse/sdk-react`'s server-evaluated-props mode).

## Install

```bash
npm install @rollfuse/sdk-browser
```

## Usage

```ts
import { RollfusePublicClient } from "@rollfuse/sdk-browser";

const client = new RollfusePublicClient({
  baseUrl: "https://api.rollfuse.com",
  publicCredential: "svc_...", // a Credential issued with the Public option — never a regular Service Credential
});

// Optional: wait for the first Configuration fetch before evaluating.
// Skip this and rely on `fallback` below if you don't want to block render.
await client.start();

const result = client.evaluate("user_123", "checkout-redesign", {
  attributes: { plan: "enterprise" },
  fallback: false, // used only if no Configuration is cached yet
});

if (result.value) {
  // render the new checkout flow
}

// On unmount/page unload: stop background polling and flush any queued exposures.
await client.close();
```

`evaluate`/`evaluateAll` are synchronous — no network call is made once a
Configuration is cached. Exposures produced by a rule-matched evaluation
are reported back to the platform asynchronously, in small batches,
without adding latency to the call that produced them.

## Configuration

All options besides `baseUrl` and `publicCredential` are optional. Browser
defaults are smaller than `@rollfuse/sdk-js`'s server-side ones: a browser
tab's lifetime is typically much shorter than a long-lived server process,
so exposures flush sooner rather than risk being lost when the tab closes.

| Option | Default | Purpose |
|---|---|---|
| `refreshIntervalMs` | `30000` | Interval between successful Configuration refreshes |
| `maxConfigAgeMs` | unset | If set, `evaluate`/`evaluateAll` treat the cache as absent once older than this |
| `exposureQueueCapacity` | `1000` | Maximum queued-but-unsubmitted exposures |
| `exposureBatchSize` | `20` | Queue length that triggers an early submission |
| `exposureFlushIntervalMs` | `2000` | Interval between periodic exposure-batch flushes |
| `fetchImpl` | the browser's global `fetch` | Injectable for tests |
| `onConfigRefreshed(version)` | — | Called after each successful refresh |
| `onConfigRefreshError(error)` | — | Called after each failed or invalid refresh |
| `onExposureDropped(count)` | — | Called when exposures are dropped due to a full queue |
| `onExposureSubmitError(error)` | — | Called when a batch of exposures fails to submit |

## Cross-origin requests (CORS)

`GET /v1/config`, `POST /v1/evaluate` and `POST /v1/exposure-events`
accept cross-origin browser requests, but the response is only
browser-readable (carries a CORS grant) when it was authenticated with a
Public Credential — see `feature-evaluation-delivery`'s "Browser
Reachability For Public Credentials". You don't need to configure
anything for this; it's automatic based on which Credential you use.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build   # emits dist/ (gitignored), a dual ESM+CJS build via tsup, browser target, no Node built-ins
```

Depends on `@rollfuse/contracts` and `@rollfuse/evaluation-core`
(published separately to npm).

### Publishing

This repo uses [Changesets](https://github.com/changesets/changesets) for
independent per-package versioning:

```bash
npx changeset            # describe your change, pick which package(s) and bump level
# commit the generated .changeset/*.md file(s) with your PR
```

Merging to `main` opens or updates a "Version Packages" PR that applies
every pending changeset (bumps `version`, updates `CHANGELOG.md`).
Merging *that* PR publishes every package whose version changed to npm,
automatically, via `.github/workflows/release.yml` (`NPM_TOKEN` configured
as a repo secret) — no manual `npm publish` step.
