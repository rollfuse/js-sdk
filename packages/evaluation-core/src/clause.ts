/**
 * Typed attributes and the closed nine-operator set,
 * expand-targeting-model task 4.7's js-sdk half — independently
 * implementing `apps/api/internal/evaluation/domain/clause.go` (no
 * shared code, matching go-sdk's own independent implementation).
 *
 * `@rollfuse/contracts`'s generated `FlagConfig` type does not yet
 * declare a `clauses`/`Clause` shape (the contract change is a separate,
 * in-flight task), so this module reads a rule's clause off the wire
 * object at runtime via `readClause` rather than through a generated
 * type — the same tolerant, fail-safe-on-unrecognized-shape posture
 * `evaluate.ts`'s own `isVariationLike` already uses for a config
 * element that predates full type coverage.
 */

export type AttributeType = "string" | "number" | "boolean" | "list";

export interface AttributeValue {
  type: AttributeType;
  string?: string;
  number?: number;
  boolean?: boolean;
  list?: string[];
}

export function stringAttr(value: string): AttributeValue {
  return { type: "string", string: value };
}
export function numberAttr(value: number): AttributeValue {
  return { type: "number", number: value };
}
export function boolAttr(value: boolean): AttributeValue {
  return { type: "boolean", boolean: value };
}
export function listAttr(value: string[]): AttributeValue {
  return { type: "list", list: value };
}

/** Converts a plain string-attribute map into typed AttributeValues, preserving evaluateFlag's existing equality-only behavior for every caller before this task. */
export function stringAttributesToTyped(
  attributes: Record<string, string>,
): Record<string, AttributeValue> {
  const typed: Record<string, AttributeValue> = {};

  for (const [name, value] of Object.entries(attributes)) {
    typed[name] = stringAttr(value);
  }

  return typed;
}

/**
 * The enumerated, closed operator set — see design.md's "The operator
 * set is enumerated and closed" decision. Never grows informally.
 */
export type ClauseOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "prefix"
  | "suffix"
  | "substring"
  | "regex"
  | "semver_gt"
  | "semver_gte"
  | "semver_lt"
  | "semver_lte"
  | "present";

export interface Clause {
  attribute: string;
  type: AttributeType;
  op: ClauseOp;
  value?: AttributeValue;
  /** Only meaningful for "in": the candidate set, always string form. */
  candidates?: string[];
}

/**
 * A backreference (`\1`, `\k<name>`) or lookaround (`(?=`, `(?!`,
 * `(?<=`, `(?<!`) construct — native JS `RegExp` accepts both, and both
 * can cause catastrophic (non-linear) backtracking. Go's stdlib
 * `regexp` is RE2-native and structurally cannot express either, so the
 * platform and go-sdk get the bound "for free" by compiling with it;
 * js-sdk must check explicitly before ever calling `new RegExp(...)`,
 * both here (evaluation-time defence in depth) and wherever a pattern
 * is authored.
 */
