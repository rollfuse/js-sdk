import type { EvaluationResult } from "@rollfuse/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, expectTypeOf, it } from "vitest";
import { RollfuseProvider } from "../src/context.js";
import { FlagNotFoundError, MissingProviderError } from "../src/errors.js";
import { useFlag, useFlags } from "../src/hooks.js";

function evaluation(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    flag_key: "checkout-redesign",
    variation_key: "treatment",
    value: true,
    reason: "rule_match",
    config_version: 1,
    track_exposure: true,
    ...overrides,
  };
}

function ReadFlag({ flagKey }: { flagKey: string }) {
  const result = useFlag(flagKey);

  return <div data-testid="value">{JSON.stringify(result.value)}</div>;
}

function ReadAllFlags() {
  const results = useFlags();

  return <div data-testid="count">{Object.keys(results).length}</div>;
}

describe("RollfuseProvider", () => {
  it("makes a provided evaluation readable by flag key", () => {
    render(
      <RollfuseProvider evaluations={[evaluation()]}>
        <ReadFlag flagKey="checkout-redesign" />
      </RollfuseProvider>,
    );

    expect(screen.getByTestId("value").textContent).toBe("true");
  });

  it("useFlags returns every evaluation the Provider holds", () => {
    render(
      <RollfuseProvider evaluations={[evaluation(), evaluation({ flag_key: "other-flag" })]}>
        <ReadAllFlags />
      </RollfuseProvider>,
    );

    expect(screen.getByTestId("count").textContent).toBe("2");
  });

  it("useFlag returns a fallback marked as default_fallback for an unknown flag key", () => {
    function ReadFallback() {
      const result = useFlag("unknown-flag", { fallback: "fallback-value" });

      return (
        <div>
          <div data-testid="value">{JSON.stringify(result.value)}</div>
          <div data-testid="reason">{result.reason}</div>
        </div>
      );
    }

    render(
      <RollfuseProvider evaluations={[]}>
        <ReadFallback />
      </RollfuseProvider>,
    );

    expect(screen.getByTestId("value").textContent).toBe('"fallback-value"');
    expect(screen.getByTestId("reason").textContent).toBe("default_fallback");
  });

  it("useFlag throws FlagNotFoundError for an unknown flag key with no fallback", () => {
    function ReadMissing() {
      useFlag("unknown-flag");
      return null;
    }

    expect(() =>
      render(
        <RollfuseProvider evaluations={[]}>
          <ReadMissing />
        </RollfuseProvider>,
      ),
    ).toThrow(FlagNotFoundError);
  });

  it("useFlag throws MissingProviderError outside a Provider", () => {
    function ReadWithoutProvider() {
      useFlag("checkout-redesign");
      return null;
    }

    expect(() => render(<ReadWithoutProvider />)).toThrow(MissingProviderError);
  });

  it("useFlags throws MissingProviderError outside a Provider", () => {
    function ReadAllWithoutProvider() {
      useFlags();
      return null;
    }

    expect(() => render(<ReadAllWithoutProvider />)).toThrow(MissingProviderError);
  });

  it("infers value's type from the fallback given, at runtime and compile time", () => {
    function ReadTypedFallback() {
      const result = useFlag("checkout-redesign", { fallback: false });

      // Compile-time: `result.value` must be narrowed to `boolean`, not
      // `unknown` — this is the actual assertion; expectTypeOf performs no
      // runtime check itself (see the `.toBe` below for that).
      expectTypeOf(result.value).toEqualTypeOf<boolean>();

      return <div data-testid="value">{JSON.stringify(result.value)}</div>;
    }

    render(
      <RollfuseProvider evaluations={[evaluation({ value: true })]}>
        <ReadTypedFallback />
      </RollfuseProvider>,
    );

    expect(screen.getByTestId("value").textContent).toBe("true");
  });

  it("leaves value as unknown when no fallback is given, unchanged from before the generic existed", () => {
    function ReadUntyped() {
      const result = useFlag("checkout-redesign");

      expectTypeOf(result.value).toEqualTypeOf<unknown>();

      return null;
    }

    render(
      <RollfuseProvider evaluations={[evaluation()]}>
        <ReadUntyped />
      </RollfuseProvider>,
    );
  });
});
