import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FlagConfig } from "@rollfuse/contracts";
import { describe, expect, it } from "vitest";
import { evaluateFlag } from "../src/evaluate.js";

/**
 * The second half of the cross-implementation conformance fixture (see
 * bucketing.test.ts's own comment for its cross-repo role, and
 * rollfuse/sdk-conformance-fixtures's README): every vector targets a
 * subject whose bucket falls exactly on, or just beside, a rollout split's
 * cumulative boundary, per harden-sdk-runtime task 1.1. This is what a
 * fixture covering only bucketing cannot catch: an off-by-one, or a
 * floating-point rounding difference, in how a client walks cumulative
 * split ranges.
 */
const fixturePath = fileURLToPath(
  new URL("./fixtures/rollout-outcome-vectors.json", import.meta.url),
);

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

const vectors: RolloutOutcomeVector[] = JSON.parse(readFileSync(fixturePath, "utf-8"));

function buildFlagConfig(vector: RolloutOutcomeVector): FlagConfig {
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

describe("evaluateFlag rollout outcome", () => {
  it("has a non-empty golden-vector fixture", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectors) {
    it(vector.description, () => {
      const flag = buildFlagConfig(vector);
      const result = evaluateFlag(flag, 1, vector.subject_key);

      if (vector.expected_variation_key === null) {
        expect(result.reason).toBe("default_fallback");
        expect(result.variation_key).toBe(vector.default_variation_key);
        return;
      }

      expect(result.variation_key).toBe(vector.expected_variation_key);
      expect(result.reason).toBe("rule_match");
    });
  }
});
