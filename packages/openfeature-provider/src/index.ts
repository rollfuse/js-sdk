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
  OpenFeatureEventEmitter,
  ProviderNotReadyError,
  ServerProviderEvents,
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
  /**
   * Emits `PROVIDER_CONFIGURATION_CHANGED` whenever the wrapped client's
   * Configuration changes (task 10.1). `PROVIDER_READY`/`PROVIDER_ERROR`
   * need no wiring here: `@openfeature/server-sdk` emits them itself from
   * `initialize()`'s own outcome (task 10.2) — see this class's own
   * `initialize` doc comment.
   */
  readonly events = new OpenFeatureEventEmitter();

  readonly #client: RollfuseClient;
  #unsubscribe: (() => void) | undefined;

  constructor(client: RollfuseClient) {
    this.#client = client;
  }

  /**
   * Starts the wrapped client, blocking until the first Configuration
   * fetch succeeds or rejects. Subscribes to the client's own Configuration
   * changes first, so a change that lands mid-`start()` (the first fetch
   * itself) is never missed. `@openfeature/server-sdk` reports readiness
   * accurately (task 10.2) from this method's own outcome alone —
   * resolving fires `PROVIDER_READY`, rejecting fires `PROVIDER_ERROR` —
   * with no separate `status` field for this provider to maintain (the
   * SDK's own `CommonProvider.status` is deprecated for exactly this
   * reason: "the SDK now maintains the provider's state").
   */
  async initialize(): Promise<void> {
    this.#unsubscribe = this.#client.subscribe(() => {
      this.events.emit(ServerProviderEvents.ConfigurationChanged);
    });

    await this.#client.start();
  }

  /** Unsubscribes from the wrapped client and stops its background refresh and exposure-flush loops. */
  async onClose(): Promise<void> {
    this.#unsubscribe?.();
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

    const attributes = stringAttributes(context, logger);

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
 * string. A non-string attribute (a number, boolean, nested object)
 * cannot be represented in rollfuse's attribute model, which is excluded
 * rather than coerced with `String(...)` — that would let e.g. attribute
 * values `"true"` (string) and `true` (boolean) match a rule condition
 * meant for only one of them — and reported through `logger` (task 10.3:
 * the diagnostic path for a context value the attribute model can't
 * represent) rather than discarded silently. Returns `undefined` (not an
 * empty object) when there are no string attributes, so
 * `client.evaluate` isn't called with a needless empty `attributes`
 * option.
 */
function stringAttributes(context: EvaluationContext, logger: Logger): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};
  let hasAny = false;

  for (const [key, value] of Object.entries(context)) {
    if (key === "targetingKey") {
      continue;
    }

    if (typeof value === "string") {
      attrs[key] = value;
      hasAny = true;

      continue;
    }

    logger.warn(
      `rollfuse's attribute model only represents string values; evaluation context key "${key}" has type "${typeof value}" and was excluded from rule matching rather than coerced`,
    );
  }

  return hasAny ? attrs : undefined;
}
