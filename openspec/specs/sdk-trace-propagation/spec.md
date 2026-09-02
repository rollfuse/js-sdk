# SDK Trace Propagation Specification

## Purpose

Defines W3C trace-context propagation behavior for outbound API calls made
by the platform's client SDKs (`packages/sdk-browser`, `packages/sdk`,
`packages/sdk-react`), so an SDK-originated call always belongs to a
traceable, linkable trace rather than reaching the API with no trace
context at all.

## Requirements

### Requirement: Trace Context Injection On Outbound Calls

Every outbound HTTP call an SDK makes to the platform API (`GET
/v1/config`, `POST /v1/evaluate`, `POST /v1/exposure-events`) MUST carry a
W3C `traceparent` header, and MUST carry `tracestate`/`baggage` headers
when the originating context provides them.

#### Scenario: SDK call reaches the API

- **WHEN** an SDK issues any outbound call to the platform API
- **THEN** the request MUST include a syntactically valid `traceparent`
  header

### Requirement: Reuse Of An Active Host OpenTelemetry Context

When the integrating application has an active OpenTelemetry context
available (`@opentelemetry/api` present as an optional peer dependency,
with a context actually active at call time), the SDK MUST inject that
context's trace information into the outbound call rather than originating
an unrelated trace.

#### Scenario: Host application has an active OTel span

- **GIVEN** the integrating application has `@opentelemetry/api` installed
  and an active span/context at the time an SDK call is made
- **WHEN** the SDK issues that outbound call
- **THEN** the injected `traceparent` MUST carry the active context's trace
  ID, making the SDK's call a child of that trace

#### Scenario: Host application has no OpenTelemetry context

- **GIVEN** the integrating application has no `@opentelemetry/api`
  instance active, whether or not the package is installed
- **WHEN** the SDK issues an outbound call
- **THEN** the SDK MUST NOT fail, error, or omit the `traceparent` header
- **AND** MUST fall back to self-issued trace origination

### Requirement: Self-Issued Trace Origination Without A Host OTel SDK

When no active OpenTelemetry context is available, the SDK MUST originate
a new, valid W3C trace context for the call on its own, without requiring
`@opentelemetry/api` to be installed in the host application.

#### Scenario: No OTel SDK present in the host application

- **GIVEN** the integrating application has no OpenTelemetry SDK of any
  kind
- **WHEN** the SDK issues an outbound call to the API
- **THEN** the SDK MUST generate a new, valid `traceparent` header for that
  call
- **AND** the resulting API span MUST be linkable to that self-issued
  trace, not orphaned

### Requirement: One Trace Per Exposure-Reporting Request

When the SDK's exposure queue flushes a batch of queued ExposureEvents in
a single `POST /v1/exposure-events` call, it MUST originate or inject
exactly one trace context for that HTTP request, covering every event
included in that batch, rather than one trace context per individually
queued event. (The SDK does not retry a failed flush — a failed batch is
dropped, per each SDK's existing best-effort exposure-reporting design —
so this requirement concerns only the one HTTP request each flush ever
makes.)

#### Scenario: A batch containing multiple queued events is flushed

- **GIVEN** the exposure queue has multiple ExposureEvents queued from
  separate evaluations
- **WHEN** the SDK flushes them in a single `POST /v1/exposure-events`
  request
- **THEN** that request MUST carry exactly one `traceparent` header
- **AND** every event in the batch MUST be associated with that same trace
  in the resulting API span

#### Scenario: Consecutive flushes each get their own trace

- **GIVEN** the exposure queue flushes a batch, and later flushes a second,
  separate batch
- **WHEN** each flush sends its own `POST /v1/exposure-events` request
- **THEN** each request MUST carry a `traceparent` header originated or
  injected at the time of that flush, independent of any other flush's
  trace context

### Requirement: Optional Dependency Does Not Break Without It

`@opentelemetry/api` MUST be declared as an optional peer dependency, and
every SDK MUST function identically for evaluation and exposure-reporting
purposes whether or not it is installed in the host application.

#### Scenario: SDK installed without `@opentelemetry/api`

- **GIVEN** an integrator installs the SDK without also installing
  `@opentelemetry/api`
- **WHEN** the integrator uses the SDK's normal evaluation and
  exposure-reporting behavior
- **THEN** the SDK MUST behave exactly as documented, with no missing
  dependency error, degraded evaluation, or dropped exposure reporting
