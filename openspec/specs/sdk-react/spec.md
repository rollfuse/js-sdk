# sdk-react Specification

## Purpose

Define how a React/Next.js application consumes platform flags: a
Provider/hook API fed by server-evaluated results, with no Service
Credential ever reaching browser code, and a server-mediated path for
reporting exposures triggered by client-side interaction.

## Requirements

### Requirement: Server-Evaluated Bootstrap

The React consumption layer MUST receive flag evaluations that were
already computed server-side (via `@rollfuse/sdk-js`'s `evaluate`/
`evaluateAll`), and MUST NOT itself hold, transmit, or require a Service
Credential in code that can execute in the browser.

#### Scenario: Provider is given pre-evaluated results

- **WHEN** a Next.js Server Component evaluates flags for a subject and
  passes the resulting `EvaluationResult`s into the React Provider
- **THEN** the Provider MUST make those results available to descendant
  components without performing any network request of its own

#### Scenario: No credential in client code

- **WHEN** the React Provider or its hooks are bundled for the browser
- **THEN** the bundle MUST NOT contain a Service Credential value or any
  code path that reads one directly

### Requirement: Flag Consumption Hooks

The React consumption layer MUST expose a hook to read a single flag's
evaluation result by key and a hook to read every evaluation result
provided by the Provider, both returning the same value for a given key
on every render until the Provider receives new results.

#### Scenario: Reading a single flag

- **WHEN** a component calls the single-flag hook with a flag key present
  in the Provider's results
- **THEN** it MUST return that flag's `EvaluationResult`

#### Scenario: Reading a flag not present in the results

- **WHEN** a component calls the single-flag hook with a flag key absent
  from the Provider's results
- **THEN** the hook MUST return the caller-supplied fallback value if one
  was given, marked as a fallback, rather than throwing
- **AND** MUST raise a distinguishable error if no fallback was given

#### Scenario: Reading all flags

- **WHEN** a component calls the all-flags hook
- **THEN** it MUST return every `EvaluationResult` the Provider currently
  holds

### Requirement: Consuming Without a Provider Is an Error

Calling a flag consumption hook outside a mounted Provider MUST raise a
distinguishable error rather than silently returning an empty or default
result.

#### Scenario: Hook used outside the Provider tree

- **WHEN** a component calls a flag consumption hook without an ancestor
  Provider
- **THEN** the hook MUST throw a distinguishable "missing Provider" error

### Requirement: Server-Mediated Exposure Reporting

When a client-side interaction requires reporting an exposure (for
example, a client-side re-evaluation using attributes only known in the
browser), the React consumption layer MUST submit it through a
server-mediated endpoint that holds the Service Credential, and MUST NOT
call the platform's exposure-event API directly from browser code.

#### Scenario: Client-triggered exposure is proxied

- **WHEN** browser code reports an exposure for a rule-matched evaluation
- **THEN** the report MUST be sent to an application-controlled
  server-side endpoint
- **AND** that endpoint MUST be the only party attaching the Service
  Credential when forwarding the event to the platform API

#### Scenario: Proxy endpoint failure does not affect the UI

- **GIVEN** the server-mediated exposure endpoint fails or the platform
  API is unreachable
- **WHEN** browser code reports an exposure
- **THEN** the failure MUST NOT be surfaced as an error to the end user
- **AND** MUST NOT block or alter the rendering already performed based
  on the evaluation result

### Requirement: Stable Identity Across Server and Client Render

The subject key and evaluation results used for a component's initial
client-side render MUST match what the server used to render that same
component, so hydration does not change which variation is shown.

#### Scenario: Hydration does not flip a variation

- **GIVEN** a Server Component rendered a flag's variation for a subject
  key
- **WHEN** the page hydrates on the client
- **THEN** the React consumption layer MUST expose that same variation
  for that same subject key without a visible change

### Requirement: Provider Supports Direct Browser-Evaluated Flags

The React consumption layer MUST support populating the Provider from a
live, client-side evaluation source (a browser-safe client using a Public
Credential) as an alternative to server-evaluated props, without changing
the `useFlag`/`useFlags` hook contract already relied on by consumers of
the server-evaluated-props bootstrap.

#### Scenario: Provider driven by a browser-side client

- **WHEN** the Provider is configured with a browser-side evaluation
  client instead of a static `evaluations` array
- **THEN** `useFlag`/`useFlags` MUST behave the same as when fed
  server-evaluated props, returning results by flag key

#### Scenario: Existing server-evaluated-props usage is unaffected

- **WHEN** the Provider continues to be given a static `evaluations` array
  from server-side evaluation
- **THEN** its behavior MUST be unchanged by the addition of the
  browser-side evaluation source

### Requirement: Browser-Side Evaluation Never Uses A Non-Public Credential

The browser-side evaluation source MUST be constructed only with a Public
Credential, and the React consumption layer MUST NOT provide any API
surface that accepts a non-Public Service Credential for client-side use.

#### Scenario: Only a Public credential is accepted

- **WHEN** the browser-side evaluation client is configured
- **THEN** its configuration MUST require a credential explicitly marked
  as usable in browser code
- **AND** the API MUST NOT offer a parameter or code path suggesting a
  regular Service Credential is an acceptable value there
