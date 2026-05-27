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

export interface LspInitializeOptions {
  capabilities?: Record<string, unknown>;
  initializationOptions?: Record<string, unknown>;
}

export interface OpenTextDocumentOptions {
  uri: string;
  languageId: string;
  text: string;
}

export interface TextDocumentHandle {
  uri: string;
  version: number;
  release: () => void;
}

export interface DiagnosticsSnapshot {
  uri: string;
  diagnostics: unknown[];
  version?: number;
  sequence: number;
  updatedAt: number;
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
  private diagnosticsListener: Disposable | undefined;
  private diagnosticsSequence = 0;
  private readonly diagnosticsByUri = new Map<string, DiagnosticsSnapshot>();
  private readonly diagnosticsWaiters = new Map<string, Set<DiagnosticsWaiter>>();
  private readonly openDocuments = new Map<string, OpenDocumentState>();

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
    options?: LspInitializeOptions,
  ): Promise<Record<string, unknown>> {
    const result = await withTimeout(
      this.transport.connect({
        processId: null,
        rootUri: pathToFileUri(workspaceRoot),
        capabilities: mergeCapabilities(defaultClientCapabilities(), options?.capabilities),
        ...(options?.initializationOptions ? { initializationOptions: options.initializationOptions } : {}),
      }),
      this.timeouts.initializeMs,
      "initialize",
    );

    const capabilities = extractCapabilities(result);
    this.serverCapabilities = capabilities;
    this.ensureDiagnosticsListener();
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

  hasCapability(path: string): boolean {
    return getNestedValue(this.serverCapabilities ?? {}, path) !== undefined;
  }

  openTextDocument(options: OpenTextDocumentOptions): TextDocumentHandle {
    const existing = this.openDocuments.get(options.uri);
    if (existing) {
      existing.refCount += 1;
      if (existing.text !== options.text || existing.languageId !== options.languageId) {
        existing.version += 1;
        existing.text = options.text;
        existing.languageId = options.languageId;
        this.transport.sendNotification("textDocument/didChange", {
          textDocument: { uri: options.uri, version: existing.version },
          contentChanges: [{ text: options.text }],
        });
      }

      return this.createDocumentHandle(options.uri, existing.version);
    }

    const state: OpenDocumentState = {
      languageId: options.languageId,
      text: options.text,
      version: 1,
      refCount: 1,
    };
    this.openDocuments.set(options.uri, state);
    this.transport.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: options.uri,
        languageId: options.languageId,
        version: state.version,
        text: options.text,
      },
    });

    return this.createDocumentHandle(options.uri, state.version);
  }

  getDiagnosticsSnapshot(uri: string): DiagnosticsSnapshot | undefined {
    return this.diagnosticsByUri.get(uri);
  }

  waitForDiagnostics(uri: string, options: { afterSequence?: number; timeoutMs: number }): Promise<DiagnosticsSnapshot> {
    const baseline = options.afterSequence ?? -1;
    const snapshot = this.diagnosticsByUri.get(uri);
    if (snapshot && snapshot.sequence > baseline) {
      return Promise.resolve(snapshot);
    }

    let timeout: Timer | undefined;
    return new Promise((resolve, reject) => {
      const waiter: DiagnosticsWaiter = {
        baseline,
        resolve: (next) => {
          if (timeout) clearTimeout(timeout);
          this.removeDiagnosticsWaiter(uri, waiter);
          resolve(next);
        },
        reject: (error) => {
          if (timeout) clearTimeout(timeout);
          this.removeDiagnosticsWaiter(uri, waiter);
          reject(error);
        },
      };

      const waiters = this.diagnosticsWaiters.get(uri) ?? new Set<DiagnosticsWaiter>();
      waiters.add(waiter);
      this.diagnosticsWaiters.set(uri, waiters);

      timeout = setTimeout(() => {
        waiter.reject(new LspError({
          code: 0,
          kind: "lsp-timeout",
          message: `LSP diagnostics timed out after ${options.timeoutMs}ms. Check whether the language server is responsive and retry.`,
        }));
      }, options.timeoutMs);
    });
  }

  private createDocumentHandle(uri: string, version: number): TextDocumentHandle {
    let released = false;
    return {
      uri,
      version,
      release: () => {
        if (released) return;
        released = true;
        this.releaseTextDocument(uri);
      },
    };
  }

  private releaseTextDocument(uri: string): void {
    const state = this.openDocuments.get(uri);
    if (!state) return;
    state.refCount -= 1;
    if (state.refCount > 0) return;

    this.openDocuments.delete(uri);
    this.transport.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  private ensureDiagnosticsListener(): void {
    if (this.diagnosticsListener) return;
    this.diagnosticsListener = this.transport.onNotification("textDocument/publishDiagnostics", (params) => {
      const parsed = parsePublishDiagnostics(params);
      if (!parsed) return;
      const snapshot: DiagnosticsSnapshot = {
        uri: parsed.uri,
        diagnostics: parsed.diagnostics,
        ...(parsed.version !== undefined ? { version: parsed.version } : {}),
        sequence: ++this.diagnosticsSequence,
        updatedAt: Date.now(),
      };
      this.diagnosticsByUri.set(parsed.uri, snapshot);
      this.resolveDiagnosticsWaiters(parsed.uri, snapshot);
    });
  }

  private resolveDiagnosticsWaiters(uri: string, snapshot: DiagnosticsSnapshot): void {
    const waiters = this.diagnosticsWaiters.get(uri);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (snapshot.sequence > waiter.baseline) {
        waiter.resolve(snapshot);
      }
    }
  }

  private removeDiagnosticsWaiter(uri: string, waiter: DiagnosticsWaiter): void {
    const waiters = this.diagnosticsWaiters.get(uri);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.diagnosticsWaiters.delete(uri);
    }
  }
}

interface DiagnosticsWaiter {
  baseline: number;
  resolve: (snapshot: DiagnosticsSnapshot) => void;
  reject: (error: Error) => void;
}

interface OpenDocumentState {
  languageId: string;
  text: string;
  version: number;
  refCount: number;
}

function defaultClientCapabilities(): Record<string, unknown> {
  return {
    textDocument: {
      publishDiagnostics: {
        relatedInformation: true,
        versionSupport: true,
        codeDescriptionSupport: true,
        dataSupport: true,
      },
      synchronization: {
        didSave: true,
        willSave: false,
        willSaveWaitUntil: false,
      },
    },
  };
}

function mergeCapabilities(base: Record<string, unknown>, override: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!override) return base;
  return deepMergeRecords(base, override);
}

function deepMergeRecords(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMergeRecords(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function getNestedValue(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function parsePublishDiagnostics(params: unknown): { uri: string; diagnostics: unknown[]; version?: number } | undefined {
  if (!isRecord(params)) return undefined;
  const uri = params.uri;
  const diagnostics = params.diagnostics;
  if (typeof uri !== "string" || !Array.isArray(diagnostics)) return undefined;
  const version = typeof params.version === "number" ? params.version : undefined;
  return { uri, diagnostics, ...(version !== undefined ? { version } : {}) };
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
