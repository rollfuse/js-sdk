import type { EvaluationResult } from "@rollfuse/contracts";
import { useContext } from "react";
import { RollfuseContext } from "./context.js";
import { FlagNotFoundError, MissingProviderError } from "./errors.js";

export interface UseFlagOptions {
  /**
   * Returned (never as a rule match, always `reason: "default_fallback"`)
   * when the flag key is absent from the Provider's evaluations, mirroring
   * `@rollfuse/sdk-js`'s `RollfuseClient.evaluate` fallback semantics.
   */
  fallback?: unknown;
}

/**
 * Reads one flag's `EvaluationResult` from the nearest `RollfuseProvider`.
 * Throws `MissingProviderError` if no Provider is mounted, and
 * `FlagNotFoundError` if the flag key is absent and no `fallback` was
 * given, per the `sdk-react` spec.
 */
export function useFlag(flagKey: string, options: UseFlagOptions = {}): EvaluationResult {
  const context = useContext(RollfuseContext);

  if (!context) {
    throw new MissingProviderError("useFlag");
  }

  const result = context.evaluations[flagKey];

  if (result) {
    return result;
  }

  if (Object.hasOwn(options, "fallback")) {
    return {
      flag_key: flagKey,
      variation_key: "",
      value: options.fallback,
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
