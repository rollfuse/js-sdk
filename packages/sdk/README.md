# @rollfuse/sdk-js

> **Renamed from `@growth-ops/sdk-js`.** The package identifier and the
> exported `GrowthOpsClient` class changed name — `GrowthOpsClient` is now
> `RollfuseClient`. The client's behavior did not change; update your
> `package.json` dependency, imports, and the constructor name.

The Node.js SDK for rollfuse: evaluates feature flags
locally against cached, versioned configuration (ADR 0004: Evaluate Flags
Locally in SDKs), instead of calling the API synchronously on every
evaluation.

Server-side only — it holds a Service Credential secret, so it targets
Node.js backends (Express apps, Next.js API routes, workers, etc.), not
browsers. See `openspec/specs/sdk-js/spec.md` for its full behavioral
contract.

## Install

```bash
npm install @rollfuse/sdk-js
```

## Usage

```ts
import { RollfuseClient } from "@rollfuse/sdk-js";

const client = new RollfuseClient({
  baseUrl: "https://api.rollfuse.com",
  credential: process.env.GROWTH_OPS_CREDENTIAL!, // read wherever you keep secrets; the SDK never reads it itself
});

// Optional: wait for the first Configuration fetch before serving traffic.
// Skip this and rely on `fallback` below if you don't want to block startup.
await client.start();

const result = client.evaluate("user_123", "checkout-redesign", {
  attributes: { plan: "enterprise" },
  fallback: false, // used only if no Configuration is cached yet
});

if (result.value) {
  // serve the new checkout flow
}

// On shutdown: stop background polling and flush any queued exposures.
await client.close();
```

`evaluate`/`evaluateAll` are synchronous — no network call is made once a
Configuration is cached, per ADR 0004. Exposures produced by a rule-matched
evaluation are reported back to the platform asynchronously, in batches,
without adding latency to the call that produced them.

## Configuration

All options besides `baseUrl` and `credential` are optional:

| Option | Default | Purpose |
|---|---|---|
| `refreshIntervalMs` | `30000` | Interval between successful Configuration refreshes |
| `maxConfigAgeMs` | unset | If set, `evaluate`/`evaluateAll` treat the cache as absent once older than this |
| `exposureQueueCapacity` | `1000` | Maximum queued-but-unsubmitted exposures |
| `exposureBatchSize` | `100` | Queue length that triggers an early submission |
| `exposureFlushIntervalMs` | `5000` | Interval between periodic exposure-batch flushes |
| `onConfigRefreshed(version)` | — | Called after each successful refresh |
| `onConfigRefreshError(error)` | — | Called after each failed or invalid refresh |
| `onExposureDropped(count)` | — | Called when exposures are dropped due to a full queue |
| `onExposureSubmitError(error)` | — | Called when a batch of exposures fails to submit |

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build   # emits dist/ (gitignored), a dual ESM+CJS build via tsup
```

Depends on `@rollfuse/contracts` (published separately to npm) for its
request/response types.
