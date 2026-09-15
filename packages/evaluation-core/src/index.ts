export { bucket, BUCKET_MODULUS } from "./bucketing.js";
export {
  CLIENT_FORMAT_VERSION,
  evaluateFlag,
  evaluateFlagTyped,
  boolAttr,
  isBoundedRegex,
  listAttr,
  numberAttr,
  stringAttr,
} from "./evaluate.js";
export type { AttributeType, AttributeValue, Clause, ClauseOp } from "./evaluate.js";
export { applyTraceHeaders, resolveTraceHeaders } from "./trace-context.js";
export type { TraceHeaders } from "./trace-context.js";
export type { EvaluationResult, FlagConfig } from "@rollfuse/contracts";
