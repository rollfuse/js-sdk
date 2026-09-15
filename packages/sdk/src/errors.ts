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

/**
 * Thrown by `evaluate` when `flagKey` uses a configuration construct newer
 * than this client's own CLIENT_FORMAT_VERSION declares support for (the
 * platform marks such a flag `non_evaluable` and withholds its
 * rules/variations). No `fallback` was supplied — per
 * expand-targeting-model task 3.3, there is no legitimate default value
 * this client can derive for a flag definition it was never shown, so
 * this behaves like `FlagNotFoundError`, not `evaluateFlag`'s own
 * default-variation fallback path.
 */
export class FlagNotEvaluableError extends Error {
  constructor(flagKey: string) {
    super(`Feature flag "${flagKey}" requires a newer client to evaluate.`);
    this.name = "FlagNotEvaluableError";
  }
}

/**
 * Rejects `start()`'s returned Promise when the platform cannot be
 * reached (or does not respond successfully) within `initTimeoutMs` of
 * the first `start()` call. Per sdk-conformance's "Initialization
 * Completes Or Fails Within A Bounded Time" requirement: this does not
 * stop background polling, which keeps retrying so a later recovery still
 * populates the cache for subsequent `evaluate()` calls, but the
 * integrator's own await on `start()` is not left hanging indefinitely.
 */
export class InitializationTimeoutError extends Error {
  constructor(initTimeoutMs: number) {
    super(
      `Initialization did not complete within ${initTimeoutMs}ms: the platform could not be reached or did not respond successfully in time.`,
    );
    this.name = "InitializationTimeoutError";
  }
}

/**
 * Rejects `start()`'s returned Promise immediately, without retry, when
 * the platform rejects the credential as unauthenticated (401) or
 * unauthorized (403). Per sdk-conformance's "The credential is rejected"
 * scenario: retrying a rejected credential can only ever produce the same
 * rejection, so background polling stops rather than retrying forever.
 */
export class CredentialRejectedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      `The platform rejected the configured credential (HTTP ${status}). Initialization will not be retried; verify the credential and construct a new client.`,
    );
    this.name = "CredentialRejectedError";
    this.status = status;
  }
}
