/**
 * W3C trace-context propagation for outbound API calls, shared by
 * `@rollfuse/sdk-browser` and `@rollfuse/sdk-js` (and, transitively,
 * `@rollfuse/sdk-react`'s server-mediated proxy) so every SDK-originated
 * call to the platform API links into a trace instead of arriving with no
 * trace context at all — see `openspec/changes/add-sdk-otel-tracing`.
 *
 * `@opentelemetry/api` is an optional peer dependency: when the
 * integrating application has it installed and an active span, that
 * context is injected via `propagation.inject`. Otherwise (package not
 * installed, or installed but nothing active) a self-issued, spec-valid
 * `traceparent` is generated so the call still originates a linkable
 * trace. The dynamic `import()` below is what makes the dependency truly
 * optional: a missing package rejects the import, which is caught, rather
 * than failing module resolution at bundle time the way a static `import`
 * would for a consumer who never installed it.
 */

/** Subset of `@opentelemetry/api`'s surface this module actually uses. */
interface OtelApiModule {
  context: { active(): unknown };
  trace: { getSpan(ctx: unknown): unknown };
  propagation: { inject(ctx: unknown, carrier: Record<string, string>): void };
}

let otelApiPromise: Promise<OtelApiModule | undefined> | undefined;

function loadOtelApi(): Promise<OtelApiModule | undefined> {
  if (!otelApiPromise) {
    otelApiPromise = import("@opentelemetry/api").then(
      (mod) => mod as unknown as OtelApiModule,
      () => undefined,
    );
  }

  return otelApiPromise;
}

/**
 * Fills `randomHex`'s buffer with cryptographically random bytes. Web
 * Crypto's `getRandomValues` is available globally in both browsers and
 * Node >=18.17 (this package's minimum supported Node version); the
 * `Math.random` fallback only ever backstops an environment lacking that
 * global; entropy quality doesn't matter here — the id is a correlation
 * identifier, not a security token.
 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;

  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Generates a new, valid W3C `traceparent` (`00-<trace-id>-<parent-id>-01`, sampled). */
function generateTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

/** The W3C trace-context headers to attach to an outbound API call. */
export interface TraceHeaders {
  traceparent: string;
  tracestate?: string;
  baggage?: string;
}

/**
 * Resolves the trace-context headers for one outbound call: injects the
 * host application's active OpenTelemetry context when one exists,
 * otherwise generates a fresh, self-issued `traceparent`. Call this once
 * per outbound HTTP request (not once per logical event) — a batched
 * request should get exactly one set of trace headers covering everything
 * it carries.
 */
export async function resolveTraceHeaders(): Promise<TraceHeaders> {
  const otel = await loadOtelApi();

  if (otel) {
    try {
      const activeContext = otel.context.active();

      if (otel.trace.getSpan(activeContext)) {
        const carrier: Record<string, string> = {};
        otel.propagation.inject(activeContext, carrier);

        if (carrier.traceparent) {
          return {
            traceparent: carrier.traceparent,
            tracestate: carrier.tracestate,
            baggage: carrier.baggage,
          };
        }
      }
    } catch {
      // Falls through to the self-issued traceparent below — an active
      // OTel context that fails to inject must never break the call it
      // would have traced.
    }
  }

  return { traceparent: generateTraceparent() };
}

/** Merges `trace`'s headers into `headers`, mutating and returning it. */
export function applyTraceHeaders(
  headers: Record<string, string>,
  trace: TraceHeaders,
): Record<string, string> {
  headers.traceparent = trace.traceparent;

  if (trace.tracestate) {
    headers.tracestate = trace.tracestate;
  }

  if (trace.baggage) {
    headers.baggage = trace.baggage;
  }

  return headers;
}
