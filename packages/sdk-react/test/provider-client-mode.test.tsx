import type { Configuration } from "@rollfuse/contracts";
import { RollfusePublicClient } from "@rollfuse/sdk-browser";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RollfuseProvider } from "../src/context.js";
import { useFlag, useFlags } from "../src/hooks.js";

const baseConfig: Configuration = {
  environment_id: "env_1",
  version: 1,
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
      ],
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function ReadFlag({ flagKey }: { flagKey: string }) {
  const result = useFlag(flagKey, { fallback: false });

  return <div data-testid="value">{JSON.stringify(result.value)}</div>;
}

function ReadAllFlags() {
  const results = useFlags();

  return <div data-testid="count">{Object.keys(results).length}</div>;
}

describe("RollfuseProvider — client-driven mode", () => {
  it("useFlag/useFlags reflect the client's live evaluation once Configuration loads", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(baseConfig));
    const client = new RollfusePublicClient({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

    await act(async () => {
      await client.start();
    });

    render(
      <RollfuseProvider client={client} subjectKey="user_1" attributes={{ plan: "enterprise" }}>
        <ReadFlag flagKey="checkout-redesign" />
        <ReadAllFlags />
      </RollfuseProvider>,
    );

    expect(screen.getByTestId("value").textContent).toBe("true");
    expect(screen.getByTestId("count").textContent).toBe("1");

    client.stop();
  });

  it("useFlag reflects an update after the client's Configuration refreshes", async () => {
    vi.useFakeTimers();

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(baseConfig))
      .mockResolvedValueOnce(
        jsonResponse({
          ...baseConfig,
          version: 2,
          flags: [{ ...baseConfig.flags[0], rules: [] }], // enterprise rule removed: now always "off"
        }),
      );

    const client = new RollfusePublicClient({
      baseUrl: "http://api.test",
      publicCredential: "pub_cred",
      refreshIntervalMs: 1_000,
      fetchImpl,
    });

    await act(async () => {
      await client.start();
    });

    render(
      <RollfuseProvider client={client} subjectKey="user_1" attributes={{ plan: "enterprise" }}>
        <ReadFlag flagKey="checkout-redesign" />
      </RollfuseProvider>,
    );

    expect(screen.getByTestId("value").textContent).toBe("true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByTestId("value").textContent).toBe("false");

    client.stop();
    vi.useRealTimers();
  });

  it("renders with a fallback (never throws) before the client's first Configuration fetch resolves", () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(baseConfig));
    const client = new RollfusePublicClient({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

    // start() intentionally not called/awaited: no Configuration cached yet.
    render(
      <RollfuseProvider client={client} subjectKey="user_1">
        <ReadFlag flagKey="checkout-redesign" />
      </RollfuseProvider>,
    );

    expect(screen.getByTestId("value").textContent).toBe("false");

    client.stop();
  });

  it("unsubscribes from the client when unmounted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(baseConfig));
    const client = new RollfusePublicClient({ baseUrl: "http://api.test", publicCredential: "pub_cred", fetchImpl });

    await act(async () => {
      await client.start();
    });

    const { unmount } = render(
      <RollfuseProvider client={client} subjectKey="user_1">
        <ReadFlag flagKey="checkout-redesign" />
      </RollfuseProvider>,
    );

    // Access a private field only to assert the subscription was actually
    // registered and later removed — not part of this package's public
    // API, but the cleanest way to prove unmount doesn't leak a listener.
    const listenerCount = () => (client as unknown as { configChangeListeners: Set<unknown> }).configChangeListeners
      .size;

    expect(listenerCount()).toBe(1);

    unmount();

    await waitFor(() => expect(listenerCount()).toBe(0));

    client.stop();
  });
});
