import type { Configuration } from "@rollfuse/contracts";
import {
  ErrorCode,
  OpenFeature,
  ProviderStatus,
} from "@openfeature/server-sdk";
import { RollfuseClient } from "@rollfuse/sdk-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RollfuseProvider } from "../src/index.js";

const booleanFlag = {
  flag_key: "checkout-redesign",
  enabled: true,
  default_variation: "off",
  variations: [
    { key: "on", value: true },
    { key: "off", value: false },
  ],
  rules: [{ conditions: [{ attribute: "plan", value: "enterprise" }], outcome: { variation_key: "on" } }],
};

const stringFlag = {
  flag_key: "welcome-message",
  enabled: true,
  default_variation: "classic",
  variations: [
    { key: "classic", value: "Welcome!" },
    { key: "friendly", value: "Hey there!" },
  ],
  rules: [],
};

const numberFlag = {
  flag_key: "max-items",
  enabled: true,
  default_variation: "small",
  variations: [
    { key: "small", value: 10 },
    { key: "large", value: 100 },
  ],
  rules: [],
};

const objectFlag = {
  flag_key: "checkout-config",
  enabled: true,
  default_variation: "default",
  variations: [{ key: "default", value: { maxRetries: 3, timeoutMs: 500 } }],
  rules: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function readyProvider(...flags: Configuration["flags"]) {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(jsonResponse({ environment_id: "env_test", version: 1, flags }));

  const client = new RollfuseClient({ baseUrl: "http://api.test", credential: "test-credential", fetchImpl });
  const provider = new RollfuseProvider(client);

  await OpenFeature.setProviderAndWait(provider);

  return { client, provider };
}

afterEach(async () => {
  await OpenFeature.close();
});

describe("RollfuseProvider", () => {
  it("reports READY once initialize resolves", async () => {
    await readyProvider(booleanFlag);

    expect(OpenFeature.providerMetadata.name).toBe("rollfuse");
    expect(OpenFeature.getClient().providerStatus).toBe(ProviderStatus.READY);
  });

  it("resolves a boolean flag on a rule match", async () => {
    await readyProvider(booleanFlag);
    const client = OpenFeature.getClient();

    const details = await client.getBooleanDetails("checkout-redesign", false, {
      targetingKey: "user_1",
      plan: "enterprise",
    });

    expect(details.value).toBe(true);
    expect(details.variant).toBe("on");
    expect(details.reason).toBe("TARGETING_MATCH");
  });

  it("resolves the flag's default_variation when no rule matches", async () => {
    await readyProvider(booleanFlag);
    const client = OpenFeature.getClient();

    const details = await client.getBooleanDetails("checkout-redesign", true, {
      targetingKey: "user_1",
      plan: "free",
    });

    expect(details.value).toBe(false);
    expect(details.reason).toBe("DEFAULT");
  });

  it("resolves a string flag", async () => {
    await readyProvider(stringFlag);
    const client = OpenFeature.getClient();

    const value = await client.getStringValue("welcome-message", "fallback", { targetingKey: "user_1" });

    expect(value).toBe("Welcome!");
  });

  it("resolves a number flag", async () => {
    await readyProvider(numberFlag);
    const client = OpenFeature.getClient();

    const value = await client.getNumberValue("max-items", -1, { targetingKey: "user_1" });

    expect(value).toBe(10);
  });

  it("resolves an object flag", async () => {
    await readyProvider(objectFlag);
    const client = OpenFeature.getClient();

    const value = await client.getObjectValue("checkout-config", null, { targetingKey: "user_1" });

    expect(value).toEqual({ maxRetries: 3, timeoutMs: 500 });
  });

  it("reports TARGETING_KEY_MISSING when the context has no targetingKey", async () => {
    await readyProvider(booleanFlag);
    const client = OpenFeature.getClient();

    const details = await client.getBooleanDetails("checkout-redesign", false, {});

    expect(details.value).toBe(false);
    expect(details.errorCode).toBe(ErrorCode.TARGETING_KEY_MISSING);
    expect(details.reason).toBe("ERROR");
  });

  it("reports FLAG_NOT_FOUND for an unknown flag key (no fallback masking it)", async () => {
    await readyProvider(booleanFlag);
    const client = OpenFeature.getClient();

    const details = await client.getBooleanDetails("does-not-exist", true, { targetingKey: "user_1" });

    expect(details.value).toBe(true);
    expect(details.errorCode).toBe(ErrorCode.FLAG_NOT_FOUND);
  });

  it("reports TYPE_MISMATCH when the variation's value doesn't match the requested type", async () => {
    await readyProvider(stringFlag);
    const client = OpenFeature.getClient();

    // "welcome-message" resolves to a string variation; asking for a
    // boolean must fail to decode, not silently succeed with a zero value.
    const details = await client.getBooleanDetails("welcome-message", true, { targetingKey: "user_1" });

    expect(details.value).toBe(true);
    expect(details.errorCode).toBe(ErrorCode.TYPE_MISMATCH);
  });

  it("excludes non-string context attributes rather than stringifying them", async () => {
    await readyProvider(booleanFlag);
    const client = OpenFeature.getClient();

    // "plan" here is a boolean, not the string "enterprise" the rule
    // requires — must not match via implicit coercion.
    const details = await client.getBooleanDetails("checkout-redesign", false, {
      targetingKey: "user_1",
      plan: true,
    });

    expect(details.reason).toBe("DEFAULT");
  });
});
