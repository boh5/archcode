import { afterEach, describe, expect, mock, test } from "bun:test";
import { apiFetch, subscribeAuthInvalidation } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("apiFetch authentication boundary", () => {
  test("uses same-origin browser credentials and invalidates the workbench on a normal 401", async () => {
    const invalidated = mock(() => {});
    const unsubscribe = subscribeAuthInvalidation(invalidated);
    const fetchMock = mock(async () => new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Sign in required" } }), { status: 401 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiFetch("/api/projects")).rejects.toMatchObject({ status: 401 });
    unsubscribe();

    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(init).toMatchObject({ credentials: "same-origin" });
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  test("leaves login failures to the login screen", async () => {
    const invalidated = mock(() => {});
    const unsubscribe = subscribeAuthInvalidation(invalidated);
    globalThis.fetch = mock(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;

    await expect(apiFetch("/api/auth/login", { authFailure: "ignore" })).rejects.toMatchObject({ status: 401 });
    unsubscribe();

    expect(invalidated).not.toHaveBeenCalled();
  });
});
