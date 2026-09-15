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

/**
 * MAX_CLAUSE_NESTING_DEPTH is expand-targeting-model task 1.2's bound
 * decision (testdata/README.md: "nesting depth 5"), enforced here as a
 * defensive fail-safe against a ClauseTree deeper than authoring should
 * ever have allowed to be persisted — mirrors the platform's own
 * MaxClauseNestingDepth and go-sdk's own constant (independent
 * implementation, same bound).
 */
export const MAX_CLAUSE_NESTING_DEPTH = 5;

export type ClauseTreeOp = "leaf" | "and" | "or" | "not";

/**
 * A rule condition: a single leaf Clause, or a group of child
 * ClauseTrees combined with AND/OR, or a negation of exactly one child —
 * environment-flag-targeting's "Clauses Compose With AND, OR And
 * Negation" requirement. Groups nest to MAX_CLAUSE_NESTING_DEPTH.
 */
export interface ClauseTree {
  op: ClauseTreeOp;
  leaf?: Clause;
  children?: ClauseTree[];
}

/**
 * Reads a rule's "condition" field (the ClauseTree wire shape,
 * expand-targeting-model section 5) off an otherwise-untyped wire rule
 * object, or undefined if absent — same tolerant, runtime-read posture
 * as readClause, since @rollfuse/contracts does not yet declare this
 * shape either.
 */
export function readCondition(rule: unknown): ClauseTree | undefined {
  if (typeof rule !== "object" || rule === null || !("condition" in rule)) {
    return undefined;
  }

  const condition = (rule as { condition?: unknown }).condition;

  if (condition === undefined || condition === null) {
    return undefined;
  }

  return decodeClauseTree(condition);
}

/**
 * Decodes the fixture/wire clause-tree shape (testdata/README.md): a
 * leaf clause has one of the enumerated ClauseOp values directly on
 * "op"; "and"/"or" carry "clauses"; "not" carries a single "clause";
 * "segment" (section 7, not implemented by this package yet) decodes to
 * an always-non-matching leaf rather than failing the whole decode, per
 * feature-evaluation's "A Malformed Or Unsupported Construct Fails Safe"
 * requirement.
 */
function decodeClauseTree(raw: unknown): ClauseTree | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const r = raw as Record<string, unknown>;

  if (r.op === "and" || r.op === "or") {
    const rawChildren = Array.isArray(r.clauses) ? r.clauses : [];
    const children = rawChildren
      .map((c) => decodeClauseTree(c))
      .filter((c): c is ClauseTree => c !== undefined);

    return { op: r.op, children };
  }

  if (r.op === "not") {
    const child = decodeClauseTree(r.clause);

    return { op: "not", children: child ? [child] : [] };
  }

  if (r.op === "segment") {
    return { op: "leaf", leaf: { attribute: "", type: "string", op: "eq" } };
  }

  const leaf = decodeClause(raw);

  return leaf ? { op: "leaf", leaf } : undefined;
}

/**
 * Reports whether attributes satisfies tree, recursively. Negating a
 * "present" leaf naturally implements the spec's "explicit negated
 * presence test" with no special-casing: matchClause's "present" op
 * returns false for an absent attribute, and "not" inverts that to true.
 *
 * depth is the caller's own nesting level (0 for the tree's root).
 * Exceeding MAX_CLAUSE_NESTING_DEPTH fails safe (non-matching, no
 * diagnostic — a defensive bound, not an operator-authored condition).
 */
export function matchClauseTree(
  tree: ClauseTree,
  attributes: Record<string, AttributeValue>,
  depth = 0,
): { matched: boolean; diagnostic?: string } {
  if (depth > MAX_CLAUSE_NESTING_DEPTH) {
    return { matched: false };
  }

  switch (tree.op) {
    case "leaf":
      return tree.leaf ? matchClause(tree.leaf, attributes) : { matched: false };
    case "not": {
      const child = tree.children?.[0];
      if (!child) {
        return { matched: false };
      }

      const result = matchClauseTree(child, attributes, depth + 1);

      return { matched: !result.matched, diagnostic: result.diagnostic };
    }
    case "and": {
      let diagnostic: string | undefined;

      for (const child of tree.children ?? []) {
        const result = matchClauseTree(child, attributes, depth + 1);
        if (result.diagnostic) diagnostic = result.diagnostic;

        if (!result.matched) {
          return { matched: false, diagnostic };
        }
      }

      return { matched: true, diagnostic };
    }
    case "or": {
      let diagnostic: string | undefined;

      for (const child of tree.children ?? []) {
        const result = matchClauseTree(child, attributes, depth + 1);
        if (result.diagnostic) diagnostic = result.diagnostic;

        if (result.matched) {
          return { matched: true, diagnostic };
        }
      }

      return { matched: false, diagnostic };
    }
    default:
      return { matched: false };
  }
}

/** A single-key-listed target evaluated before any rule or rollout — environment-flag-targeting's "A Flag May Target Named Individuals" requirement. */
export interface IndividualTarget {
  variation_key: string;
  subject_keys: string[];
}

/** A dependency on another flag serving required_variation_key before this flag's own targeting applies — environment-flag-targeting's "A Flag May Depend On A Prerequisite Flag" requirement. */
export interface Prerequisite {
  flag_key: string;
  required_variation_key: string;
}

/** Reads a flag's "individual_targets" array off an otherwise-untyped wire flag object, or an empty array if absent/malformed. */
export function readIndividualTargets(flag: unknown): IndividualTarget[] {
  if (typeof flag !== "object" || flag === null || !("individual_targets" in flag)) {
    return [];
  }

  const raw = (flag as { individual_targets?: unknown }).individual_targets;

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter(
      (t): t is { variation_key: string; subject_keys: string[] } =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as { variation_key?: unknown }).variation_key === "string" &&
        Array.isArray((t as { subject_keys?: unknown }).subject_keys),
    )
    .map((t) => ({ variation_key: t.variation_key, subject_keys: t.subject_keys }));
}

/** Reads a flag's "prerequisites" array off an otherwise-untyped wire flag object, or an empty array if absent/malformed. */
export function readPrerequisites(flag: unknown): Prerequisite[] {
  if (typeof flag !== "object" || flag === null || !("prerequisites" in flag)) {
    return [];
  }

  const raw = (flag as { prerequisites?: unknown }).prerequisites;

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter(
      (p): p is { flag_key: string; required_variation_key: string } =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as { flag_key?: unknown }).flag_key === "string" &&
        typeof (p as { required_variation_key?: unknown }).required_variation_key === "string",
    )
    .map((p) => ({ flag_key: p.flag_key, required_variation_key: p.required_variation_key }));
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
