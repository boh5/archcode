import { MCP_CLIENT_NAME } from "@archcode/protocol";
import type { ResolvedMcpServerConfig } from "../config/mcp";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { McpConnectionError, McpToolExecutionError } from "./errors";
import type { SecretRedactionPolicy } from "../security";

// The MCP SDK requires this external .js subpath for its package exports map.
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Transport boundary, before the MCP SDK parses JSON or SSE. */
export const MAX_MCP_TRANSPORT_BYTES = 8 * 1024 * 1024;

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
      return new Client({ name: MCP_CLIENT_NAME, version: "0.0.2" }) as McpSdkClientLike;
    },
    createTransport(
      url: URL,
      options: { headers?: Record<string, string> },
    ): McpTransportLike {
      return new StreamableHTTPClientTransport(url, {
        requestInit: options.headers ? { headers: options.headers } : undefined,
        fetch: createMcpBoundedFetch(),
      });
    },
  };
}

/**
 * Enforce the wire budget before StreamableHTTPClientTransport reaches its JSON
 * or SSE parser. JSON is bounded as one response; each SSE event is bounded
 * independently so a long-lived stream remains usable.
 */
export function createMcpBoundedFetch(): (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.body === null) return response;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const isSse = contentType.includes("text/event-stream");
    const limiter = isSse ? new SsePayloadLimiter() : new TotalPayloadLimiter();
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value !== undefined) limiter.observe(value);
          controller.enqueue(value);
        } catch (error) {
          await reader.cancel(error).catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

class TotalPayloadLimiter {
  #bytes = 0;
  observe(chunk: Uint8Array): void {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > MAX_MCP_TRANSPORT_BYTES) {
      throw new Error("MCP JSON response exceeded the 8 MiB safety limit");
    }
  }
}

class SsePayloadLimiter {
  #lineBytes = 0;
  #eventBytes = 0;
  #pendingCr = false;

  observe(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (this.#pendingCr) {
        this.#pendingCr = false;
        if (byte === 0x0a) {
          this.#observeEventByte();
          this.#finishLine();
          continue;
        }
        this.#finishLine();
      }

      this.#observeEventByte();
      if (byte === 0x0d) {
        this.#pendingCr = true;
        continue;
      }
      if (byte === 0x0a) {
        this.#finishLine();
        continue;
      }

      this.#lineBytes++;
      if (this.#lineBytes > MAX_MCP_TRANSPORT_BYTES) {
        throw new Error("MCP SSE line exceeded the 8 MiB safety limit");
      }
    }
  }

  #observeEventByte(): void {
    this.#eventBytes++;
    if (this.#eventBytes > MAX_MCP_TRANSPORT_BYTES) {
      throw new Error("MCP SSE event exceeded the 8 MiB safety limit");
    }
  }

  #finishLine(): void {
    if (this.#lineBytes === 0) {
      this.#eventBytes = 0;
    }
    this.#lineBytes = 0;
  }
}

// ─── Client Wrapper ──────────────────────────────────────────────────────────

export class McpClient {
  readonly #logger: Logger;
  private readonly sdkClient: McpSdkClientLike;
  private readonly transport: McpTransportLike;

  constructor(
    private readonly serverName: string,
    private readonly config: ResolvedMcpServerConfig,
    private readonly redactionPolicy: SecretRedactionPolicy,
    factories: McpClientFactories = createDefaultMcpClientFactories(),
    logger: Logger = silentLogger,
  ) {
    this.#logger = logger.child({ module: "mcp.client" });
    this.sdkClient = factories.createClient();
    this.transport = factories.createTransport(new URL(config.url), {
      headers: config.headers,
    });
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
      const redacted = new Error(this.redactionPolicy.redactString(cause.message));
      redacted.name = cause.name;
      return redacted;
    }

    if (typeof cause === "string") {
      return new Error(this.redactionPolicy.redactString(cause));
    }

    return undefined;
  }
  private redactedLogError(error: unknown): { name: string; message: string } {
    if (error instanceof Error) {
      return { name: error.name || "Error", message: this.redactionPolicy.redactString(error.message) };
    }

    return { name: typeof error, message: this.redactionPolicy.redactString(String(error)) };
  }
}
