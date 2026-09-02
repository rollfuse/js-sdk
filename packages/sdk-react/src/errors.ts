/**
 * Thrown by `useFlag` when a flag key is absent from the Provider's
 * evaluations and no `fallback` was supplied, per the `sdk-react` spec's
 * "Reading a flag not present in the results" scenario. Distinguishable
 * from `MissingProviderError` so callers (and tests) can tell "no
 * Provider mounted" apart from "Provider mounted, flag key unknown".
 */
export class FlagNotFoundError extends Error {
  constructor(flagKey: string) {
    super(`Rollfuse: no evaluation result for flag "${flagKey}" and no fallback was provided.`);
    this.name = "FlagNotFoundError";
  }
}

/**
 * Thrown by `useFlag`/`useFlags` when called outside a mounted
 * `RollfuseProvider`, per the spec's "Consuming Without a Provider Is an
 * Error" requirement — a missing Provider must fail loudly rather than
 * silently returning an empty/default result.
 */
export class MissingProviderError extends Error {
  constructor(hookName: string) {
    super(`Rollfuse: ${hookName}() was called outside a <RollfuseProvider>.`);
    this.name = "MissingProviderError";
  }
}
