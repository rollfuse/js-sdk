import { applyTraceHeaders, resolveTraceHeaders } from "@rollfuse/evaluation-core";

/**
 * Deadline applied to every report via AbortSignal.timeout, regardless of
 * which fetchImpl is in use, per sdk-conformance's "Every Network
 * Operation Carries A Deadline" requirement — this endpoint had none at
 * all before.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** What `reportExposure` sends to the application-controlled proxy endpoint. */
export interface ExposureReport {
  flagKey: string;
  subjectKey: string;
  variationKey: string;
  reason: string;
  configVersion: number;
}

export interface ReportExposureOptions {
  /**
   * Injectable for tests; defaults to the global `fetch`. Not a bare
   * reference — see this file's own note where it's invoked: some
   * environments (e.g. OpenTelemetry's fetch auto-instrumentation)
   * replace `window.fetch` with a `this`-sensitive wrapper that breaks
   * when called any other way, matching `@rollfuse/sdk-browser`'s
   * `ConfigurationClient`'s identical fix and its own full rationale.
   */
  fetchImpl?: typeof fetch;
  /**
   * Deadline applied to this report via `AbortSignal.timeout`, regardless
   * of which `fetchImpl` is in use. Default 10s.
   */
  requestTimeoutMs?: number;
  /**
   * Called if the report fails to send. Per the `sdk-react` spec's "Proxy
   * endpoint failure does not affect the UI" scenario, `reportExposure`
   * itself never throws — this is the only way a caller observes a
   * failure.
   */
  onError?: (error: unknown) => void;
}

/**
 * POSTs an exposure report to an application-controlled server-side
 * endpoint (never directly to the platform API — see this package's
 * README and the `sdk-react` spec's "Server-Mediated Exposure Reporting"
 * requirement). Never throws and never blocks rendering on its result.
 */
export async function reportExposure(
  endpointUrl: string,
  payload: ExposureReport,
  options: ReportExposureOptions = {},
): Promise<void> {
  // Not a bare `fetch` identifier, and not just any wrapper around it:
  // some environments (e.g. OpenTelemetry's fetch auto-instrumentation)
  // replace `window.fetch` with a wrapper that only works when invoked
  // with `this === window`/globalThis. A bare identifier call inside an
  // ES module is strict-mode, so `this` is `undefined` there — this broke
  // silently (never surfaced beyond `onError`, which callers may not have
  // wired up) under exactly the instrumented environment this package's
  // README recommends pairing it with. Matches
  // `@rollfuse/sdk-browser`'s `ConfigurationClient`'s identical fix.
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  try {
    const trace = await resolveTraceHeaders();
    const headers = applyTraceHeaders({ "Content-Type": "application/json" }, trace);
    const response = await fetchImpl(endpointUrl, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`POST ${endpointUrl} returned status ${response.status}`);
    }
  } catch (error) {
    options.onError?.(error);
  }
}
