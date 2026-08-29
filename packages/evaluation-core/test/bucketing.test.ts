import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bucket, BUCKET_MODULUS } from "../src/bucketing.js";

/**
 * This fixture is the cross-language parity contract described in
 * add-sdk-js's design.md decision 3: generated once from
 * `apps/api/internal/evaluation/domain/bucketing.go`'s `Bucket()` (see
 * that Go package's own `TestBucket_GoldenVectors`), checked in here, and
 * asserted against this package's own `bucket()`. If a future change to
 * either implementation's output ever diverges from this fixture, this
 * test fails on the JS side and `TestBucket_GoldenVectors` fails
 * identically on the Go side — the two implementations can never silently
 * drift apart.
 */
const fixturePath = fileURLToPath(
  new URL("./fixtures/bucketing-vectors.json", import.meta.url),
);

interface GoldenVector {
  flag_key: string;
  subject_key: string;
  bucket: number;
}

const vectors: GoldenVector[] = JSON.parse(readFileSync(fixturePath, "utf-8"));

describe("bucket", () => {
  it("has a non-empty golden-vector fixture", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  it("matches every golden vector generated from the Go implementation", () => {
    for (const vector of vectors) {
      expect(bucket(vector.flag_key, vector.subject_key)).toBe(vector.bucket);
    }
  });

  it("is deterministic across repeated calls", () => {
    const first = bucket("checkout-redesign", "user_123");

    for (let i = 0; i < 100; i++) {
      expect(bucket("checkout-redesign", "user_123")).toBe(first);
    }
  });

  it("is independent across flag keys for at least some subjects", () => {
    let differs = false;

    for (let i = 0; i < 50; i++) {
      const subject = `user_${i}`;

      if (bucket("flag-a", subject) !== bucket("flag-b", subject)) {
        differs = true;
        break;
      }
    }

    expect(differs).toBe(true);
  });

  it("stays within [0, BUCKET_MODULUS)", () => {
    for (let i = 0; i < 200; i++) {
      const result = bucket("some-flag", `subject-${i}`);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(BUCKET_MODULUS);
    }
  });
});
