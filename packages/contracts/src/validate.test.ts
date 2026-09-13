import { describe, expect, it } from "vitest";

import { validateSchema } from "./validate.js";

describe("validateSchema", () => {
  it("accepts a valid FeatureFlag-shaped object", () => {
    const value = {
      id: "flag_1",
      project_id: "proj_1",
      name: "My Flag",
      description: "A flag used in tests.",
      key: "my-flag",
      variations: [{ id: "var_1", key: "on", value: true }],
      tags: ["billing"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      archived_at: null,
    };

    expect(validateSchema("FeatureFlag", value)).toBe(true);
  });

  it("rejects an object missing a required field", () => {
    const value = {
      id: "flag_1",
      project_id: "proj_1",
      name: "My Flag",
      description: "A flag used in tests.",
      // key is required and missing
      variations: [],
      tags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      archived_at: null,
    };

    expect(validateSchema("FeatureFlag", value)).toBe(false);
  });

  it("throws a clear error for an unknown schema name", () => {
    expect(() => validateSchema("NotARealSchema", {})).toThrow(/no schema named/);
  });
});
