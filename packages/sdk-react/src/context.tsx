"use client";

import type { EvaluationResult } from "@rollfuse/contracts";
import { ConfigNotReadyError, type RollfusePublicClient } from "@rollfuse/sdk-browser";
import { createContext, useCallback, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";

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

/** Server-evaluated-props mode: the original, still-default bootstrap. */
export interface RollfuseProviderServerProps {
  /**
   * Evaluation results computed server-side (e.g. via `@rollfuse/sdk-js`'s
   * `evaluateAll`) and passed down as serializable props. Per the
   * `sdk-react` spec's "Server-Evaluated Bootstrap" requirement, this
   * package never performs its own network request to obtain these.
   */
  evaluations: EvaluationResult[];
  client?: undefined;
  children: ReactNode;
}

/**
 * Client-driven mode: the Provider subscribes to a browser-side
 * `RollfusePublicClient` (from `@rollfuse/sdk-browser`) and re-evaluates
 * live as its cached Configuration refreshes, per this package's
 * "Provider Supports Direct Browser-Evaluated Flags" requirement. `client`
 * must have been constructed with a Public Credential — see
 * `@rollfuse/sdk-browser`'s own "Public Credential only" documentation;
 * this package has no way to verify that server-side, so the guarantee is
 * structural: `client`'s type is `RollfusePublicClient`, which only ever
 * accepts a `publicCredential` option, never a generic `credential`.
 */
export interface RollfuseProviderClientProps {
  evaluations?: undefined;
  /** A `RollfusePublicClient` constructed with a Public Credential. */
  client: RollfusePublicClient;
  /** The subject to evaluate every flag for. */
  subjectKey: string;
  /** Attributes available to rule conditions, re-evaluated on every render. */
  attributes?: Record<string, string>;
  children: ReactNode;
}

export type RollfuseProviderProps = RollfuseProviderServerProps | RollfuseProviderClientProps;

/**
 * Makes flag evaluation results available to `useFlag`/`useFlags`, from
 * either of two sources — see `RollfuseProviderServerProps`/
 * `RollfuseProviderClientProps`:
 *
 * - **Server-evaluated props** (`evaluations`, the original mode): static,
 *   server-computed results passed down as serializable props. This
 *   package never imports `@rollfuse/sdk-js` and never accepts a Service
 *   Credential in this mode — see this package's README for why that
 *   boundary is load-bearing, not just a convention.
 * - **Client-driven** (`client`): a live, browser-side
 *   `RollfusePublicClient` this Provider subscribes to, re-evaluating
 *   every flag whenever the client's cached Configuration refreshes.
 *
 * `useFlag`/`useFlags` behave identically regardless of which mode fed the
 * Provider — both populate the exact same `RollfuseContextValue` shape.
 */
export function RollfuseProvider(props: RollfuseProviderProps) {
  if (props.client) {
    return <ClientDrivenProvider {...props} />;
  }

  return <ServerEvaluatedProvider {...props} />;
}

function ServerEvaluatedProvider({ evaluations, children }: RollfuseProviderServerProps) {
  const value = useMemo<RollfuseContextValue>(() => {
    const byFlagKey: Record<string, EvaluationResult> = {};

    for (const evaluation of evaluations) {
      byFlagKey[evaluation.flag_key] = evaluation;
    }

    return { evaluations: byFlagKey };
  }, [evaluations]);

  return <RollfuseContext.Provider value={value}>{children}</RollfuseContext.Provider>;
}

interface SnapshotCache {
  key: string;
  snapshot: Record<string, EvaluationResult>;
}

function ClientDrivenProvider({ client, subjectKey, attributes, children }: RollfuseProviderClientProps) {
  // Bumped by the client's own subscribe callback (fires after each
  // successful Configuration refresh) so getSnapshot below knows when a
  // cached snapshot must be recomputed, without RollfusePublicClient
  // needing to expose its internal Configuration version publicly.
  const refreshCountRef = useRef(0);
  const cacheRef = useRef<SnapshotCache | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      client.subscribe(() => {
        refreshCountRef.current += 1;
        onStoreChange();
      }),
    [client],
  );

  // useSyncExternalStore requires getSnapshot to return a referentially
  // stable value when nothing has changed (React docs: otherwise it
  // re-renders in an infinite loop) — cached by a key combining the
  // refresh count with subjectKey/attributes, so a snapshot is only
  // rebuilt when the underlying Configuration actually refreshed or the
  // caller's own props changed.
  const getSnapshot = useCallback((): Record<string, EvaluationResult> => {
    const key = `${refreshCountRef.current}:${subjectKey}:${attributes ? JSON.stringify(attributes) : ""}`;

    if (cacheRef.current && cacheRef.current.key === key) {
      return cacheRef.current.snapshot;
    }

    const byFlagKey: Record<string, EvaluationResult> = {};

    try {
      for (const result of client.evaluateAll(subjectKey, { attributes })) {
        byFlagKey[result.flag_key] = result;
      }
    } catch (error) {
      // No Configuration cached yet: render with zero evaluations rather
      // than throwing during render. useFlag's own fallback/
      // FlagNotFoundError handling takes it from there, exactly as it
      // already does for a flag key genuinely absent from a
      // server-evaluated Provider's evaluations. Any other error is a
      // real bug (e.g. a client-side exception unrelated to readiness)
      // and must not be silently swallowed.
      if (!(error instanceof ConfigNotReadyError)) {
        throw error;
      }
    }

    cacheRef.current = { key, snapshot: byFlagKey };

    return byFlagKey;
  }, [client, subjectKey, attributes]);

  const evaluations = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const value = useMemo<RollfuseContextValue>(() => ({ evaluations }), [evaluations]);

  return <RollfuseContext.Provider value={value}>{children}</RollfuseContext.Provider>;
}
