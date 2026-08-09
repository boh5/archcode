import { MCP_CLIENT_NAME } from "@archcode/protocol";
import type { ResolvedMcpServerConfig } from "../config/mcp";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import type { SecretRedactionPolicy } from "../security";
import { McpConnectionError, McpToolExecutionError } from "./errors";

// The MCP SDK requires these external .js subpaths for its package exports map.
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Transport boundary, before the MCP SDK parses JSON or SSE. */
export const MAX_MCP_TRANSPORT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_LOG_BYTES = 4 * 1024;

export interface McpToolLike {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    [key: string]: unknown;
  };
}

export interface CallToolResultLike {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpSdkRequestOptions {
  signal?: AbortSignal;
  timeout: number;
  maxTotalTimeout: number;
}

export interface McpSdkClientLike {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  connect(transport: McpTransportLike, options?: McpSdkRequestOptions): Promise<void>;
  listTools(input?: { cursor?: string }, options?: McpSdkRequestOptions): Promise<{
    tools: unknown[];
    nextCursor?: string;
  }>;
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    resultSchema: undefined,
    options?: McpSdkRequestOptions,
  ): Promise<CallToolResultLike>;
  close?: () => Promise<void>;
}

export interface McpTransportLike {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  terminateSession?: () => Promise<void>;
  close?: () => Promise<void>;
  stderr?: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
  } | null;
}

export interface McpClientFactories {
  createClient(): McpSdkClientLike;
  createTransport(config: ResolvedMcpServerConfig): McpTransportLike;
}

export function createDefaultMcpClientFactories(): McpClientFactories {
  return {
    createClient(): McpSdkClientLike {
      return new Client({ name: MCP_CLIENT_NAME, version: "0.0.2" }) as unknown as McpSdkClientLike;
    },
    createTransport(config: ResolvedMcpServerConfig): McpTransportLike {
      if (config.type === "stdio") {
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          stderr: "pipe",
        }) as McpTransportLike;
      }

      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
        fetch: createMcpBoundedFetch(),
      }) as McpTransportLike;
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
    const limiter = contentType.includes("text/event-stream")
      ? new SsePayloadLimiter()
      : new TotalPayloadLimiter();
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
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
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
    if (this.#lineBytes === 0) this.#eventBytes = 0;
    this.#lineBytes = 0;
  }
}

/** Thin SDK client boundary. The SDK owns cancellation and per-request deadlines. */
export class McpClient {
  readonly #logger: Logger;
  readonly #sdkClient: McpSdkClientLike;
  readonly #transport: McpTransportLike;
  #closed = false;
  #closePromise?: Promise<void>;
  #unexpectedFailure?: (error: Error) => void;

  constructor(
    private readonly serverName: string,
    private readonly config: ResolvedMcpServerConfig,
    private readonly redactionPolicy: SecretRedactionPolicy,
    factories: McpClientFactories = createDefaultMcpClientFactories(),
    logger: Logger = silentLogger,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.#logger = logger.child({ module: "mcp.client" });
    this.#sdkClient = factories.createClient();
    this.#transport = factories.createTransport(config);
    this.#attachLifecycleHandlers();
    this.#attachBoundedStderr();
  }

