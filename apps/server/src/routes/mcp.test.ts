import { Hono } from "hono";
import { describe, expect, mock, test } from "bun:test";
import type {
  McpServerInventoryResponse,
  McpServerStatusResponse,
  UpdateServerConfigRequest,
} from "@archcode/protocol";
import {
  ConfigRevisionConflictError,
  ConfigSemanticValidationError,
} from "@archcode/agent-core";

import { errorHandler } from "../error-handler";
import { createMcpRoutes, type McpRuntimePort, type McpTestResponse } from "./mcp";

const status: McpServerStatusResponse = {
  servers: {
    context7: { state: "ready", toolCount: 3, warningCount: 0, connectedAt: 100 },
    docs: { state: "connecting", startedAt: 200 },
    broken: { state: "failed", error: "connection refused", failedAt: 300 },
    disabled: { state: "disabled", updatedAt: 400 },
  },
};

const inventory: McpServerInventoryResponse = {
  servers: {
    context7: [{
      serverName: "context7",
      name: "search",
      registryName: "mcp__context7__search",
      description: "Search docs",
    }],
    docs: [],
  },
};

function createRuntime(overrides: Partial<McpRuntimePort> = {}): McpRuntimePort {
  return {
    getMcpServerStatus: mock(() => status),
    getMcpServerInventory: mock(() => inventory),
    testMcpServerDraft: mock(async () => ({
      tools: inventory.servers.context7 ?? [],
      warnings: [],
    } satisfies McpTestResponse)),
    reconnectMcpServer: mock(async () => undefined),
    ...overrides,
  };
}

function createApp(runtime: McpRuntimePort): Hono {
  const app = new Hono();
  app.route("/api/mcp", createMcpRoutes(runtime));
  app.onError(errorHandler);
  return app;
}

function draft(): UpdateServerConfigRequest {
  return {
    expectedRevision: "revision-1",
    config: {
      provider: {},
      profiles: {
        principal: { model: "local:model" },
        deep: { model: "local:model" },
        fast: { model: "local:model" },
      },
      mcp: {
        servers: {
          docs: {
            type: "http",
            enabled: true,
            url: "https://mcp.example.test",
          },
        },
      },
    },
  } as UpdateServerConfigRequest;
}

describe("MCP control-plane routes", () => {
  test("GET /api/mcp/status returns the runtime status DTO unchanged", async () => {
    const runtime = createRuntime();
    const response = await createApp(runtime).request("/api/mcp/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
    expect(runtime.getMcpServerStatus).toHaveBeenCalledTimes(1);
  });

  test("GET /api/mcp/inventory returns the runtime inventory DTO unchanged", async () => {
    const runtime = createRuntime();
    const response = await createApp(runtime).request("/api/mcp/inventory");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(inventory);
    expect(runtime.getMcpServerInventory).toHaveBeenCalledTimes(1);
  });

  test("POST /api/mcp/test/:serverName forwards the complete draft without writing", async () => {
    const request = draft();
    const runtime = createRuntime();
    const response = await createApp(runtime).request("/api/mcp/test/docs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tools: inventory.servers.context7,
      warnings: [],
    });
    expect(runtime.testMcpServerDraft).toHaveBeenCalledWith("docs", request, {
      signal: expect.any(AbortSignal),
    });
  });

  test("POST /api/mcp/test/:serverName forwards the exact HTTP request signal", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const runtime = createRuntime({
      testMcpServerDraft: mock(async (
        _serverName: string,
        _request: UpdateServerConfigRequest,
        options?: { signal?: AbortSignal },
      ) => {
        receivedSignal = options?.signal;
        return { tools: [], warnings: [] };
      }),
    });
    const httpRequest = new Request("http://localhost/api/mcp/test/docs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft()),
      signal: controller.signal,
    });

    const response = await createApp(runtime).request(httpRequest);

    expect(response.status).toBe(200);
    expect(receivedSignal).toBe(controller.signal);
  });

  test("POST /api/mcp/reconnect/:serverName reconnects then returns the status snapshot", async () => {
    const runtime = createRuntime();
    const response = await createApp(runtime).request("/api/mcp/reconnect/docs", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
    expect(runtime.reconnectMcpServer).toHaveBeenCalledWith("docs");
    expect(runtime.getMcpServerStatus).toHaveBeenCalledTimes(1);
  });

  test("rejects malformed draft bodies and invalid server names with 400", async () => {
    const runtime = createRuntime();
    const app = createApp(runtime);
    const malformedBodies: unknown[] = [
      null,
      [],
      {},
      { expectedRevision: "revision-1" },
      { config: {}, expectedRevision: 1 },
      { config: {}, expectedRevision: "revision-1", extra: true },
    ];

    for (const body of malformedBodies) {
      const response = await app.request("/api/mcp/test/docs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }

    for (const serverName of ["bad/name", "bad__name", "bad name", "bad?name"]) {
      const response = await app.request(`/api/mcp/test/${encodeURIComponent(serverName)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft()),
      });
      expect(response.status).toBe(400);
    }
    expect(runtime.testMcpServerDraft).not.toHaveBeenCalled();
  });

  test("leaves runtime errors to the existing HTTP error handler", async () => {
    const runtime = createRuntime({
      reconnectMcpServer: mock(async () => {
        throw new Error("connection details must stay server-side");
      }),
    });
    const response = await createApp(runtime).request("/api/mcp/reconnect/docs", { method: "POST" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });

  test("maps stale and invalid drafts to actionable Config errors", async () => {
    for (const [error, expectedStatus, expectedCode] of [
      [new ConfigRevisionConflictError("old", "current"), 409, "CONFIG_REVISION_CONFLICT"],
      [new ConfigSemanticValidationError([{ path: "mcp.servers.docs.url", message: "Invalid URL" }]), 422, "CONFIG_VALIDATION_ERROR"],
    ] as const) {
      const runtime = createRuntime({
        testMcpServerDraft: mock(async () => { throw error; }),
      });
      const response = await createApp(runtime).request("/api/mcp/test/docs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft()),
      });

      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toMatchObject({ error: { code: expectedCode } });
    }
  });
});
