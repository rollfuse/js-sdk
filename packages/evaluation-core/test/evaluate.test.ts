import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FlagConfig } from "@rollfuse/contracts";
import { describe, expect, it } from "vitest";
import { bucket } from "../src/bucketing.js";
import { evaluateFlag } from "../src/evaluate.js";

function flag(overrides: Partial<FlagConfig> = {}): FlagConfig {
  return {
    flag_key: "checkout-redesign",
    enabled: true,
    default_variation: "off",
    variations: [
      { key: "on", value: true },
      { key: "off", value: false },
    ],
    rules: [],
    ...overrides,
  };
}

describe("evaluateFlag", () => {
  it("serves the default variation when disabled, without evaluating rules", () => {
    const result = evaluateFlag(
      flag({
        enabled: false,
        rules: [{ conditions: [], outcome: { variation_key: "on" } }],
      }),
      1,
      "user_1",
    );

    expect(result).toEqual({
      flag_key: "checkout-redesign",
      variation_key: "off",
      value: false,
      reason: "default_disabled",
      config_version: 1,
      track_exposure: false,
    });
  });

  it("serves the default variation when no rule matches", () => {
    const result = evaluateFlag(
      flag({
        rules: [
          { conditions: [{ attribute: "plan", value: "enterprise" }], outcome: { variation_key: "on" } },
        ],
      }),
      1,
      "user_1",
      { plan: "starter" },
    );

    expect(result.reason).toBe("default_no_rule_match");
    expect(result.variation_key).toBe("off");
    expect(result.track_exposure).toBe(false);
  });

  it("a missing attribute never matches a condition", () => {
    const result = evaluateFlag(
      flag({
        rules: [
          { conditions: [{ attribute: "plan", value: "enterprise" }], outcome: { variation_key: "on" } },
        ],
      }),
      1,
      "user_1",
      {}, // plan not supplied at all
    );

    expect(result.reason).toBe("default_no_rule_match");
  });

  it("resolves a matched rule's fixed variation and marks exposure", () => {
    const result = evaluateFlag(
      flag({
        rules: [
          { conditions: [{ attribute: "plan", value: "enterprise" }], outcome: { variation_key: "on" } },
        ],
      }),
      3,
      "user_1",
      { plan: "enterprise" },
    );

    expect(result).toEqual({
      flag_key: "checkout-redesign",
      variation_key: "on",
      value: true,
      reason: "rule_match",
      config_version: 3,
      track_exposure: true,
    });
  });

  it("evaluates rules in order, first match wins", () => {
    const result = evaluateFlag(
      flag({
        rules: [
          { conditions: [{ attribute: "plan", value: "enterprise" }], outcome: { variation_key: "on" } },
          { conditions: [], outcome: { variation_key: "off" } }, // unconditional catch-all, would also match
        ],
      }),
      1,
      "user_1",
      { plan: "enterprise" },
    );

    expect(result.variation_key).toBe("on");
    expect(result.reason).toBe("rule_match");
  });

  it("an unconditional rule (no conditions) is a catch-all", () => {
    const result = evaluateFlag(
      flag({ rules: [{ conditions: [], outcome: { variation_key: "on" } }] }),
      1,
      "user_1",
    );

    expect(result.variation_key).toBe("on");
    expect(result.reason).toBe("rule_match");
  });

  it("falls back to the default variation when a matched rule's outcome references an unknown variation", () => {
    const result = evaluateFlag(
      flag({ rules: [{ conditions: [], outcome: { variation_key: "does-not-exist" } }] }),
      1,
      "user_1",
    );

    expect(result.reason).toBe("default_fallback");
    expect(result.variation_key).toBe("off");
    expect(result.track_exposure).toBe(false);
  });

  it("repeated evaluation of the same inputs is deterministic", () => {
    const f = flag({
      rules: [{ conditions: [], outcome: { rollout: [{ variation_key: "on", percentage: 50 }, { variation_key: "off", percentage: 50 }] } }],
    });

    const first = evaluateFlag(f, 1, "user_123");

    for (let i = 0; i < 20; i++) {
      expect(evaluateFlag(f, 1, "user_123")).toEqual(first);
    }
  });

  describe("percentage rollout", () => {
    it("resolves via cumulative bucket ranges in array order, matching the bucket alone", () => {
      const fixturePath = fileURLToPath(
        new URL("./fixtures/bucketing-vectors.json", import.meta.url),
      );
      const vectors: { flag_key: string; subject_key: string; bucket: number }[] = JSON.parse(
        readFileSync(fixturePath, "utf-8"),
      );

      // A single-rule flag with a 30/70 rollout split between two variations.
      const rolloutFlag = flag({
        rules: [
          {
            conditions: [],
            outcome: {
              rollout: [
                { variation_key: "on", percentage: 30 },
                { variation_key: "off", percentage: 70 },
              ],
            },
          },
        ],
      });

      for (const vector of vectors.slice(0, 50)) {
        const b = bucket(rolloutFlag.flag_key, vector.subject_key);
        const expectedKey = b < 3000 ? "on" : "off";

        const result = evaluateFlag(rolloutFlag, 1, vector.subject_key);

        expect(result.variation_key).toBe(expectedKey);
        expect(result.reason).toBe("rule_match");
      }
    });
  });
});
