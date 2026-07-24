import { afterEach, describe, expect, mock, test } from "bun:test";
import { completeSetup, getSetupProviderAdapterCatalog } from "./bootstrap";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("setup API", () => {
  test("keeps the one-time setup grant in an Authorization header", async () => {
    const fetchMock = mock(async () => Response.json([]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getSetupProviderAdapterCatalog("one-time-grant");

    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/setup/provider-adapters");
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer one-time-grant");
  });

  test("does not serialize the setup grant into the setup request body", async () => {
    const fetchMock = mock(async () => Response.json({ status: { mode: "ready", authRequired: false, authenticated: false } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await completeSetup("one-time-grant", {
      config: { provider: {}, profiles: { principal: { model: "" }, deep: { model: "" }, fast: { model: "" } } },
      requireLogin: false,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer one-time-grant");
    expect(String(init.body)).not.toContain("one-time-grant");
  });
});
