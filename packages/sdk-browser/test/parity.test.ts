import type { Configuration } from "@rollfuse/contracts";
import { evaluateFlag } from "@rollfuse/evaluation-core";
import { describe, expect, it, vi } from "vitest";
import { RollfusePublicClient } from "../src/client.js";

/**
 * Proves `RollfusePublicClient.evaluate`/`evaluateAll` never diverge from
 * `@rollfuse/evaluation-core`'s `evaluateFlag` — the exact same function
 * `@rollfuse/sdk-js`'s `RollfuseClient` calls — per tasks.md 4.4 and
 * design.md decision 3's "duplicated evaluation semantics across three
 * runtimes" risk. Both SDKs are thin wrappers (fetch/cache/queue) around
 * the identical shared algorithm, so this is a parity guarantee by
 * construction: this test exists to catch a future regression where one
 * SDK's wrapper (e.g. an attribute-passing bug) silently diverges from
 * calling evaluation-core directly, not to re-verify evaluation-core's
 * own correctness (covered by its own golden-vector test suite).
 */
const config: Configuration = {
  environment_id: "env_1",
  version: 7,
  flags: [
    {
      flag_key: "checkout-redesign",
      enabled: true,
      default_variation: "off",
      variations: [
        { key: "on", value: true },
        { key: "off", value: false },
      ],
      rules: [
        { conditions: [{ attribute: "plan", value: "enterprise" }], outcome: { variation_key: "on" } },
        {
          outcome: {
            rollout: [
              { variation_key: "on", percentage: 50 },
              { variation_key: "off", percentage: 50 },
            ],
          },
        },
      ],
    },
    {
      flag_key: "always-off",
      enabled: false,
      default_variation: "off",
      variations: [{ key: "off", value: false }],
      rules: [],
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("evaluation parity with @rollfuse/evaluation-core", () => {
  it("evaluate() matches evaluateFlag() called directly, across rule-match, rollout and disabled-default cases", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(config));
    const client = new RollfusePublicClient({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

    await client.start();

    const subjects = ["user_1", "user_2", "user_3", "user_42", "user_1000"];

    for (const subjectKey of subjects) {
      for (const attributes of [{}, { plan: "enterprise" }] as Record<string, string>[]) {
        const flag = config.flags.find((f) => f.flag_key === "checkout-redesign")!;
        const direct = evaluateFlag(flag, config.version, subjectKey, attributes);
        const viaClient = client.evaluate(subjectKey, "checkout-redesign", { attributes });

        expect(viaClient).toEqual(direct);
      }

      const alwaysOffFlag = config.flags.find((f) => f.flag_key === "always-off")!;
      const direct = evaluateFlag(alwaysOffFlag, config.version, subjectKey);
      const viaClient = client.evaluate(subjectKey, "always-off");

      expect(viaClient).toEqual(direct);
    }

    client.stop();
  });

  it("evaluateAll() matches evaluateFlag() called directly for every flag", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(config));
    const client = new RollfusePublicClient({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

    await client.start();

    const subjectKey = "user_777";
    const expected = config.flags.map((flag) => evaluateFlag(flag, config.version, subjectKey));
    const actual = client.evaluateAll(subjectKey);

    expect(actual).toEqual(expected);

    client.stop();
  });
});
