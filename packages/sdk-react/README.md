# @rollfuse/sdk-react

React/Next.js consumption layer for [rollfuse](https://rollfuse.com)
feature flags: a Provider fed by **server-evaluated** results, plus
`useFlag`/`useFlags` hooks. It never imports `@rollfuse/sdk-js` and never
accepts a Service Credential — that boundary is structural, not just
documented, so this package can be safely bundled into browser code.
Hydration-stable by design: the variation your server rendered is the same
variation your client reads, no flicker.

Part of the [rollfuse JS/TS SDK family](https://github.com/rollfuse/js-sdk)
— see that repo's README if you're not sure which package you want.

See `openspec/specs/sdk-react/spec.md` for its full behavioral contract.

## Why this package never talks to the platform directly

`@rollfuse/sdk-js`'s `RollfuseClient` requires a Service Credential — a
secret, Environment-scoped bearer token meant for server processes only (see
`openspec/specs/service-credentials/spec.md`). Shipping it to a browser
bundle would violate that credential's own model. Until the platform has a
browser-safe public credential (tracked separately), this package's Provider
is fed evaluation results your Next.js **server** already computed, and its
exposure-reporting helper posts to an endpoint **you** control server-side,
never to the platform API directly.

## Install

```bash
npm install @rollfuse/sdk-react
```

`react` is a peer dependency — install whatever version your app already
uses (18+).

## Usage

### 1. Evaluate flags server-side

In a Next.js server module (never imported by Client Component code):

```ts
// src/lib/rollfuse-server.ts
import { RollfuseClient } from "@rollfuse/sdk-js";

const client = new RollfuseClient({
  baseUrl: process.env.API_BASE_URL!,
  credential: process.env.ROLLFUSE_SERVICE_CREDENTIAL!, // server-only — never NEXT_PUBLIC_*
});

export function getRollfuseClient() {
  return client;
}
```

### 2. Wrap your tree in `RollfuseProvider` from a Server Component

```tsx
// app/(app)/layout.tsx
import { RollfuseProvider } from "@rollfuse/sdk-react";
import { getRollfuseClient } from "@/lib/rollfuse-server";

export default async function Layout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  await getRollfuseClient().start();
  const evaluations = getRollfuseClient().evaluateAll(session.member.id);

  return <RollfuseProvider evaluations={evaluations}>{children}</RollfuseProvider>;
}
```

Use a subject key that is **stable across server render and client
hydration** — an authenticated user's id, or a first-party anonymous-visitor
cookie set server-side. A subject key that differs between the server render
and the client's first paint can flip which variation is shown right after
hydration.

### 3. Read flags from Client Components

```tsx
"use client";
import { useFlag } from "@rollfuse/sdk-react";

function CheckoutButton() {
  const { value } = useFlag("checkout-redesign", { fallback: false });

  return value ? <NewCheckoutButton /> : <LegacyCheckoutButton />;
}
```

- `useFlag(flagKey, { fallback })` returns the flag's `EvaluationResult` if
  present, or a `default_fallback`-tagged result built from `fallback` if
  not. With no `fallback` and no matching result, it throws
  `FlagNotFoundError`.
- `useFlags()` returns every `EvaluationResult` the Provider holds, keyed by
  flag key.
- Either hook throws `MissingProviderError` if called outside a mounted
  `RollfuseProvider` — a missing Provider fails loudly rather than silently
  returning empty results.

### 4. Reporting a client-triggered exposure

If a Client Component re-evaluates using browser-only attributes and needs to
report the resulting exposure, send it through **your own** server route,
never straight to the platform:

```ts
// app/api/rollfuse/exposure/route.ts
export async function POST(request: Request) {
  const payload = await request.json();

  await fetch(`${process.env.API_BASE_URL}/v1/exposure-events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ROLLFUSE_SERVICE_CREDENTIAL}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      events: [{ /* map payload to the platform's ExposureEventSubmission shape */ }],
    }),
  });

  return Response.json({ ok: true }, { status: 202 });
}
```

```tsx
"use client";
import { reportExposure } from "@rollfuse/sdk-react";

reportExposure("/api/rollfuse/exposure", {
  flagKey: "checkout-redesign",
  subjectKey: currentSubjectKey,
  variationKey: "treatment",
  reason: "rule_match",
  configVersion: 1,
});
```

`reportExposure` never throws — a failed report (network error, non-2xx
response) is only visible via its optional `onError` callback, and must never
block or alter what the UI has already rendered.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build   # emits dist/ (gitignored), a dual ESM+CJS build via tsup
```

Depends on `@rollfuse/contracts` (published separately to npm) for the
`EvaluationResult` type.

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
