import type { Configuration, FlagConfig } from "@rollfuse/contracts";
import { describe, expect, it, vi } from "vitest";
import { RollfuseClient } from "../src/client.js";
import bucketingVectorsJson from "../../evaluation-core/test/fixtures/bucketing-vectors.json" with { type: "json" };
import rolloutVectorsJson from "../../evaluation-core/test/fixtures/rollout-outcome-vectors.json" with { type: "json" };

/**
 * harden-sdk-runtime task 11.1: proves `RollfuseClient.evaluate` — this
 * package's public evaluation path, exactly as an integrator calls it —
 * matches every vector in the shared cross-language conformance fixture
 * (both halves: bucketing and rollout-outcome resolution), not just
 * `@rollfuse/evaluation-core`'s own tests of the functions this client
 * wraps. `sdk-browser/test/parity.test.ts` (task 1.4) is this package's
 * template, extended here to also cover the bucketing half that one still
 * omits (see its own follow-up for that).
 */
interface BucketingVector {
  flag_key: string;
  subject_key: string;
  bucket: number;
}

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

const bucketingVectors = bucketingVectorsJson as BucketingVector[];
const rolloutVectors = rolloutVectorsJson as RolloutOutcomeVector[];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function clientFor(flag: FlagConfig): Promise<RollfuseClient> {
  const config: Configuration = {
    environment_id: "env_1",
    version: 7,
    format_version: 1,
    poll_interval_seconds: 30,
    flags: [flag],
  };
  const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(config));
  const client = new RollfuseClient({ baseUrl: "http://api.test", credential: "svc_test.secret", fetchImpl });

  await client.start();

  return client;
}

function flagFromRolloutVector(vector: RolloutOutcomeVector): FlagConfig {
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

// A 100-way, 1%-wide rollout maps bucket range [i*100, (i+1)*100) to
// variation "v{i}" (PERCENTAGE_SCALE = BUCKET_MODULUS/100 = 100, see
// evaluation-core/src/evaluate.ts's own resolveOutcome), so the variation
// the client resolves to pins down exactly which 100-wide range the
// fixture's own precomputed bucket value falls in — the only way to
// observe bucket() indirectly through the public evaluate() path, since
// evaluate() never returns a raw bucket number itself.
function flagFromBucketingVector(vector: BucketingVector): FlagConfig {
  return {
    flag_key: vector.flag_key,
    enabled: true,
    default_variation: "v0",
    variations: Array.from({ length: 100 }, (_, i) => ({ key: `v${i}`, value: null })),
    rules: [
      {
        conditions: [],
        outcome: {
          rollout: Array.from({ length: 100 }, (_, i) => ({ variation_key: `v${i}`, percentage: 1 })),
        },
      },
    ],
  };
}

describe("evaluation parity with the shared conformance fixture", () => {
  it("has non-empty bucketing and rollout-outcome fixtures to check against", () => {
    expect(bucketingVectors.length).toBeGreaterThan(0);
    expect(rolloutVectors.length).toBeGreaterThan(0);
  });

  for (const vector of bucketingVectors) {
    it(`evaluate() resolves the bucketing fixture's known bucket for ${vector.flag_key}/${vector.subject_key}`, async () => {
      const flag = flagFromBucketingVector(vector);
      const client = await clientFor(flag);

      const result = client.evaluate(vector.subject_key, vector.flag_key);

      expect(result.reason).toBe("rule_match");
      expect(result.variation_key).toBe(`v${Math.floor(vector.bucket / 100)}`);

      client.stop();
    });
  }

  for (const vector of rolloutVectors) {
    it(`evaluate(): ${vector.description}`, async () => {
      const flag = flagFromRolloutVector(vector);
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
});
