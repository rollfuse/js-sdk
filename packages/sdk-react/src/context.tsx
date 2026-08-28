"use client";

import type { EvaluationResult } from "@rollfuse/contracts";
import { createContext, useMemo, type ReactNode } from "react";

/** The Provider's context value: every evaluation it holds, keyed by flag_key. */
export interface RollfuseContextValue {
  evaluations: Record<string, EvaluationResult>;
}

/**
 * `undefined` by default (rather than an empty-results object) so
 * `useFlag`/`useFlags` can distinguish "no Provider mounted" from "Provider
 * mounted with zero evaluations", per the spec's "Consuming Without a
 * Provider Is an Error" requirement.
 */
export const RollfuseContext = createContext<RollfuseContextValue | undefined>(undefined);

export interface RollfuseProviderProps {
  /**
   * Evaluation results computed server-side (e.g. via `@rollfuse/sdk-js`'s
   * `evaluateAll`) and passed down as serializable props. Per the
   * `sdk-react` spec's "Server-Evaluated Bootstrap" requirement, this
   * package never performs its own network request to obtain these.
   */
  evaluations: EvaluationResult[];
  children: ReactNode;
}

/**
 * Makes server-evaluated flag results available to `useFlag`/`useFlags`.
 * Never imports `@rollfuse/sdk-js` and never accepts a Service Credential —
 * see this package's README for why that boundary is load-bearing, not
 * just a convention.
 */
export function RollfuseProvider({ evaluations, children }: RollfuseProviderProps) {
  const value = useMemo<RollfuseContextValue>(() => {
    const byFlagKey: Record<string, EvaluationResult> = {};

    for (const evaluation of evaluations) {
      byFlagKey[evaluation.flag_key] = evaluation;
    }

    return { evaluations: byFlagKey };
  }, [evaluations]);

  return <RollfuseContext.Provider value={value}>{children}</RollfuseContext.Provider>;
}
