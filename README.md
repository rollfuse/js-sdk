# rollfuse JS/TS SDK

Feature flags, progressive delivery, and experimentation for JavaScript and
TypeScript — server, browser, and React, all evaluating flags **locally**
against cached, versioned configuration instead of making a network round
trip on every check. No SDK-side network call on the hot path means no
added latency and no new failure mode on your request path: if the platform
is briefly unreachable, evaluation keeps working off the last-known-good
configuration.

This repository is the whole JS/TS family in one place: the shared
primitives, the server SDK, the browser SDK, and the React bindings — five
independently published packages that never drift from each other, because
they're built and tested together.

## Which package do I want?

| I'm building... | Install | Needs |
|---|---|---|
| A Node.js backend (Express, Fastify, a worker, a Next.js API route) | [`@rollfuse/sdk-js`](packages/sdk/) | A Service Credential (server-only secret) |
| Client-side JavaScript that evaluates flags directly in the browser | [`@rollfuse/sdk-browser`](packages/sdk-browser/) | A Public Credential (safe to ship to a browser bundle) |
| A Next.js / React app, fed by server-evaluated flags | [`@rollfuse/sdk-react`](packages/sdk-react/) | A server already using `@rollfuse/sdk-js` |
| Raw TypeScript types for the platform API, no evaluation logic | [`@rollfuse/contracts`](packages/contracts/) | Nothing — it's just types + a runtime validator |

Most apps want exactly one of the first three. `@rollfuse/contracts` and
`@rollfuse/evaluation-core` are the shared foundation the SDKs are built
on — you install them directly only if you're building your own
integration on top of the platform's API.

## Quick start

**Server (Node.js):**

```bash
npm install @rollfuse/sdk-js
```

```ts
import { RollfuseClient } from "@rollfuse/sdk-js";

const client = new RollfuseClient({
  baseUrl: "https://api.rollfuse.com",
  credential: process.env.ROLLFUSE_SERVICE_CREDENTIAL!,
});

await client.start();

const result = client.evaluate("user_123", "checkout-redesign", { fallback: false });
```

**Browser:**

```bash
npm install @rollfuse/sdk-browser
```

```ts
import { RollfusePublicClient } from "@rollfuse/sdk-browser";

const client = new RollfusePublicClient({
  baseUrl: "https://api.rollfuse.com",
  publicCredential: "svc_...", // issued with the Public option — safe to ship to a browser bundle
});

await client.start();

const result = client.evaluate("user_123", "checkout-redesign", { fallback: false });
```

**React / Next.js**, fed by a server-evaluated result:

```bash
npm install @rollfuse/sdk-react
```

```tsx
"use client";
import { useFlag } from "@rollfuse/sdk-react";

function CheckoutButton() {
  const { value } = useFlag("checkout-redesign", { fallback: false });
  return value ? <NewCheckoutButton /> : <LegacyCheckoutButton />;
}
```

Each package's own README covers configuration options, credential
scoping, and the full integration pattern (server-evaluated bootstrap,
hydration-stable subject keys, exposure reporting) in depth — start there
once you know which one you need.

## Why local evaluation

Every SDK in this family resolves a flag to a variation entirely from a
cached, versioned Configuration — no network call on the evaluation path.
`evaluate`/`evaluateAll` are synchronous, safe for concurrent use, and keep
returning results using the last successfully fetched configuration if the
platform becomes unreachable. Exposure events (which variation a subject
actually saw) are reported back asynchronously, in batches, after the
call that produced them — so telemetry never adds latency to a request.

The bucketing algorithm behind rollout percentages is deterministic and
identical across every SDK in this family (and the [Go SDK](https://github.com/rollfuse/go-sdk)):
the same flag, subject key, and Configuration Version always resolve to the
same variation, everywhere.

## What's in this repo

An npm workspaces monorepo — five independently versioned packages, built
and released together:

- **[`packages/contracts`](packages/contracts/)** — TypeScript types
  generated from the platform's OpenAPI document, plus a runtime schema
  validator. The types every other package (and this SDK family's
  consumers) is built on.
- **[`packages/evaluation-core`](packages/evaluation-core/)** — the
  dependency-free, browser-and-Node-safe deterministic evaluation and
  bucketing algorithm, shared by the server and browser SDKs so they can
  never silently drift from each other.
- **[`packages/sdk`](packages/sdk/)** (published as `@rollfuse/sdk-js`) —
  the Node.js server SDK.
- **[`packages/sdk-browser`](packages/sdk-browser/)** — the browser SDK,
  Public-Credential-only by construction.
- **[`packages/sdk-react`](packages/sdk-react/)** — React/Next.js
  bindings: a Provider and `useFlag`/`useFlags` hooks.

## Development

```bash
npm install    # installs all five packages, linked to each other via npm workspaces
npm run build  # builds contracts and evaluation-core first, then the three SDKs
npm run typecheck
npm run lint
npm test
```

Each package still ships and versions independently — see its own README
for its release process. A local change to `evaluation-core` is picked up
immediately by `sdk`/`sdk-browser`/`sdk-react` in this repo (real
workspace links, not a registry round trip); publishing is what makes that
change visible to everyone else.
