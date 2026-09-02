/**
 * The stable bucketing contract, reproduced bit-for-bit from
 * `apps/api/internal/evaluation/domain/bucketing.go`'s `Bucket` function:
 * FNV-1a (32-bit) of `flagKey + ":" + subjectKey`, encoded as UTF-8 bytes
 * (matching Go's `[]byte(string)`, since Go source strings are UTF-8),
 * modulo 10000 for basis-point (0.01%) rollout granularity.
 *
 * This algorithm is a stable, versioned contract (see the Go source's own
 * doc comment): it MUST NOT change in place. JavaScript numbers are not
 * fixed-width integers, so the 32-bit multiply/XOR steps use `Math.imul`
 * (correct 32-bit wraparound multiplication) and a final `>>> 0` (unsigned
 * 32-bit coercion) to match Go's `uint32` arithmetic exactly. Parity with
 * the Go implementation is verified by `test/bucketing.test.ts` against
 * `test/fixtures/bucketing-vectors.json`, a fixture generated once from
 * `Bucket()` itself (see that Go function's own test,
 * `TestBucket_GoldenVectors`) and checked into this package.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** The bucketing space: [0, BUCKET_MODULUS). */
export const BUCKET_MODULUS = 10000;

const textEncoder = new TextEncoder();

function fnv1a32(bytes: Uint8Array): number {
  let hash = FNV_OFFSET_BASIS;

  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV_PRIME);
  }

  return hash >>> 0;
}

/**
 * Deterministically maps a (flagKey, subjectKey) pair to an integer in
 * [0, BUCKET_MODULUS). Depends only on flagKey and subjectKey — never on
 * call order, process, or wall-clock time — so the same pair always
 * buckets identically, matching the API's own `Bucket()`.
 */
export function bucket(flagKey: string, subjectKey: string): number {
  const bytes = textEncoder.encode(`${flagKey}:${subjectKey}`);

  return fnv1a32(bytes) % BUCKET_MODULUS;
}
