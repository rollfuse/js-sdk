import type { EvaluationResult, FlagConfig } from "@growth-ops/contracts";
import { bucket, BUCKET_MODULUS } from "./bucketing.js";

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

type Rule = FlagConfig["rules"][number];
type Outcome = Rule["outcome"];

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
      cumulative += split.percentage * PERCENTAGE_SCALE;

      if (subjectBucket < cumulative) {
        return split.variation_key;
      }
    }

    return undefined;
  }

  return outcome.variation_key || undefined;
}

type Variation = FlagConfig["variations"][number];

function hasVariation(flag: FlagConfig, key: string): boolean {
  return flag.variations.some((v: Variation) => v.key === key);
}

function variationValue(flag: FlagConfig, key: string): unknown {
  return flag.variations.find((v: Variation) => v.key === key)?.value;
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
 * in-process, against the given FlagConfig.
 */
export function evaluateFlag(
  flag: FlagConfig,
  configVersion: number,
  subjectKey: string,
  attributes: Record<string, string> = {},
): EvaluationResult {
  if (!flag.enabled) {
    return defaultResult(flag, configVersion, "default_disabled");
  }

  for (const rule of flag.rules) {
    if (!conditionsMatch(rule.conditions, attributes)) {
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
