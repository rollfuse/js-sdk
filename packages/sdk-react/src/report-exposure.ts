import { applyTraceHeaders, resolveTraceHeaders } from "@rollfuse/evaluation-core";

/** What `reportExposure` sends to the application-controlled proxy endpoint. */
export interface ExposureReport {
  flagKey: string;
  subjectKey: string;
  variationKey: string;
  reason: string;
  configVersion: number;
}

export interface ReportExposureOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
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
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const trace = await resolveTraceHeaders();
    const headers = applyTraceHeaders({ "Content-Type": "application/json" }, trace);
    const response = await fetchImpl(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`POST ${endpointUrl} returned status ${response.status}`);
    }
  } catch (error) {
    options.onError?.(error);
  }
}
