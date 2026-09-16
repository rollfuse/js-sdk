import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FlagConfig } from "@rollfuse/contracts";
import { describe, expect, it } from "vitest";
import { evaluateFlagTyped, type AttributeValue } from "../src/evaluate.js";

/**
 * expand-targeting-model task 1.1's fixture, shared verbatim with
 * apps/api/internal/evaluation/domain/testdata (see that package's own
 * targeting_model_test.go for the scoping rationale, and go-sdk's own
 * mirror for the same 19-vector count). Task 4.7 only implements
 * single-leaf clauses — composition, individual targets, prerequisites
 * and segment-membership clauses are sections 5-7's job.
 */
const fixturePath = fileURLToPath(new URL("./fixtures/targeting-model-vectors.json", import.meta.url));

const WANT_SINGLE_LEAF_VECTORS_PASSING = 19;

/**
 * How many vectors are section 5's own scope (composition/negation/
 * nesting, individual targets, prerequisites) — matches apps/api's and
 * go-sdk's own TestTargetingModel_CompositionVectors count.
 */
const WANT_COMPOSITION_VECTORS_PASSING = 10;

interface ClauseVector {
  op?: string;
  attribute?: string;
  type?: string;
  value?: unknown;
  clauses?: ClauseVector[];
  clause?: ClauseVector;
  segment_key?: string;
}

interface RuleVector {
  clause?: ClauseVector | null;
  outcome: { variation_key?: string; rollout?: unknown };
}

interface AttributeVector {
  type: string;
  value: unknown;
}

interface IndividualTargetVector {
  variation_key: string;
  subject_keys: string[];
}

interface PrerequisiteVector {
  flag_key: string;
  required_variation_key: string;
}

interface TargetingModelVector {
  description: string;
  flag_key: string;
  variations: { key: string }[];
  default_variation_key: string;
  rules: RuleVector[];
  subject_key: string;
  attributes: Record<string, AttributeVector>;
  expected_variation_key: string;
  expected_reason: string;
  individual_targets?: IndividualTargetVector[];
  prerequisites?: PrerequisiteVector[];
  /**
   * For each prerequisite this vector's own `prerequisites` reference
   * (transitively, for a chain), the fixed variation key that flag
   * should resolve to — see buildPrerequisiteFlags' own doc comment.
   * Mirrors apps/api's and go-sdk's own fixture-consumption shape.
   */
  prerequisite_states?: Record<string, string>;
  segments?: unknown;
}

const vectors: TargetingModelVector[] = JSON.parse(readFileSync(fixturePath, "utf-8"));

function isSingleLeaf(clause: ClauseVector | null | undefined): boolean {
  if (!clause) return true;

  return !["and", "or", "not", "segment"].includes(clause.op ?? "");
}

function isSingleVariationOutcome(rule: RuleVector): boolean {
  return rule.outcome.rollout === undefined || rule.outcome.rollout === null;
}

function isSingleLeafScope(vector: TargetingModelVector): boolean {
  if (vector.individual_targets || vector.prerequisites || vector.segments) {
    return false;
  }

  return vector.rules.every((rule) => isSingleLeaf(rule.clause) && isSingleVariationOutcome(rule));
}

/**
 * isCompositionScope reports whether this vector is section 5's own
 * scope: composition (AND/OR/negation/nesting), individual targets or
 * prerequisites, excluding a segment reference (section 7, not
 * implemented) or a rollout outcome. Partitions the fixture against
 * isSingleLeafScope so the two describe blocks never double-cover a
 * vector.
 */
function isCompositionScope(vector: TargetingModelVector): boolean {
  if (vector.segments) {
    return false;
  }

  if (!vector.rules.every((rule) => isSingleVariationOutcome(rule))) {
    return false;
  }

  if (vector.individual_targets || vector.prerequisites) {
    return true;
  }

  return vector.rules.some((rule) => !isSingleLeaf(rule.clause));
}

