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

const Ajv = createRequire(import.meta.url)("ajv") as AjvConstructor;

/**
 * One Ajv instance for the whole package, holding every schema from
 * `schemas.json` under a single root document so `$ref`s between schemas
 * (e.g. `FeatureFlag.variations` referencing `#/components/schemas/
 * Variation`) resolve exactly as they do in the source OpenAPI document —
 * see design.md Decision 2 in `strengthen-contracts-typing`.
 */
const ajv = new Ajv({ strict: false });
const ROOT_ID = "openapi-schemas";

ajv.addSchema({ components: { schemas } }, ROOT_ID);

const validators = new Map<string, ValidateFunction>();

function validatorFor(schemaName: string): ValidateFunction {
  const cached = validators.get(schemaName);
  if (cached) return cached;

  const validator = ajv.getSchema(`${ROOT_ID}#/components/schemas/${schemaName}`);

  if (!validator) {
    throw new Error(
      `validateSchema: no schema named "${schemaName}" in schemas.json — check the spelling against apps/api/openapi/openapi.yaml's components.schemas keys.`,
    );
  }

  validators.set(schemaName, validator);

  return validator;
}

/**
 * Validates value against the named OpenAPI schema (a key under
 * `components.schemas` in `apps/api/openapi/openapi.yaml`). Compiled
 * lazily on first use per schema name, then memoized — call sites don't
 * need to manage validator lifecycle themselves.
 */
export function validateSchema(schemaName: string, value: unknown): boolean {
  return Boolean(validatorFor(schemaName)(value));
}