const EXCLUDED_REGEX_CONSTRUCTS = /\\[1-9]|\\k<|\(\?[=!]|\(\?<[=!]/;

/** Reports whether pattern is expressible in the bounded RE2-safe subset (expand-targeting-model task 1.2's decision). */
export function isBoundedRegex(pattern: string): boolean {
  if (EXCLUDED_REGEX_CONSTRUCTS.test(pattern)) {
    return false;
  }

  try {
    void new RegExp(pattern);

    return true;
  } catch {
    return false;
  }
}

/** Reads a rule's "clauses" array (rule.clauses[0], section 4's single-leaf scope) off an otherwise-untyped wire rule object, or undefined if absent/malformed. */
export function readClause(rule: unknown): Clause | undefined {
  if (typeof rule !== "object" || rule === null || !("clauses" in rule)) {
    return undefined;
  }

  const clauses = (rule as { clauses?: unknown }).clauses;

  if (!Array.isArray(clauses) || clauses.length === 0) {
    return undefined;
  }

  return decodeClause(clauses[0]);
}

function decodeClause(raw: unknown): Clause | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const r = raw as Record<string, unknown>;
  const attribute = typeof r.attribute === "string" ? r.attribute : "";
  const type: AttributeType = r.type === "number" || r.type === "boolean" || r.type === "list" ? r.type : "string";
  const op: ClauseOp = isKnownOp(r.op) ? r.op : "eq";

  if (op === "present") {
    return { attribute, type, op };
  }

  if (op === "in") {
    const candidates = Array.isArray(r.value) ? r.value.map((v) => String(v)) : [];

    return { attribute, type, op, candidates };
  }

  const value = decodeAttributeValue(type, r.value);

  return { attribute, type, op, value };
}

function isKnownOp(op: unknown): op is ClauseOp {
  return (
    typeof op === "string" &&
    [
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "prefix",
      "suffix",
      "substring",
      "regex",
      "semver_gt",
      "semver_gte",
      "semver_lt",
      "semver_lte",
      "present",
    ].includes(op)
  );
}

function decodeAttributeValue(type: AttributeType, raw: unknown): AttributeValue {
  switch (type) {
    case "number":
      return { type, number: typeof raw === "number" ? raw : Number.NaN };
    case "boolean":
      return { type, boolean: typeof raw === "boolean" ? raw : false };
    case "list":
      return { type, list: Array.isArray(raw) ? raw.map((v) => String(v)) : [] };
    default:
      return { type: "string", string: typeof raw === "string" ? raw : "" };
  }
}

/**
 * Reports whether attributes satisfies clause. Never throws: an absent
 * attribute, a type mismatch, or an invalid literal (a "gt" clause
 * against a non-numeric attribute, an unparsable semver, an excluded
 * regex construct) all evaluate false. The diagnostic explains why, for
 * a caller that wants to surface it, without changing the boolean
 * outcome — matches the platform's own Clause.Match semantics.
 */
export function matchClause(
  clause: Clause,
  attributes: Record<string, AttributeValue>,
): { matched: boolean; diagnostic?: string } {
  const value = attributes[clause.attribute];

  if (clause.op === "present") {
    return { matched: value !== undefined };
  }

  if (value === undefined) {
    return { matched: false };
  }

  if (value.type !== clause.type) {
    return { matched: false, diagnostic: `type mismatch on attribute "${clause.attribute}"` };
  }

  switch (clause.op) {
    case "eq":
      return { matched: equalAttributeValue(value, clause.value) };
    case "neq":
      return { matched: !equalAttributeValue(value, clause.value) };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return matchOrdered(clause.op, value, clause.value);
    case "in":
      return { matched: matchIn(clause.type, value, clause.candidates ?? []) };
    case "prefix":
      return { matched: value.type === "string" && (value.string ?? "").startsWith(clause.value?.string ?? "") };
    case "suffix":
      return { matched: value.type === "string" && (value.string ?? "").endsWith(clause.value?.string ?? "") };
    case "substring":
      return { matched: value.type === "string" && (value.string ?? "").includes(clause.value?.string ?? "") };
    case "regex":
      return matchRegex(value.string ?? "", clause.value?.string ?? "");
    case "semver_gt":
    case "semver_gte":
    case "semver_lt":
    case "semver_lte":
      return matchSemver(clause.op, value.string ?? "", clause.value?.string ?? "");
    default:
      return { matched: false, diagnostic: `unrecognized operator "${String(clause.op)}" on attribute "${clause.attribute}"` };
  }
}

function equalAttributeValue(a: AttributeValue, b: AttributeValue | undefined): boolean {
  if (!b) {
    return false;
  }

  switch (a.type) {
    case "string":
      return a.string === b.string;
    case "number":
      return a.number === b.number;
    case "boolean":
      return a.boolean === b.boolean;
    case "list":
      return (
        Array.isArray(a.list) &&
        Array.isArray(b.list) &&
        a.list.length === b.list.length &&
        a.list.every((v, i) => v === b.list?.[i])
      );
    default:
      return false;
  }
}

function matchOrdered(
  op: "gt" | "gte" | "lt" | "lte",
  attribute: AttributeValue,
  literal: AttributeValue | undefined,
): { matched: boolean; diagnostic?: string } {
  if (attribute.type !== "number" || !literal) {
    return { matched: false, diagnostic: "ordered comparison requires a number attribute" };
  }

  const a = attribute.number ?? Number.NaN;
  const b = literal.number ?? Number.NaN;

  switch (op) {
    case "gt":
      return { matched: a > b };
    case "gte":
      return { matched: a >= b };
    case "lt":
      return { matched: a < b };
    case "lte":
      return { matched: a <= b };
  }
}

function matchIn(clauseType: AttributeType, attribute: AttributeValue, candidates: string[]): boolean {
  if (clauseType === "list") {
    if (attribute.type !== "list" || !Array.isArray(attribute.list)) {
      return false;
    }

    return attribute.list.some((have) => candidates.includes(have));
  }

  const asString = scalarAsString(attribute);

  return asString !== undefined && candidates.includes(asString);
}

function scalarAsString(v: AttributeValue): string | undefined {
  switch (v.type) {
    case "string":
      return v.string;
    case "number":
      return v.number === undefined ? undefined : String(v.number);
    case "boolean":
      return v.boolean === undefined ? undefined : String(v.boolean);
    default:
      return undefined;
  }
}

/**
 * Implements the bounded regex operator. `isBoundedRegex` is checked
 * first — see its own doc comment for why JS needs this and Go/the
 * platform don't.
 */
function matchRegex(subject: string, pattern: string): { matched: boolean; diagnostic?: string } {
  if (!isBoundedRegex(pattern)) {
    return { matched: false, diagnostic: "regex clause has an invalid or unbounded pattern" };
  }

  try {
    return { matched: new RegExp(pattern).test(subject) };
  } catch {
    return { matched: false, diagnostic: "regex clause has an invalid pattern" };
  }
}

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Extracts major.minor.patch, tolerating a leading "v" and any trailing pre-release/build suffix. Returns undefined for anything that doesn't begin with three dot-separated non-negative integers. */
function parseSemver(s: string): SemanticVersion | undefined {
  const trimmed = s.startsWith("v") ? s.slice(1) : s;
  const withoutSuffix = trimmed.split(/[-+]/, 1)[0];
  const parts = withoutSuffix.split(".");

  if (parts.length !== 3) {
    return undefined;
  }

  const nums = parts.map((p) => Number(p));

  if (nums.some((n) => !Number.isInteger(n) || n < 0)) {
    return undefined;
  }

  return { major: nums[0], minor: nums[1], patch: nums[2] };
}

function compareSemver(a: SemanticVersion, b: SemanticVersion): number {
  if (a.major !== b.major) return Math.sign(a.major - b.major);
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor);

  return Math.sign(a.patch - b.patch);
}

function matchSemver(
  op: "semver_gt" | "semver_gte" | "semver_lt" | "semver_lte",
  subject: string,
  literal: string,
): { matched: boolean; diagnostic?: string } {
  const subjectVersion = parseSemver(subject);
  if (!subjectVersion) {
    return { matched: false, diagnostic: `attribute value "${subject}" is not a valid semantic version` };
  }

  const literalVersion = parseSemver(literal);
  if (!literalVersion) {
    return { matched: false, diagnostic: `clause literal "${literal}" is not a valid semantic version` };
  }

  const cmp = compareSemver(subjectVersion, literalVersion);

  switch (op) {
    case "semver_gt":
      return { matched: cmp > 0 };
    case "semver_gte":
      return { matched: cmp >= 0 };
    case "semver_lt":
      return { matched: cmp < 0 };
    case "semver_lte":
      return { matched: cmp <= 0 };
  }
}
