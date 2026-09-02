# @rollfuse/openfeature-provider

Use [OpenFeature](https://openfeature.dev)'s vendor-neutral JS/TS server
SDK against [rollfuse](https://rollfuse.com) — evaluate flags through the
standard `OpenFeature.getClient()` API, backed by `@rollfuse/sdk-js`'s
local, deterministic evaluation underneath. Same zero-network-call-per-check
behavior as using the SDK directly; this package is a thin adapter, not a
different evaluation engine.

Part of the [rollfuse JS/TS SDK family](https://github.com/rollfuse/js-sdk)
— server-side only, like `@rollfuse/sdk-js` itself (it holds a Service
Credential secret). There's a Go equivalent too:
[`rollfuse/openfeature-provider`](https://github.com/rollfuse/openfeature-provider).

## Install

```bash
npm install @rollfuse/openfeature-provider @rollfuse/sdk-js @openfeature/server-sdk
```

## Usage

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { RollfuseClient } from "@rollfuse/sdk-js";
import { RollfuseProvider } from "@rollfuse/openfeature-provider";

const client = new RollfuseClient({
  baseUrl: "https://api.rollfuse.com",
  credential: process.env.ROLLFUSE_SERVICE_CREDENTIAL!,
});

await OpenFeature.setProviderAndWait(new RollfuseProvider(client));
// blocks until the first Configuration fetch succeeds

const ofClient = OpenFeature.getClient();

const enabled = await ofClient.getBooleanValue("checkout-redesign", false, {
  targetingKey: "user_123",
  plan: "enterprise",
});
```

Every OpenFeature call site from here on is vendor-neutral:
`getBooleanValue`/`getStringValue`/`getNumberValue`/`getObjectValue` and
their `*Details` variants all work, and switching providers later —
evaluating locally with a mock, or moving to a different flag system —
never touches your call sites, only the one `setProviderAndWait` line.

## Why go through OpenFeature instead of `@rollfuse/sdk-js` directly

- **A standard interface your team may already use.** If other services
  in your organization already use OpenFeature against a different flag
  system, this lets rollfuse slot in without introducing a second
  evaluation API to learn.
- **Vendor portability.** `OpenFeature.getClient()` is the same interface
  regardless of which `Provider` is behind it — a real hedge against
  lock-in, not a marketing claim, since the OpenFeature JS SDK is a CNCF
  project maintained independently of rollfuse.
- **OpenFeature's hook/event ecosystem** (logging, metrics, tracing
  integrations built for OpenFeature generically) works with this
  provider for free.

If you don't need either of those, `@rollfuse/sdk-js` directly is simpler
— one fewer dependency, one fewer layer of indirection, and the same
underlying evaluation.

## Evaluation context mapping

| OpenFeature | rollfuse |
|---|---|
| `targetingKey` | The flag's subject key (`client.evaluate(subjectKey, ...)`) — **required**; missing it resolves to your default value with error code `TARGETING_KEY_MISSING`, per the OpenFeature spec |
| Every other string-valued context field | An evaluation attribute (`{ attributes }`) — matched by rules via strict string equality, same as calling the SDK directly |
| A non-string context field (number, boolean, nested object) | **Excluded**, not stringified — a rule condition written for the string `"true"` should never accidentally match the boolean `true` because both got coerced to the same text |

## Error code mapping

| Condition | OpenFeature `ErrorCode` | `reason` |
|---|---|---|
| No `targetingKey` in the evaluation context | `TARGETING_KEY_MISSING` | `ERROR` |
| No Configuration cached yet (`ConfigNotReadyError`) | `PROVIDER_NOT_READY` | `ERROR` |
| Flag key not found in the cached Configuration (`FlagNotFoundError`) | `FLAG_NOT_FOUND` | `ERROR` |
| The flag's variation value doesn't decode into the requested type | `TYPE_MISMATCH` | `ERROR` |
| A rule matched | — | `TARGETING_MATCH` |
| Flag disabled, or no rule matched, default served | — | `DEFAULT` |

This provider deliberately never passes a `fallback` option to the
underlying client's `evaluate` call — see `src/index.ts`'s `#resolve`
doc comment for why: `@rollfuse/sdk-js`'s own `fallback` option is
designed to make "config not ready" and "flag not found" *never* throw,
which would make it impossible for this provider to ever report
`PROVIDER_NOT_READY`/`FLAG_NOT_FOUND` — a real OpenFeature spec
requirement. Every `resolve*Evaluation` method already receives its own
`defaultValue` from the OpenFeature client; that's the one this provider
falls back to, with the correct error code attached.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build   # emits dist/ (gitignored), a dual ESM+CJS build via tsup
```

Depends on `@rollfuse/sdk-js` (published separately to npm) and
`@openfeature/server-sdk` (a peer dependency — install whatever version
your app already uses, `>=1.16`).

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
