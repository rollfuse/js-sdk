/** Thrown when `RollfuseClient` is constructed without a `credential`. */
export class CredentialRequiredError extends Error {
  constructor() {
    super(
      "RollfuseClient requires an explicit `credential` option; it is never read from an environment variable or any other ambient source.",
    );
    this.name = "CredentialRequiredError";
  }
}

/**
 * Thrown by `evaluate`/`evaluateAll` when no Configuration has been
 * successfully cached yet (or the cached one is older than
 * `maxConfigAgeMs`, if set) and no `fallback` was supplied.
 */
export class ConfigNotReadyError extends Error {
  constructor(flagKey?: string) {
    super(
      flagKey
        ? `Configuration not yet available; cannot evaluate "${flagKey}" without a fallback value.`
        : "Configuration not yet available; cannot evaluate without a fallback value.",
    );
    this.name = "ConfigNotReadyError";
  }
}

/**
 * Thrown by `evaluate` when `flagKey` does not exist in the cached
 * Configuration's own Project (mirroring `POST /v1/evaluate`'s 404 for an
 * unknown flag key) and no `fallback` was supplied.
 */
export class FlagNotFoundError extends Error {
  constructor(flagKey: string) {
    super(`Feature flag "${flagKey}" was not found in the cached Configuration.`);
    this.name = "FlagNotFoundError";
  }
}
