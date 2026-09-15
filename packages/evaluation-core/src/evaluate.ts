import type { EvaluationResult, FlagConfig } from "@rollfuse/contracts";
import { bucket, BUCKET_MODULUS } from "./bucketing.js";
import {
  type AttributeValue,
  matchClause,
  readClause,
  stringAttributesToTyped,
} from "./clause.js";

export type {
  AttributeType,
  AttributeValue,
  Clause,
  ClauseOp,
} from "./clause.js";
export { boolAttr, isBoundedRegex, listAttr, numberAttr, stringAttr } from "./clause.js";

/**
 * Deterministic, local flag evaluation — reproduced line-for-line from
 * `apps/api/internal/evaluation/domain/configuration.go`'s `Evaluate`,
 * `Outcome.resolve` and `Rule.matches`, per `openspec/specs/sdk-js/spec.md`'s
 * "Deterministic Local Evaluation" requirement:
 *
 *   - a disabled flag always resolves to its default variation
 *     ("default_disabled"), without evaluating any rule;
 *   - an enabled flag evaluates rules in order; the first rule whose
 *     conditions match wins ("rule_match");
 *   - a rule's conditions are an AND of strict string-equality checks — a
 *     missing attribute never matches;
 *   - a matched rule's outcome is either a fixed variation_key, or a
 *     percentage rollout resolved via the stable bucketing contract,
 *     walking the rollout's splits in array order using cumulative bucket
 *     ranges;
 *   - if no rule matches, the default variation is served
 *     ("default_no_rule_match");
 *   - if a matched rule's outcome cannot be resolved to a known variation
 *     (should not happen for validly-constructed configuration), the
 *     default variation is still served ("default_fallback") rather than
 *     throwing.
 *
 * Never throws: every input resolves to some variation of flag.
 */

const PERCENTAGE_SCALE = BUCKET_MODULUS / 100;

/**
 * The highest configuration format version this package's evaluation
 * logic can interpret — declared to the platform on every GET /v1/config
 * request via a client's own X-Rollfuse-Client-Format-Version header, per
 * expand-targeting-model task 3.1. Bump this only alongside actually
 * implementing whatever new construct the next format version introduces
 * (task 3.5: a client must never evaluate a construct it does not
 * support).
 */
export const CLIENT_FORMAT_VERSION = 1;

type Rule = FlagConfig["rules"][number];
type Outcome = Rule["outcome"];
type RolloutSplit = NonNullable<Outcome["rollout"]>[number];

/**
 * Converts a rollout split's wire percentage into bucket positions, the
 * space `resolveOutcome` actually accumulates in — mirrors the platform's
 * own `RolloutSplit.BucketPositions` and go-sdk's `RolloutSplit.bucketPositions()`
 * (expand-targeting-model task 2.2). The wire still carries a whole
 * percentage (1-100) as of this task — no format-versioning change has
 * landed yet — so this is a structural fix, not a behavior change: the
 * conversion is exact for any whole percentage, and `number` here
 * represents it exactly (well within `Number.MAX_SAFE_INTEGER`).
 */
function bucketPositions(split: RolloutSplit): number {
  return split.percentage * PERCENTAGE_SCALE;
}

function conditionsMatch(
  conditions: Rule["conditions"],
  attributes: Record<string, string>,
): boolean {
  if (!conditions) {
    return true;
  }

  for (const condition of conditions) {
    const value = attributes[condition.attribute];

    if (value === undefined || value !== condition.value) {
      return false;
    }
  }

  return true;
}

/**
 * Reports whether rule matches attributes, preferring its "clauses"
 * shape (expand-targeting-model task 4.7) when present — read via
 * readClause since @rollfuse/contracts's generated FlagConfig type does
 * not yet declare it — and falling back to the pre-existing
 * conditions-based equality-only matching for a rule published before
 * this task (never both on the same rule in practice).
 */
function ruleMatches(rule: Rule, attributes: Record<string, AttributeValue>): boolean {
  const clause = readClause(rule);

  if (clause) {
    return matchClause(clause, attributes).matched;
  }

  const stringAttributes: Record<string, string> = {};

  for (const [name, value] of Object.entries(attributes)) {
    if (value.type === "string" && value.string !== undefined) {
      stringAttributes[name] = value.string;
    }
  }

  return conditionsMatch(rule.conditions, stringAttributes);
}