  onUnexpectedFailure(listener: (error: Error) => void): void {
    this.#unexpectedFailure = listener;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    try {
      await this.#sdkClient.connect(
        this.#transport,
        requestOptions(this.config.connectTimeoutMs, signal),
      );
    } catch (error) {
      this.#logFailure("mcp.client.connect.failed", error);
      throw new McpConnectionError(this.serverName, this.#redactCause(error), classifySdkError(error));
    }
  }

  async listTools(signal?: AbortSignal): Promise<McpToolLike[]> {
    const tools: McpToolLike[] = [];
    const seenCursors = new Set<string>();
    const timeoutMs = this.config.discoveryTimeoutMs;
    let deadline: number | undefined;
    let cursor: string | undefined;

    try {
      // tools/list is paginated, but discoveryTimeoutMs bounds the complete
      // discovery operation. The SDK enforces each page's remaining budget.
      while (true) {
        throwIfAborted(signal);
        const requestStartedAt = this.now();
        const remainingMs = deadline === undefined
          ? timeoutMs
          : deadline - requestStartedAt;
        deadline ??= requestStartedAt + timeoutMs;
        if (remainingMs <= 0) throw discoveryTimeoutError(timeoutMs);

        const result = await this.#sdkClient.listTools(
          cursor === undefined ? undefined : { cursor },
          requestOptions(remainingMs, signal),
        );

        throwIfAborted(signal);
        if (this.now() >= deadline) throw discoveryTimeoutError(timeoutMs);

        tools.push(...result.tools.map((tool) => tool as McpToolLike));
        if (this.now() >= deadline) throw discoveryTimeoutError(timeoutMs);
        if (result.nextCursor === undefined) break;
        if (seenCursors.has(result.nextCursor)) throw repeatedCursorError();
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
    } catch (error) {
      this.#logFailure("mcp.client.list-tools.failed", error);
      throw new McpConnectionError(this.serverName, this.#redactCause(error), classifySdkError(error));
    }

    return tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<CallToolResultLike> {
    if (signal?.aborted) {
      throw new McpToolExecutionError(
        this.serverName,
        this.redactionPolicy.redactString(toolName),
        abortError(),
        "aborted",
      );
    }

    try {
      // This is the last synchronous boundary before the SDK receives the
      // request. Callers use it to distinguish a pre-dispatch cancellation
      // from an uncertain effectful result after transport hand-off.
      onDispatch?.();
      return await this.#sdkClient.callTool(
        { name: toolName, arguments: args },
        undefined,
        requestOptions(this.config.callTimeoutMs, signal),
      );
    } catch (error) {
      const safeToolName = this.redactionPolicy.redactString(toolName);
      this.#logger.warn("mcp.client.call-tool.failed", {
        context: { serverName: this.serverName, toolName: safeToolName },
        error: this.#redactedLogError(error),
      });
      throw new McpToolExecutionError(
        this.serverName,
        safeToolName,
        this.#redactCause(error),
        classifySdkError(error),
      );
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#closeOwnedResources();
    return this.#closePromise;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async #closeOwnedResources(): Promise<void> {
    if (this.#transport.terminateSession) {
      try {
        await this.#transport.terminateSession();
      } catch (error) {
        this.#logger.warn("mcp.client.terminate-session.failed", {
          context: { serverName: this.serverName },
          error: this.#redactedLogError(error),
        });
      }
    }

    if (this.#sdkClient.close) {
      await this.#sdkClient.close();
      return;
    }
    await this.#transport.close?.();
  }

  #attachLifecycleHandlers(): void {
    const reportClose = () => {
      this.#reportUnexpectedFailure(new Error("MCP connection closed unexpectedly"));
    };
    const reportError = (error: Error) => {
      this.#reportUnexpectedFailure(error);
    };
    this.#sdkClient.onclose = reportClose;
    this.#sdkClient.onerror = reportError;
    // The SDK takes ownership of the transport and chains callbacks installed
    // before connect. Listening at both public boundaries also covers a
    // transport failure that occurs while the SDK is still connecting.
    this.#transport.onclose = reportClose;
    this.#transport.onerror = reportError;
  }

  #reportUnexpectedFailure(error: Error): void {
    if (this.#closed) return;
    this.#unexpectedFailure?.(error);
  }

  #attachBoundedStderr(): void {
    this.#transport.stderr?.on("data", (chunk) => {
      const raw = typeof chunk === "string"
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk);
      const bounded = Buffer.from(raw).subarray(0, MAX_STDERR_LOG_BYTES).toString("utf8");
      this.#logger.warn("mcp.client.stdio.stderr", {
        context: { serverName: this.serverName, output: this.redactionPolicy.redactString(bounded) },
      });
    });
  }

  #logFailure(event: string, error: unknown): void {
    this.#logger.warn(event, {
      context: { serverName: this.serverName },
      error: this.#redactedLogError(error),
    });
  }

  #redactCause(cause: unknown): unknown {
    if (cause instanceof Error) {
      const redacted = new Error(this.redactionPolicy.redactString(cause.message));
      redacted.name = cause.name;
      if ("code" in cause) (redacted as Error & { code?: unknown }).code = cause.code;
      return redacted;
    }
    return typeof cause === "string"
      ? new Error(this.redactionPolicy.redactString(cause))
      : undefined;
  }

  #redactedLogError(error: unknown): { name: string; message: string } {
    if (error instanceof Error) {
      return {
        name: error.name || "Error",
        message: this.redactionPolicy.redactString(error.message),
      };
    }
    return {
      name: typeof error,
      message: this.redactionPolicy.redactString(String(error)),
    };
  }
}

function requestOptions(timeout: number, signal?: AbortSignal): McpSdkRequestOptions {
  return { timeout, maxTotalTimeout: timeout, ...(signal ? { signal } : {}) };
}

function classifySdkError(error: unknown): "aborted" | "timeout" | "failed" {
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  if (typeof error === "object" && error !== null && "code" in error && error.code === -32001) {
    return "timeout";
  }
  if (error instanceof Error && /timed? out|timeout/i.test(error.message)) return "timeout";
  return "failed";
}

function abortError(): Error {
  const error = new Error("The MCP operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function discoveryTimeoutError(timeoutMs: number): Error {
  return Object.assign(
    new Error(`MCP tools/list timed out after ${timeoutMs}ms`),
    { code: -32001 },
  );
}

function repeatedCursorError(): Error {
  return new Error("MCP tools/list returned a repeated pagination cursor");
}
