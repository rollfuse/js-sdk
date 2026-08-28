import type { EvaluationResult } from "@rollfuse/contracts";
import { useContext } from "react";
import { RollfuseContext } from "./context.js";
import { FlagNotFoundError, MissingProviderError } from "./errors.js";

export interface UseFlagOptions<T = unknown> {
  /**
   * Returned (never as a rule match, always `reason: "default_fallback"`)
   * when the flag key is absent from the Provider's evaluations, mirroring
   * `@rollfuse/sdk-js`'s `RollfuseClient.evaluate` fallback semantics.
   *
   * Also the anchor `useFlag`'s `T` infers from: `EvaluationResult.value`
   * is `unknown` in `@rollfuse/contracts` (generated from the OpenAPI
   * spec, which can't know a given flag's value shape ahead of time), so
   * there is no per-flag-key type registry to infer from instead. Passing
   * `{ fallback: false }` narrows `result.value` to `boolean` the same way
   * LaunchDarkly's `variation(key, defaultValue: T): T` does — a
   * developer-asserted expectation, not a runtime-checked guarantee: if
   * the flag's real configured value turns out not to match `T`'s shape,
   * this type doesn't catch that.
   */
  fallback?: T;
}

/**
 * Reads one flag's `EvaluationResult` from the nearest `RollfuseProvider`.
 * Throws `MissingProviderError` if no Provider is mounted, and
 * `FlagNotFoundError` if the flag key is absent and no `fallback` was
 * given, per the `sdk-react` spec.
 *
 * `T` (default `unknown`) is inferred from `options.fallback` and narrows
 * `value`'s type on the returned `EvaluationResult` — see `UseFlagOptions`.
 * Omitting `fallback` leaves `value: unknown`, unchanged from before this
 * generic existed.
 */
export function useFlag<T = unknown>(
  flagKey: string,
  options: UseFlagOptions<T> = {},
): EvaluationResult & { value: T } {
  const context = useContext(RollfuseContext);

  if (!context) {
    throw new MissingProviderError("useFlag");
  }

  const result = context.evaluations[flagKey];

  if (result) {
    // The Provider's evaluations are untyped EvaluationResults (`value:
    // unknown`) — this assertion is the same developer-asserted trust as
    // the fallback branch below, not a narrower runtime guarantee.
    return result as EvaluationResult & { value: T };
  }

  if (Object.hasOwn(options, "fallback")) {
    return {
      flag_key: flagKey,
      variation_key: "",
      value: options.fallback as T,
      reason: "default_fallback",
      config_version: 0,
      track_exposure: false,
    };
  }

  throw new FlagNotFoundError(flagKey);
}

/**
 * Reads every `EvaluationResult` the nearest `RollfuseProvider` holds,
 * keyed by flag key. Throws `MissingProviderError` if no Provider is
 * mounted.
 */
export function useFlags(): Record<string, EvaluationResult> {
  const context = useContext(RollfuseContext);

  if (!context) {
    throw new MissingProviderError("useFlags");
  }

  return context.evaluations;
}