function buildFullFlagConfig(vector: TargetingModelVector): FlagConfig {
  return {
    flag_key: vector.flag_key,
    enabled: true,
    default_variation: vector.default_variation_key,
    variations: vector.variations.map((v) => ({ key: v.key, value: null })),
    rules: vector.rules.map((rule) => ({
      // "condition"/"individual_targets"/"prerequisites" are not yet
      // part of @rollfuse/contracts's generated FlagConfig type (a
      // separate, in-flight contract task) — the casts below stage the
      // wire shape readCondition/readIndividualTargets/readPrerequisites
      // (clause.ts) read at runtime, matching how a real future-format
      // Configuration would actually arrive over the wire.
      ...(rule.clause ? { condition: rule.clause } : {}),
      outcome: { variation_key: rule.outcome.variation_key },
    })) as FlagConfig["rules"],
    ...(vector.individual_targets ? { individual_targets: vector.individual_targets } : {}),
    ...(vector.prerequisites ? { prerequisites: vector.prerequisites } : {}),
  } as FlagConfig;
}

/**
 * Synthesizes a minimal FlagConfig for every entry in
 * vector.prerequisite_states: an always-enabled, unconditional flag
 * whose single variation and rule resolve deterministically to the
 * stated value, regardless of subject or attributes — mirrors apps/api's
 * and go-sdk's own test helper of the same name and purpose.
 */
function buildPrerequisiteFlags(vector: TargetingModelVector): FlagConfig[] {
  return Object.entries(vector.prerequisite_states ?? {}).map(([flagKey, variationKey]) => ({
    flag_key: flagKey,
    enabled: true,
    default_variation: variationKey,
    variations: [{ key: variationKey, value: null }],
    rules: [{ outcome: { variation_key: variationKey } }],
  })) as FlagConfig[];
}

function buildFlagConfig(vector: TargetingModelVector): FlagConfig {
  return {
    flag_key: vector.flag_key,
    enabled: true,
    default_variation: vector.default_variation_key,
    variations: vector.variations.map((v) => ({ key: v.key, value: null })),
    rules: vector.rules.map((rule) => ({
      // "clauses" is not yet part of @rollfuse/contracts's generated
      // FlagConfig type (a separate, in-flight contract task) — the cast
      // below stages the wire shape readClause (evaluate.ts) reads at
      // runtime, matching how a real future-format Configuration would
      // actually arrive over the wire.
      ...(rule.clause ? { clauses: [rule.clause] } : {}),
      outcome: { variation_key: rule.outcome.variation_key },
    })) as FlagConfig["rules"],
  };
}

function buildAttributes(vector: TargetingModelVector): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};

  for (const [name, attr] of Object.entries(vector.attributes ?? {})) {
    switch (attr.type) {
      case "number":
        attributes[name] = { type: "number", number: attr.value as number };
        break;
      case "boolean":
        attributes[name] = { type: "boolean", boolean: attr.value as boolean };
        break;
      case "list":
        attributes[name] = { type: "list", list: attr.value as string[] };
        break;
      default:
        attributes[name] = { type: "string", string: attr.value as string };
    }
  }

  return attributes;
}

describe("evaluateFlagTyped targeting model vectors", () => {
  const inScope = vectors.filter(isSingleLeafScope);

  it(`covers exactly ${WANT_SINGLE_LEAF_VECTORS_PASSING} single-leaf-clause vectors`, () => {
    expect(inScope.length).toBe(WANT_SINGLE_LEAF_VECTORS_PASSING);
  });

  it.each(inScope)("$description", (vector) => {
    const flag = buildFlagConfig(vector);
    const attributes = buildAttributes(vector);

    const result = evaluateFlagTyped([], flag, 1, vector.subject_key, attributes);

    expect(result.variation_key).toBe(vector.expected_variation_key);
    expect(result.reason).toBe(vector.expected_reason);
  });
});

