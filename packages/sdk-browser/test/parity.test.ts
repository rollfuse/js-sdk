import type { Configuration, FlagConfig } from "@rollfuse/contracts";
import { describe, expect, it, vi } from "vitest";
import { RollfusePublicClient } from "../src/client.js";
// A JSON import rather than node:fs, deliberately: this package's tests
// carry no @types/node (unlike its siblings), since it represents
// literal browser-only code and its tests should not assume a Node API
// is available either. tsconfig.json's resolveJsonModule already permits
// this.
import rolloutVectorsJson from "../../evaluation-core/test/fixtures/rollout-outcome-vectors.json" with { type: "json" };

/**
 * Proves `RollfusePublicClient.evaluate`/`evaluateAll` — the client's
 * public evaluation path, exactly as an integrator calls it — matches the
 * shared cross-language conformance fixture's expected outcomes.
 *
 * This used to compare `client.evaluate()` against `evaluateFlag()`
 * imported from `@rollfuse/evaluation-core` and called directly with the
 * same inputs. Since the client wraps that exact function, the comparison
 * was a function checked against itself: a bug inside `evaluateFlag`
 * would pass this test every time, because both sides of the assertion
 * would be wrong identically. harden-sdk-runtime task 1.4 rewrites it to
 * assert against the fixture's own expected values instead, so a
 * regression in either the client's wrapping (attribute/config plumbing)
 * or the evaluation core it wraps turns this test red.
 *
 * Manually verified this now fails where the old version could not: with
 * `evaluate()`'s subject key argument swapped for a hardcoded literal
 * (simulating the client silently ignoring the caller's subject), 8 of the
 * 20 assertions below — every one whose outcome actually depends on which
 * subject was evaluated — turned red; reverted before committing.
 */
interface RolloutSplitVector {
  variation_key: string;
  percentage: number;
}

interface RolloutOutcomeVector {
  description: string;
  flag_key: string;
  subject_key: string;
  rollout: RolloutSplitVector[];
  default_variation_key: string;
  expected_variation_key: string | null;
}

const rolloutVectors = rolloutVectorsJson as RolloutOutcomeVector[];

function flagFromVector(vector: RolloutOutcomeVector): FlagConfig {
  const keys = new Set<string>([vector.default_variation_key, ...vector.rollout.map((s) => s.variation_key)]);

  return {
    flag_key: vector.flag_key,
    enabled: true,
    default_variation: vector.default_variation_key,
    variations: [...keys].map((key) => ({ key, value: null })),
    rules: [
      {
        conditions: [],
        outcome: {
          rollout: vector.rollout.map((s) => ({ variation_key: s.variation_key, percentage: s.percentage })),
        },
      },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function clientFor(flag: FlagConfig): Promise<RollfusePublicClient> {
  const config: Configuration = {
    environment_id: "env_1",
    version: 7,
    poll_interval_seconds: 30,
    flags: [flag],
  };
  const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(config));
  const client = new RollfusePublicClient({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

  await client.start();

  return client;
}

describe("evaluation parity with the shared conformance fixture", () => {
  it("has a non-empty rollout-outcome fixture to check against", () => {
    expect(rolloutVectors.length).toBeGreaterThan(0);
  });

  for (const vector of rolloutVectors) {
    it(`evaluate(): ${vector.description}`, async () => {
      const flag = flagFromVector(vector);
      const client = await clientFor(flag);

      const result = client.evaluate(vector.subject_key, vector.flag_key);

      if (vector.expected_variation_key === null) {
        expect(result.reason).toBe("default_fallback");
        expect(result.variation_key).toBe(vector.default_variation_key);
      } else {
        expect(result.variation_key).toBe(vector.expected_variation_key);
        expect(result.reason).toBe("rule_match");
      }

      client.stop();
    });
  }

  it("evaluate() honors a matching rule condition ahead of the rollout it falls back to", async () => {
    const flag: FlagConfig = {
      flag_key: "checkout-redesign",
      enabled: true,
      default_variation: "off",
      variations: [
        { key: "on", value: true },
        { key: "off", value: false },
      ],
      rules: [
        { conditions: [{ attribute: "plan", value: "enterprise" }], outcome: { variation_key: "on" } },
        {
          outcome: {
            rollout: [
              { variation_key: "on", percentage: 50 },
              { variation_key: "off", percentage: 50 },
            ],
          },
        },
      ],
    };
    const client = await clientFor(flag);

    const matched = client.evaluate("user_1", "checkout-redesign", { attributes: { plan: "enterprise" } });

    expect(matched).toEqual({
      flag_key: "checkout-redesign",
      variation_key: "on",
      value: true,
      reason: "rule_match",
      config_version: 7,
      track_exposure: true,
    });

    client.stop();
  });

  it("evaluate() serves the default variation without evaluating any rule when the flag is disabled", async () => {
    const flag: FlagConfig = {
      flag_key: "always-off",
      enabled: false,
      default_variation: "off",
      variations: [{ key: "off", value: false }],
      rules: [{ conditions: [], outcome: { variation_key: "off" } }],
    };
    const client = await clientFor(flag);

    const result = client.evaluate("user_1", "always-off");

    expect(result).toEqual({
      flag_key: "always-off",
      variation_key: "off",
      value: false,
      reason: "default_disabled",
      config_version: 7,
      track_exposure: false,
    });

    client.stop();
  });

  it("evaluateAll() matches the fixture's expected outcome for the flag in the configuration", async () => {
    // A distinct flag_key would change the vector's bucket (bucketing is
    // salted by flag_key), invalidating its precomputed expected outcome,
    // so this keeps the vector's real flag_key rather than renaming it —
    // still exercises evaluateAll's own per-flag iteration against a
    // known-correct expected outcome from the fixture, not a value
    // derived by calling the evaluation core a second time.
    const vector = rolloutVectors.find((v) => v.expected_variation_key !== null)!;
    const flags = [flagFromVector(vector)];
    const config: Configuration = { environment_id: "env_1", version: 9, poll_interval_seconds: 30, flags };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(config));
    const client = new RollfusePublicClient({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

    await client.start();

    const results = client.evaluateAll(vector.subject_key);

    expect(results).toEqual([
      {
        flag_key: vector.flag_key,
        variation_key: vector.expected_variation_key,
        value: null,
        reason: "rule_match",
        config_version: 9,
        track_exposure: true,
      },
    ]);

    client.stop();
  });
});
