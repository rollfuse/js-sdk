import { createRequire } from "node:module";

import type { AnySchemaObject, ValidateFunction } from "ajv";

import schemas from "./schemas.json" with { type: "json" };

// ajv ships as CommonJS with no "exports" map; under this package's
// NodeNext module resolution, both a static `import Ajv from "ajv"` and
// `import type AjvConstructor from "ajv"` resolve to ajv's module
// namespace type instead of its default-exported class (a known
// interop gap for CJS-default-class-exporting packages under NodeNext —
// esModuleInterop's synthetic default doesn't apply to a genuine
// `export default` declaration the way it does for `export =`). `require`
// via `createRequire` gets the real constructor at runtime; typed here by
// the minimal shape this file actually calls, rather than fighting ajv's
// own type export.
interface AjvInstance {
  addSchema(schema: AnySchemaObject, key: string): void;
  getSchema(ref: string): ValidateFunction | undefined;
}
type AjvConstructor = new (options: { strict: boolean }) => AjvInstance;

const ROOT_ID = "openapi-schemas";

// restore-sdk-release-pipeline task 3.6: ajv moved from a runtime
// `dependency` to an optional peer dependency, since no current consumer
// of this package ever calls validateSchema (every one only does
// `import type`, which TypeScript erases entirely) — an unconditional
// `npm install` of, say, @rollfuse/sdk-browser had no reason to pull in
// ajv's own dependency tree. Requiring it lazily, on first actual call to
// validateSchema, means merely importing this module (which every
// consumer's compiled output still does, even for a type-only import in
// source) never touches ajv at all unless something genuinely calls
// validateSchema — and a consumer that does call it without having ajv
// installed gets one clear error naming the missing peer dependency,
// rather than a crash on import for every consumer regardless of use.
let ajv: AjvInstance | undefined;

function getAjv(): AjvInstance {
  if (ajv) return ajv;

  let Ajv: AjvConstructor;

  try {
    Ajv = createRequire(import.meta.url)("ajv") as AjvConstructor;
  } catch {
    throw new Error(
      'validateSchema: "ajv" is not installed. @rollfuse/contracts declares it as an ' +
        "optional peer dependency — install ajv (^8.0.0) in your own project to use validateSchema.",
    );
  }

  // One Ajv instance for the whole package, holding every schema from
  // `schemas.json` under a single root document so `$ref`s between schemas
  // (e.g. `FeatureFlag.variations` referencing `#/components/schemas/
  // Variation`) resolve exactly as they do in the source OpenAPI document —
  // see design.md Decision 2 in `strengthen-contracts-typing`.
  ajv = new Ajv({ strict: false });
  ajv.addSchema({ components: { schemas } }, ROOT_ID);

  return ajv;
}

const validators = new Map<string, ValidateFunction>();

function validatorFor(schemaName: string): ValidateFunction {
  const cached = validators.get(schemaName);
  if (cached) return cached;

  const validator = getAjv().getSchema(`${ROOT_ID}#/components/schemas/${schemaName}`);

  if (!validator) {
    throw new Error(
      `validateSchema: no schema named "${schemaName}" in schemas.json — check the spelling against openapi/openapi.yaml's components.schemas keys.`,
    );
  }

  validators.set(schemaName, validator);

  return validator;
}

/**
 * Validates value against the named OpenAPI schema (a key under
 * `components.schemas` in `openapi/openapi.yaml`). Compiled
 * lazily on first use per schema name, then memoized — call sites don't
 * need to manage validator lifecycle themselves.
 */
export function validateSchema(schemaName: string, value: unknown): boolean {
  return Boolean(validatorFor(schemaName)(value));
}