/** Resolves outcome to a variation key, or undefined if it cannot be. */
function resolveOutcome(
  outcome: Outcome,
  flagKey: string,
  subjectKey: string,
): string | undefined {
  if (outcome.rollout && outcome.rollout.length > 0) {
    const subjectBucket = bucket(flagKey, subjectKey);
    let cumulative = 0;

    for (const split of outcome.rollout) {
      cumulative += bucketPositions(split);

      if (subjectBucket < cumulative) {
        return split.variation_key;
      }
    }

    return undefined;
  }

  return outcome.variation_key || undefined;
}

type Variation = FlagConfig["variations"][number];

/**
 * Guards against a malformed element slipping past whatever validated the
 * fetched Configuration (defence in depth per sdk-conformance's
 * "Evaluation Never Throws And Never Serves Invalid Configuration"
 * requirement, task 5.3): a caller of this module's exported evaluateFlag
 * directly, bypassing a client's own config-client validation, is exactly
 * the case this guards, in addition to any validation gap.
 */
function isVariationLike(value: unknown): value is Variation {
  return typeof value === "object" && value !== null && typeof (value as { key?: unknown }).key === "string";
}

function hasVariation(flag: FlagConfig, key: string): boolean {
  return Array.isArray(flag.variations) && flag.variations.some((v: unknown) => isVariationLike(v) && v.key === key);
}

function variationValue(flag: FlagConfig, key: string): unknown {
  if (!Array.isArray(flag.variations)) {
    return undefined;
  }

  return flag.variations.find((v: unknown) => isVariationLike(v) && v.key === key)?.value;
}

function defaultResult(
  flag: FlagConfig,
  configVersion: number,
  reason: EvaluationResult["reason"],
): EvaluationResult {
  return {
    flag_key: flag.flag_key,
    variation_key: flag.default_variation,
    value: variationValue(flag, flag.default_variation),
    reason,
    config_version: configVersion,
    track_exposure: false,
  };
}

/**
 * Evaluates flag for subjectKey/attributes at configVersion, entirely
 * in-process, against the given FlagConfig. Never throws (task 5.3):
 * wraps the actual evaluation and falls back to the flag's own default
 * variation on any unexpected shape, rather than relying solely on
 * upstream config validation to have caught it — a direct caller of this
 * exported function, bypassing a client's own validated fetch path
 * entirely, is exactly the case this guards.
 */
export function evaluateFlag(
  flag: FlagConfig,
  configVersion: number,
  subjectKey: string,
  attributes: Record<string, string> = {},
): EvaluationResult {
  return evaluateFlagTyped(flag, configVersion, subjectKey, stringAttributesToTyped(attributes));
}

/**
 * evaluateFlag's typed-attribute counterpart (expand-targeting-model
 * task 4.7): the entry point a caller supplying a number, boolean or
 * list attribute (via numberAttr/boolAttr/listAttr, or a client's own
 * typed-attributes option) reaches. Identical evaluation order and
 * fail-safe semantics to evaluateFlag.
 */
export function evaluateFlagTyped(
  flag: FlagConfig,
  configVersion: number,
  subjectKey: string,
  attributes: Record<string, AttributeValue> = {},
): EvaluationResult {
  try {
    return evaluateFlagUnguarded(flag, configVersion, subjectKey, attributes);
  } catch {
    return defaultResult(flag, configVersion, "default_fallback");
  }
}

function evaluateFlagUnguarded(
  flag: FlagConfig,
  configVersion: number,
  subjectKey: string,
  attributes: Record<string, AttributeValue>,
): EvaluationResult {
  if (!flag.enabled) {
    return defaultResult(flag, configVersion, "default_disabled");
  }

  for (const rule of flag.rules) {
    if (!ruleMatches(rule, attributes)) {
      continue;
    }

    const variationKey = resolveOutcome(rule.outcome, flag.flag_key, subjectKey);

    if (!variationKey || !hasVariation(flag, variationKey)) {
      return defaultResult(flag, configVersion, "default_fallback");
    }

    return {
      flag_key: flag.flag_key,
      variation_key: variationKey,
      value: variationValue(flag, variationKey),
      reason: "rule_match",
      config_version: configVersion,
      track_exposure: true,
    };
  }

  return defaultResult(flag, configVersion, "default_no_rule_match");
}
