/**
 * OpenFeature server-side provider for rollfuse (github.com/open-feature/js-sdk's
 * `@openfeature/server-sdk`), backed by `@rollfuse/sdk-js`, so an
 * application already using OpenFeature (or wanting the vendor-neutral
 * option of switching away from rollfuse later without touching call
 * sites) can point `OpenFeature.setProviderAndWait` at rollfuse without
 * learning `RollfuseClient`'s own API.
 *
 * Every evaluation still runs entirely against sdk-js's locally cached,
 * versioned Configuration — no network call, no added latency — this
 * package only translates between the two APIs' shapes: OpenFeature's
 * per-type `resolve*Evaluation` methods and `EvaluationContext` on one
 * side, `RollfuseClient.evaluate` and `EvaluationResult` on the other.
 */
import type {
  EvaluationContext,
  JsonValue,
  Logger,
  Provider,
  ResolutionDetails,
} from "@openfeature/server-sdk";
import {
  FlagNotFoundError,
  GeneralError,
  ProviderNotReadyError,
  StandardResolutionReasons,
  TargetingKeyMissingError,
  TypeMismatchError,
} from "@openfeature/server-sdk";
import {
  ConfigNotReadyError as RollfuseConfigNotReadyError,
  FlagNotFoundError as RollfuseFlagNotFoundError,
  type RollfuseClient,
} from "@rollfuse/sdk-js";

/**
 * Adapts a `RollfuseClient` to `@openfeature/server-sdk`'s `Provider`
 * interface. Construct the client exactly as you would to use it
 * directly (see `@rollfuse/sdk-js`'s own README), then hand it to this
 * class instead of calling `client.start`/`client.evaluate` yourself —
 * `OpenFeature.setProviderAndWait` calls `initialize`, which starts it.
 */
export class RollfuseProvider implements Provider {
  readonly metadata = { name: "rollfuse" } as const;
  readonly runsOn = "server" as const;

  readonly #client: RollfuseClient;

  constructor(client: RollfuseClient) {
    this.#client = client;
  }

  /** Starts the wrapped client, blocking until the first Configuration fetch succeeds. */
  async initialize(): Promise<void> {
    await this.#client.start();
  }

  /** Stops the wrapped client's background refresh and exposure-flush loops. */
  async onClose(): Promise<void> {
    await this.#client.close();
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<boolean>> {
    return this.#resolve(flagKey, defaultValue, context, logger);
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<string>> {
    return this.#resolve(flagKey, defaultValue, context, logger);
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<number>> {
    return this.#resolve(flagKey, defaultValue, context, logger);
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<T>> {
    return this.#resolve(flagKey, defaultValue, context, logger);
  }

  /**
   * The one place that actually calls the wrapped `RollfuseClient`,
   * shared by every `resolve*Evaluation` method above.
   *
   * Deliberately never passes a `fallback` option to `client.evaluate` —
   * sdk-js treats a supplied fallback as "never throw, synthesize a
   * default_fallback result instead" for both an unready cache
   * (`ConfigNotReadyError`) and an unknown flag key (`FlagNotFoundError`)
   * (see `RollfuseClient.evaluate`'s own source) — which would mask both
   * entirely and make it impossible for this provider to ever report
   * OpenFeature's `PROVIDER_NOT_READY`/`FLAG_NOT_FOUND` error codes, a
   * real OpenFeature spec requirement. Every `resolve*Evaluation` method
   * already receives its own `defaultValue` from the OpenFeature client;
   * that's the one this provider falls back to, with the correct error
   * code attached (thrown, per this SDK's own convention — see
   * `InMemoryProvider` in `@openfeature/server-sdk` for the same
   * pattern).
   */
  async #resolve<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<T>> {
    const subjectKey = context.targetingKey;

    if (!subjectKey) {
      const message = "rollfuse requires a non-empty targetingKey in the evaluation context (it becomes the flag's subject key)";

      logger.debug(message);
      throw new TargetingKeyMissingError(message);
    }

    const attributes = stringAttributes(context);

    let result;

    try {
      result = this.#client.evaluate(subjectKey, flagKey, attributes ? { attributes } : {});
    } catch (err) {
      if (err instanceof RollfuseConfigNotReadyError) {
        logger.debug(err.message);
        throw new ProviderNotReadyError(err.message);
      }

      if (err instanceof RollfuseFlagNotFoundError) {
        logger.debug(err.message);
        throw new FlagNotFoundError(err.message);
      }

      const message = err instanceof Error ? err.message : String(err);

      logger.error(message);
      throw new GeneralError(message);
    }

    if (typeof result.value !== typeof defaultValue) {
      throw new TypeMismatchError(
        `flag "${flagKey}"'s variation "${result.variation_key}" did not decode into the requested type`,
      );
    }

    return {
      value: result.value as T,
      variant: result.variation_key,
      reason: reasonFor(result.reason),
    };
  }
}

/**
 * Maps sdk-js's `EvaluationReason` enum to OpenFeature's
 * `StandardResolutionReasons`. "default_fallback" (a matched rule whose
 * outcome couldn't be resolved — should not happen for validly-
 * constructed configuration) maps to `DEFAULT` rather than a new
 * OpenFeature reason, since OpenFeature has no equivalent concept and the
 * practical effect is the same: a default-ish value was served, not a
 * targeted one.
 */
function reasonFor(reason: string): string {
  switch (reason) {
    case "rule_match":
      return StandardResolutionReasons.TARGETING_MATCH;
    case "default_disabled":
      return StandardResolutionReasons.DISABLED;
    case "default_no_rule_match":
    case "default_fallback":
      return StandardResolutionReasons.DEFAULT;
    default:
      return StandardResolutionReasons.UNKNOWN;
  }
}

/**
 * Converts an OpenFeature `EvaluationContext` into the
 * `Record<string, string>` `RollfuseClient.evaluate`'s `attributes`
 * option expects (rule matching is strict string equality — see
 * `@rollfuse/sdk-js`'s own README), excluding `targetingKey` (already
 * consumed as the subject key) and any value that isn't already a
 * string. A non-string attribute (a number, boolean, nested object) is
 * excluded rather than coerced with `String(...)`, which would let e.g.
 * attribute values `"true"` (string) and `true` (boolean) match a rule
 * condition meant for only one of them. Returns `undefined` (not an
 * empty object) when there are no string attributes, so
 * `client.evaluate` isn't called with a needless empty `attributes`
 * option.
 */
function stringAttributes(context: EvaluationContext): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};
  let hasAny = false;

  for (const [key, value] of Object.entries(context)) {
    if (key === "targetingKey") {
      continue;
    }

    if (typeof value === "string") {
      attrs[key] = value;
      hasAny = true;
    }
  }

  return hasAny ? attrs : undefined;
}
