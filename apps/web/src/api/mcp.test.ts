import { afterEach, describe, expect, mock, test } from "bun:test";
import type { McpServerStatus } from "@archcode/protocol";
import { ApiError } from "./client";
import { getMcpInventory, getMcpStatus, reconnectMcpServer, testMcpDraft } from "./mcp";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
});

describe("MCP control actions", () => {
  test("tests a named server with the complete unsaved Config request", async () => {
    globalThis.document = { cookie: "" } as Document;
    const request = { expectedRevision: "r1", config: { provider: {}, profiles: {} } } as never;
    const controller = new AbortController();
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/mcp/test/local%20draft");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(request);
      expect(init?.signal).toBe(controller.signal);
      return jsonResponse({ tools: [], warnings: [] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(testMcpDraft("local draft", request, { signal: controller.signal })).resolves.toEqual({ tools: [], warnings: [] });
  });

  test("loads inventory and reconnects only by saved server identity", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/mcp/inventory") return jsonResponse({ servers: { local: [] } });
      expect(String(input)).toBe("/api/mcp/reconnect/local");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      return jsonResponse({ servers: { local: { state: "connecting", startedAt: 1 } } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getMcpInventory()).resolves.toEqual({ local: [] });
    await expect(reconnectMcpServer("local")).resolves.toEqual({ local: { state: "connecting", startedAt: 1 } });
  });
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
      return jsonResponse({ servers: { context7: { state: "ready", toolCount: 3, warningCount: 0, connectedAt: 1 } } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getMcpStatus();

    expect(result).toEqual({ context7: { state: "ready", toolCount: 3, warningCount: 0, connectedAt: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("returns the servers object from the response", async () => {
    globalThis.document = { cookie: "" } as Document;
    const servers: Record<string, McpServerStatus> = {
      context7: { state: "ready", toolCount: 2, warningCount: 1, connectedAt: 1 },
      grep: { state: "connecting", startedAt: 1 },
      exa: { state: "failed", error: "down", failedAt: 1 },
      disabled: { state: "disabled", updatedAt: 1 },
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
