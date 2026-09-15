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

interface ClauseVector {
  op?: string;
  attribute?: string;
  type?: string;
  value?: unknown;
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
  individual_targets?: unknown;
  prerequisites?: unknown;
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

    const result = evaluateFlagTyped(flag, 1, vector.subject_key, attributes);

    expect(result.variation_key).toBe(vector.expected_variation_key);
    expect(result.reason).toBe(vector.expected_reason);
  });
});
