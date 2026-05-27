import type { ResolvedMcpServerConfig } from "../config/mcp";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { McpConnectionError, McpToolExecutionError, redactMcpMessage } from "./errors";

// The MCP SDK requires this external .js subpath for its package exports map.
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ─── SDK Factory Seam ────────────────────────────────────────────────────────

export interface McpToolLike {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    [key: string]: unknown;
  };
}

export interface CallToolResultLike {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpSdkClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(input?: { cursor?: string }): Promise<{
    tools: unknown[];
    nextCursor?: string;
  }>;
  callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<CallToolResultLike>;
  close?: () => Promise<void>;
}

export interface McpTransportLike {
  close?: () => Promise<void>;
}

export interface McpClientFactories {
  createClient(): McpSdkClientLike;
  createTransport(
    url: URL,
    options: { headers?: Record<string, string> },
  ): McpTransportLike;
}

// ─── Production Factories ────────────────────────────────────────────────────

export function createDefaultMcpClientFactories(): McpClientFactories {
  return {
    createClient(): McpSdkClientLike {
      return new Client({ name: "specra", version: "0.1.0" }) as McpSdkClientLike;
    },
    createTransport(
      url: URL,
      options: { headers?: Record<string, string> },
    ): McpTransportLike {
      return new StreamableHTTPClientTransport(url, {
        requestInit: options.headers ? { headers: options.headers } : undefined,
      });
    },
  };
}

// ─── Client Wrapper ──────────────────────────────────────────────────────────

export class McpClient {
  readonly #logger: Logger;
  private readonly sdkClient: McpSdkClientLike;
  private readonly transport: McpTransportLike;
  private readonly secrets: string[];

  constructor(
    private readonly serverName: string,
    private readonly config: ResolvedMcpServerConfig,
    factories: McpClientFactories = createDefaultMcpClientFactories(),
    logger: Logger = silentLogger,
  ) {
    this.#logger = logger.child({ module: "mcp.client" });
    this.sdkClient = factories.createClient();
    this.transport = factories.createTransport(new URL(config.url), {
      headers: config.headers,
    });
    this.secrets = config.headers ? Object.values(config.headers) : [];
  }

  async connect(): Promise<void> {
    try {
      await this.withTimeout(
        this.sdkClient.connect(this.transport),
        "connect",
      );
    } catch (err) {
      this.#logger.warn("mcp.client.connect.failed", {
        context: { serverName: this.serverName },
        error: this.redactedLogError(err),
      });
      throw new McpConnectionError(this.serverName, this.redactCause(err));
    }
  }

  async listTools(): Promise<McpToolLike[]> {
    const tools: McpToolLike[] = [];
    let cursor: string | undefined;

    try {
      do {
        const result = await this.withTimeout(
          this.sdkClient.listTools(cursor ? { cursor } : undefined),
          "tools/list",
        );
        tools.push(...result.tools.map((tool) => tool as McpToolLike));
        cursor = result.nextCursor;
      } while (cursor);
    } catch (err) {
      this.#logger.warn("mcp.client.list-tools.failed", {
        context: { serverName: this.serverName },
        error: this.redactedLogError(err),
      });
      throw new McpConnectionError(this.serverName, this.redactCause(err));
    }

    return tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResultLike> {
    try {
      return await this.withTimeout(
        this.sdkClient.callTool({ name: toolName, arguments: args }),
        `tools/call:${toolName}`,
      );
    } catch (err) {
      this.#logger.warn("mcp.client.call-tool.failed", {
        context: { serverName: this.serverName, toolName },
        error: this.redactedLogError(err),
      });
      throw new McpToolExecutionError(
        this.serverName,
        toolName,
        this.redactCause(err),
      );
    }
  }

  async close(): Promise<void> {
    await this.sdkClient.close?.();
    await this.transport.close?.();
  }

  private withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
    let timeoutHandle: Timer | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `MCP ${operation} timed out after ${this.config.timeout}ms`,
          ),
        );
      }, this.config.timeout);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    });
  }

  private redactCause(cause: unknown): unknown {
    if (cause instanceof Error) {
      const redacted = new Error(redactMcpMessage(cause.message, this.secrets));
      redacted.name = cause.name;
      return redacted;
    }

    if (typeof cause === "string") {
      return new Error(redactMcpMessage(cause, this.secrets));
    }

    return undefined;
  }
  private redactedLogError(error: unknown): { name: string; message: string } {
    if (error instanceof Error) {
      return { name: error.name || "Error", message: redactMcpMessage(error.message, this.secrets) };
    }

    return { name: typeof error, message: redactMcpMessage(String(error), this.secrets) };
  }
}

function logError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: error.message };
  }

  return { name: typeof error, message: String(error) };
}
