/** Thrown when `RollfusePublicClient` is constructed without a `publicCredential`. */
export class PublicCredentialRequiredError extends Error {
  constructor() {
    super(
      "RollfusePublicClient requires an explicit `publicCredential` option — a Credential issued as Public (config:read only). It is never read from an environment variable or any other ambient source, and this package never accepts a regular Service Credential.",
    );
    this.name = "PublicCredentialRequiredError";
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