describe("evaluateFlagTyped composition/individual-target/prerequisite vectors", () => {
  const inScope = vectors.filter(isCompositionScope);

  it(`covers exactly ${WANT_COMPOSITION_VECTORS_PASSING} composition/individual-target/prerequisite vectors`, () => {
    expect(inScope.length).toBe(WANT_COMPOSITION_VECTORS_PASSING);
  });

  it.each(inScope)("$description", (vector) => {
    const flag = buildFullFlagConfig(vector);
    const attributes = buildAttributes(vector);
    const flags = [...buildPrerequisiteFlags(vector), flag];

    const result = evaluateFlagTyped(flags, flag, 1, vector.subject_key, attributes);

    expect(result.variation_key).toBe(vector.expected_variation_key);
    expect(result.reason).toBe(vector.expected_reason);
  });
});

const WANT_SEGMENT_VECTORS_PASSING = 3;

function isSegmentScope(vector: TargetingModelVector): boolean {
  return Boolean(vector.segments);
}

/**
 * resolveSegmentClause substitutes every {op: "segment", segment_key}
 * node, recursively, with the referenced segment's own raw clause —
 * operating on the fixture's raw wire shape (the same shape
 * decodeClauseTree in clause.ts reads), mirroring apps/api's
 * domain.ResolveSegments exactly. This package has no segment-resolution
 * code of its own (reusable-segments' own requirement is met
 * structurally: the platform never ships an unresolved segment reference
 * to any client — see decodeClauseTree's own "segment" case, an
 * always-non-matching fail-safe fallback for a reference that should
 * never actually arrive), so this function exists only here, in the
 * test, standing in for what the platform already does server-side
 * before task 7.7's own claim ("no client ever evaluates a segment
 * reference differently from the platform") can be checked end-to-end
 * through this client's real evaluateFlagTyped, not merely reasoned
 * about structurally.
 */
function resolveSegmentClause(
  clause: ClauseVector | null | undefined,
  segments: Record<string, { clause: ClauseVector }>,
): ClauseVector | null | undefined {
  if (!clause) {
    return clause;
  }

  if (clause.op === "segment") {
    const segment = clause.segment_key ? segments[clause.segment_key] : undefined;

    if (!segment) {
      throw new Error(`fixture error: unknown segment ${String(clause.segment_key)}`);
    }

    return resolveSegmentClause(segment.clause, segments);
  }

  if (clause.op === "not" && clause.clause) {
    return { ...clause, clause: resolveSegmentClause(clause.clause, segments) ?? undefined };
  }

  if ((clause.op === "and" || clause.op === "or") && clause.clauses) {
    return {
      ...clause,
      clauses: clause.clauses
        .map((child) => resolveSegmentClause(child, segments))
        .filter((child): child is ClauseVector => child != null),
    };
  }

  return clause;
}

function buildSegmentResolvedFlagConfig(vector: TargetingModelVector): FlagConfig {
  const segments = (vector.segments ?? {}) as Record<string, { clause: ClauseVector }>;

  return {
    flag_key: vector.flag_key,
    enabled: true,
    default_variation: vector.default_variation_key,
    variations: vector.variations.map((v) => ({ key: v.key, value: null })),
    rules: vector.rules.map((rule) => ({
      ...(rule.clause ? { condition: resolveSegmentClause(rule.clause, segments) } : {}),
      outcome: { variation_key: rule.outcome.variation_key },
    })) as FlagConfig["rules"],
  } as FlagConfig;
}

/**
 * expand-targeting-model task 7.7: proves — rather than only reasons
 * about structurally — that this client evaluates a segment-membership
 * Rule identically to the platform, by resolving the fixture's raw
 * segment reference exactly as the platform's own
 * domain.ResolveSegments does, then running the RESULT through this
 * client's real evaluateFlagTyped, the same entry point every other
 * vector in this file goes through.
 */
