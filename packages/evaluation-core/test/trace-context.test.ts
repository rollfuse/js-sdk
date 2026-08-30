import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyTraceHeaders, resolveTraceHeaders } from "../src/trace-context.js";

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

describe("resolveTraceHeaders", () => {
  it("generates a valid, self-issued traceparent when no OTel context is active", async () => {
    const trace1 = await resolveTraceHeaders();
    const trace2 = await resolveTraceHeaders();

    expect(trace1.traceparent).toMatch(TRACEPARENT_RE);
    expect(trace2.traceparent).toMatch(TRACEPARENT_RE);
    // Two independent resolutions must never collide.
    expect(trace1.traceparent).not.toBe(trace2.traceparent);
  });

  describe("with an active OpenTelemetry context", () => {
    let contextManager: AsyncHooksContextManager;

    beforeEach(() => {
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
      // A real ContextManager is required: @opentelemetry/api's default
      // no-op manager doesn't track "active" across an await, so without
      // this, context.active() inside resolveTraceHeaders would never see
      // what context.with() set, regardless of whether injection itself
      // works — matching what a host application's real Node OTel SDK
      // (which always registers one) provides in practice.
      contextManager = new AsyncHooksContextManager().enable();
      context.setGlobalContextManager(contextManager);
    });

    afterEach(() => {
      propagation.disable();
      context.disable();
      contextManager.disable();
    });

    it("injects the active span's trace context instead of self-issuing one", async () => {
      const spanContext = {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: 1,
        isRemote: false,
      };
      const span = trace.wrapSpanContext(spanContext);
      const ctx = trace.setSpan(context.active(), span);

      const result = await context.with(ctx, () => resolveTraceHeaders());

      expect(result.traceparent).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    });

    it("falls back to a self-issued traceparent when no span is active", async () => {
      const result = await resolveTraceHeaders();

      expect(result.traceparent).toMatch(TRACEPARENT_RE);
    });
  });
});

describe("applyTraceHeaders", () => {
  it("sets traceparent and omits tracestate/baggage when absent", () => {
    const headers = applyTraceHeaders({ Authorization: "Bearer x" }, { traceparent: "00-a-b-01" });

    expect(headers).toEqual({ Authorization: "Bearer x", traceparent: "00-a-b-01" });
  });

  it("sets tracestate and baggage when present", () => {
    const headers = applyTraceHeaders(
      {},
      { traceparent: "00-a-b-01", tracestate: "vendor=1", baggage: "k=v" },
    );

    expect(headers).toEqual({ traceparent: "00-a-b-01", tracestate: "vendor=1", baggage: "k=v" });
  });
});
