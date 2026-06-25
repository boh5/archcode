import { afterEach, describe, expect, mock, test } from "bun:test";
import type { McpServerStatus } from "@archcode/protocol";
import { ApiError } from "./client";
import { getMcpStatus } from "./mcp";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("getMcpStatus", () => {
  test("calls apiFetch with the global mcp status path", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/mcp/status");
      return jsonResponse({ servers: { context7: { state: "ready", toolCount: 3 } } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getMcpStatus();

    expect(result).toEqual({ context7: { state: "ready", toolCount: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("returns the servers object from the response", async () => {
    globalThis.document = { cookie: "" } as Document;
    const servers: Record<string, McpServerStatus> = {
      context7: { state: "ready", toolCount: 2 },
      grep: { state: "pending" },
      exa: { state: "failed", error: "down" },
      disabled: { state: "disabled" },
    };
    const fetchMock = mock(async () => jsonResponse({ servers }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getMcpStatus();

    expect(result).toEqual(servers);
  });

  test("returns empty object when servers map is empty", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async () => jsonResponse({ servers: {} }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getMcpStatus();

    expect(result).toEqual({});
  });

  test("throws ApiError on non-200 response", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async () =>
      jsonResponse(
        { error: { code: "INTERNAL", message: "boom" } },
        { status: 500 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getMcpStatus()).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      code: "INTERNAL",
    });
  });

  test("throws ApiError instance on non-200 response", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async () =>
      jsonResponse(
        { error: { code: "INTERNAL", message: "boom" } },
        { status: 500 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getMcpStatus()).rejects.toBeInstanceOf(ApiError);
  });
});