describe("evaluateFlagTyped segment-membership vectors (resolved exactly as the platform resolves them before serving)", () => {
  const inScope = vectors.filter(isSegmentScope);

  it(`covers exactly ${WANT_SEGMENT_VECTORS_PASSING} segment-membership vectors`, () => {
    expect(inScope.length).toBe(WANT_SEGMENT_VECTORS_PASSING);
  });

  it.each(inScope)("$description", (vector) => {
    const flag = buildSegmentResolvedFlagConfig(vector);
    const attributes = buildAttributes(vector);

    const result = evaluateFlagTyped([], flag, 1, vector.subject_key, attributes);

    expect(result.variation_key).toBe(vector.expected_variation_key);
    expect(result.reason).toBe(vector.expected_reason);
  });
});

/**
 * How many of the fixture's vectors are a fractional-rollout outcome
 * (task 2/8.5's own construct) — neither isSingleLeafScope nor
 * isCompositionScope covers a rollout outcome at all. Deliberately does
 * NOT include the fixture's 3 segment-membership vectors: those are
 * isSegmentScope's own count, run separately above (each is a
 * single-variation outcome, not a rollout, so this exclusion is a
 * category boundary, not a gap).
 */
const WANT_ROLLOUT_VECTORS_PASSING = 2;

function isRolloutScope(vector: TargetingModelVector): boolean {
  if (vector.segments) {
    return false;
  }

  return vector.rules.some((rule) => !isSingleVariationOutcome(rule));
}

interface RolloutSplitVector {
  variation_key: string;
  bucket_positions: number;
}

function buildRolloutFlagConfig(vector: TargetingModelVector): FlagConfig {
  return {
    flag_key: vector.flag_key,
    enabled: true,
    default_variation: vector.default_variation_key,
    variations: vector.variations.map((v) => ({ key: v.key, value: null })),
    rules: vector.rules.map((rule) => {
      if (isSingleVariationOutcome(rule)) {
        return { outcome: { variation_key: rule.outcome.variation_key } };
      }

      const splits = rule.outcome.rollout as RolloutSplitVector[];

      return {
        outcome: {
          // The fixture's own unit is bucket positions (10000 = the
          // full space); the wire's own RolloutSplit.percentage is a
          // decimal share of 100, so convert once here rather than
          // adding a second, bucket-position-native field the wire
          // doesn't otherwise carry.
          rollout: splits.map((s) => ({ variation_key: s.variation_key, percentage: s.bucket_positions / 100 })),
        },
      };
    }) as FlagConfig["rules"],
  };
}

/**
 * evaluateFlagTyped rollout vectors is task 9.2's own finding and fix:
 * closes the one real gap isSingleLeafScope/isCompositionScope's own
 * partition left uncovered for this package (the fixture's 3 segment
 * vectors are genuinely out of scope, see isRolloutScope's own comment
 * above). Investigating why this was never run surfaced a more serious,
 * independent bug fixed alongside this test: CLIENT_FORMAT_VERSION
 * (evaluate.ts) was still 1 despite section 5.8 already implementing
 * every FormatVersion2 construct (composed ClauseTree, IndividualTarget,
 * Prerequisite) — meaning the platform has been marking every one of
 * those flags non_evaluable for this client regardless, since version
 * negotiation happens before evaluation ever runs. Manually verified
 * load-bearing: changing buildRolloutFlagConfig's own bucket-position-
 * to-percentage conversion divisor from 100 to 10000 (an easy typo given
 * the two different scales in play) turned the precision vector red
 * (default_fallback instead of rule_match); restored before committing.
 */
describe("evaluateFlagTyped rollout vectors", () => {
  const inScope = vectors.filter(isRolloutScope);

  it(`covers exactly ${WANT_ROLLOUT_VECTORS_PASSING} rollout vectors`, () => {
    expect(inScope.length).toBe(WANT_ROLLOUT_VECTORS_PASSING);
  });

  it.each(inScope)("$description", (vector) => {
    const flag = buildRolloutFlagConfig(vector);
    const attributes = buildAttributes(vector);

    const result = evaluateFlagTyped([], flag, 1, vector.subject_key, attributes);

    expect(result.variation_key).toBe(vector.expected_variation_key);
    expect(result.reason).toBe(vector.expected_reason);
  });
});
