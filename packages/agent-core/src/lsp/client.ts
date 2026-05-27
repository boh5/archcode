import type { Disposable } from "vscode-jsonrpc";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import type { LspTransport } from "./transport";

export interface LspClientOptions {
  transport: LspTransport;
  workspaceRoot: string;
  timeouts?: Partial<LspClientTimeouts>;
  logger?: Logger;
}

export interface LspClientTimeouts {
  initializeMs: number;
  requestMs: number;
  shutdownMs: number;
  contentModifiedRetries: number;
  contentModifiedBaseDelayMs: number;
}

export const DEFAULT_LSP_CLIENT_TIMEOUTS: LspClientTimeouts = {
  initializeMs: 30_000,
  requestMs: 15_000,
  shutdownMs: 5_000,
  contentModifiedRetries: 3,
  contentModifiedBaseDelayMs: 500,
};

export const CONTENT_MODIFIED_CODE = -32801;

export class LspError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly kind: "lsp-error" | "lsp-timeout";

  constructor(params: { message: string; code: number; data?: unknown; kind?: "lsp-error" | "lsp-timeout" }) {
    super(params.message);
    this.name = "LspError";
    this.code = params.code;
    this.data = params.data;
    this.kind = params.kind ?? "lsp-error";
  }
}

export type LspClientFactory = (options: LspClientOptions) => LspClient;

let lspClientFactoryForTest: LspClientFactory | undefined;

export function setLspClientForTest(factory: LspClientFactory | undefined): void {
  lspClientFactoryForTest = factory;
}

export function createLspClient(options: LspClientOptions): LspClient {
  return lspClientFactoryForTest ? lspClientFactoryForTest(options) : new LspClient(options);
}

export class LspClient {
  private readonly transport: LspTransport;
  private readonly workspaceRoot: string;
  private readonly timeouts: LspClientTimeouts;
  #logger: Logger;
  private serverCapabilities: Record<string, unknown> | undefined;

  constructor(options: LspClientOptions) {
    this.transport = options.transport;
    this.workspaceRoot = options.workspaceRoot;
    this.timeouts = { ...DEFAULT_LSP_CLIENT_TIMEOUTS, ...options.timeouts };
    this.#logger = (options.logger ?? silentLogger).child({ module: "lsp.client" });
  }

  get capabilities(): Record<string, unknown> | undefined {
    return this.serverCapabilities;
  }

  async initialize(
    workspaceRoot = this.workspaceRoot,
    options?: { capabilities?: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    const result = await withTimeout(
      this.transport.connect({
        processId: null,
        rootUri: pathToFileUri(workspaceRoot),
        capabilities: options?.capabilities ?? {},
      }),
      this.timeouts.initializeMs,
      "initialize",
    );

    const capabilities = extractCapabilities(result);
    this.serverCapabilities = capabilities;
    this.transport.sendNotification("initialized", {});
    return capabilities;
  }

  async shutdown(): Promise<void> {
    try {
      await withTimeout(this.transport.sendRequest("shutdown", null), this.timeouts.shutdownMs, "shutdown");
      this.transport.sendNotification("exit");
    } finally {
      await this.transport.dispose();
    }
  }

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    const maxRetries = this.timeouts.contentModifiedRetries;

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await withTimeout(this.transport.sendRequest(method, params), this.timeouts.requestMs, method);
      } catch (error) {
        const lspError = toLspError(error, method);
        if (lspError.code !== CONTENT_MODIFIED_CODE || attempt >= maxRetries) {
          this.#logger.warn("lsp.client.request.failed", {
            context: { method, retries: attempt },
            error: lspError,
          });
          throw lspError;
        }
        this.#logger.debug("lsp.client.retry.content-modified", { context: { method, attempt } });
        await delay(this.timeouts.contentModifiedBaseDelayMs * 2 ** attempt);
      }
    }
  }

  sendNotification(method: string, params?: unknown): void {
    this.transport.sendNotification(method, params);
  }

  onNotification(method: string, handler: (params: unknown) => void): Disposable {
    return this.transport.onNotification(method, handler);
  }
}

function extractCapabilities(result: unknown): Record<string, unknown> {
  if (isRecord(result) && isRecord(result.capabilities)) {
    return result.capabilities;
  }
  return {};
}

function toLspError(error: unknown, method: string): LspError {
  if (error instanceof LspError) return error;

  const raw = extractJsonRpcError(error);
  if (raw) {
    return new LspError({
      code: raw.code,
      data: raw.data,
      message: messageForCode(raw.code, raw.message, method),
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) {
    return new LspError({
      code: 0,
      kind: "lsp-timeout",
      message: `LSP request "${method}" timed out. Check whether the language server is responsive and retry. ${message}`,
    });
  }

  return new LspError({
    code: -32603,
    message: `LSP request "${method}" failed: ${message}`,
  });
}

function extractJsonRpcError(error: unknown): { code: number; message: string; data?: unknown } | undefined {
  if (!isRecord(error)) return undefined;

  const directCode = error.code;
  if (typeof directCode === "number") {
    return { code: directCode, message: stringValue(error.message), data: error.data };
  }

  const nested = error.error;
  if (isRecord(nested) && typeof nested.code === "number") {
    return { code: nested.code, message: stringValue(nested.message), data: nested.data };
  }

  return undefined;
}

function messageForCode(code: number, message: string, method: string): string {
  switch (code) {
    case CONTENT_MODIFIED_CODE:
      return `LSP request "${method}" failed because the document content changed during analysis: ${message}`;
    case -32603:
      return `LSP request "${method}" failed with an internal server error: ${message}`;
    case -32601:
      return `LSP method "${method}" is not supported by the server: ${message}`;
    default:
      return `LSP request "${method}" failed with code ${code}: ${message}`;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: Timer | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new LspError({
        code: 0,
        kind: "lsp-timeout",
        message: `LSP ${label} timed out after ${timeoutMs}ms. Check whether the language server is responsive and retry.`,
      }));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathToFileUri(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${prefixed.split("/").map(encodeURIComponent).join("/")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "Unknown LSP error");
}
