import { Hono } from "hono";
import type {
  McpServerInventoryResponse,
  McpServerStatusResponse,
  McpToolInventoryItem,
  UpdateServerConfigRequest,
} from "@archcode/protocol";
import {
  ConfigRevisionConflictError,
  ConfigSemanticValidationError,
} from "@archcode/agent-core";

import {
  BadRequestError,
  ConfigRevisionConflictHttpError,
  ConfigValidationHttpError,
} from "../errors";
import { readBoundedJsonBody } from "../request-body";

const MCP_DRAFT_BODY_MAX_BYTES = 2 * 1024 * 1024;
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * The server route only owns HTTP validation and dispatch. Config resolution,
 * secret policy, draft testing, and live MCP lifecycle stay behind this port.
 */
export interface McpRuntimePort {
  getMcpServerStatus(): McpServerStatusResponse;
  getMcpServerInventory(): McpServerInventoryResponse;
  testMcpServerDraft(
    serverName: string,
    request: UpdateServerConfigRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpTestResponse>;
  reconnectMcpServer(serverName: string): Promise<void>;
}

export interface McpTestResponse {
  readonly tools: McpToolInventoryItem[];
  readonly warnings: string[];
}

/** MCP routes are global (not project-scoped). */
export function createMcpRoutes(runtime: McpRuntimePort): Hono {
  const app = new Hono();

  app.get("/status", (c) => c.json(runtime.getMcpServerStatus()));
  app.get("/inventory", (c) => c.json(runtime.getMcpServerInventory()));

  app.post("/test/:serverName", async (c) => {
    const serverName = parseServerName(c.req.param("serverName"));
    const request = parseDraftRequest(await readBoundedJsonBody(c.req.raw, {
      maxBytes: MCP_DRAFT_BODY_MAX_BYTES,
      label: "MCP test draft",
    }));
    try {
      return c.json(await runtime.testMcpServerDraft(serverName, request, {
        signal: c.req.raw.signal,
      }));
    } catch (error) {
      if (error instanceof ConfigRevisionConflictError) {
        throw new ConfigRevisionConflictHttpError(error.expectedRevision, error.currentRevision);
      }
      if (error instanceof ConfigSemanticValidationError) {
        throw new ConfigValidationHttpError(error.issues);
      }
      throw error;
    }
  });

  app.post("/reconnect/:serverName", async (c) => {
    const serverName = parseServerName(c.req.param("serverName"));
    await runtime.reconnectMcpServer(serverName);
    return c.json(runtime.getMcpServerStatus());
  });

  return app;
}

function parseServerName(value: string | undefined): string {
  if (
    value === undefined
    || value.length === 0
    || !MCP_SERVER_NAME_PATTERN.test(value)
    || value.includes("__")
  ) {
    throw new BadRequestError("Invalid MCP server name");
  }
  return value;
}

function parseDraftRequest(value: unknown): UpdateServerConfigRequest {
  if (!isRecord(value)) {
    throw new BadRequestError("MCP test draft must be an object");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2
    || keys[0] !== "config"
    || keys[1] !== "expectedRevision"
  ) {
    throw new BadRequestError("MCP test draft must contain only expectedRevision and config");
  }
  if (
    typeof value.expectedRevision !== "string"
    || value.expectedRevision.length === 0
    || !isRecord(value.config)
  ) {
    throw new BadRequestError("MCP test draft must include expectedRevision and config");
  }
  return value as unknown as UpdateServerConfigRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
