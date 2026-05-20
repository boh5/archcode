import { Buffer } from "node:buffer";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { StdioLspTransport, type LspTransport } from "./transport";

// ─── Types & Defaults ───

export interface FakeLspServerConfig {
  /** Custom result for the initialize request. Falls back to DEFAULT_INITIALIZE_RESULT. */
  initializeResult?: Record<string, unknown>;
  /** Map of method → result for configuring LSP method responses. */
  responses?: Record<string, unknown>;
  /** Diagnostics to push as textDocument/publishDiagnostics after didOpen. */
  autoDiagnostics?: unknown[];
  /** Delay all responses (except exit) by this many ms. */
  delayMs?: number;
  /** If true, exit after handling the initialize request (default exit code 1). */
  crashAfterInitialize?: boolean;
  /** Exit code to use when crashAfterInitialize is true. */
  crashExitCode?: number;
}

export const DEFAULT_INITIALIZE_RESULT: Record<string, unknown> = {
  capabilities: {
    textDocumentSync: 1,
    definitionProvider: true,
    referencesProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    publishDiagnostics: true,
  },
  serverInfo: { name: "fake-lsp-server", version: "0.0.1" },
};

const DEFAULT_CONFIG: FakeLspServerConfig = {
  crashExitCode: 1,
};

// ─── JSON-RPC Framing (stdin/stdout Content-Length) ───

const encoder = new TextEncoder();
let buf = "";

function writeMessage(msg: unknown): void {
  const json = JSON.stringify(msg);
  const bytes = encoder.encode(json);
  const header = `Content-Length: ${bytes.length}\r\n\r\n`;
  process.stdout.write(Buffer.concat([encoder.encode(header), bytes]));
}

function waitForReadable(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.once("readable", resolve);
  });
}

async function readMessage(): Promise<unknown> {
  for (;;) {
    const m = buf.match(/Content-Length: (\d+)\r\n\r\n/);
    if (m) {
      const len = parseInt(m[1], 10);
      const end = m.index! + m[0].length;
      if (buf.length >= end + len) {
        const body = buf.slice(end, end + len);
        buf = buf.slice(end + len);
        return JSON.parse(body);
      }
    }
    const raw = process.stdin.read() as Buffer | null;
    if (raw !== null) {
      buf += raw.toString("utf-8");
    } else {
      await waitForReadable();
    }
  }
}

// ─── Subprocess Message Handler ───

async function handle(msg: any, config: FakeLspServerConfig): Promise<void> {
  if (config.delayMs && msg.method !== "exit") {
    await new Promise((r) => setTimeout(r, config.delayMs));
  }

  if (msg.id !== undefined && msg.id !== null) {
    switch (msg.method) {
      case "initialize": {
        const result = config.initializeResult ?? DEFAULT_INITIALIZE_RESULT;
        writeMessage({ jsonrpc: "2.0", id: msg.id, result });
        if (config.crashAfterInitialize) {
          process.exit(config.crashExitCode ?? 1);
        }
        return;
      }
      case "shutdown":
        writeMessage({ jsonrpc: "2.0", id: msg.id, result: null });
        return;
    }

    if (config.responses && Object.prototype.hasOwnProperty.call(config.responses, msg.method)) {
      writeMessage({ jsonrpc: "2.0", id: msg.id, result: config.responses[msg.method] });
      return;
    }

    if (msg.method === "test/echo") {
      writeMessage({ jsonrpc: "2.0", id: msg.id, result: msg.params ?? null });
      return;
    }

    writeMessage({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  } else {
    switch (msg.method) {
      case "exit":
        process.exit(0);
        return;
      case "textDocument/didOpen":
        if (config.autoDiagnostics) {
          writeMessage({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: {
              uri: msg.params?.textDocument?.uri ?? "",
              diagnostics: config.autoDiagnostics,
            },
          });
        }
        return;
    }

    if (msg.method === "test/notify") {
      writeMessage({ jsonrpc: "2.0", method: "test/notify-ack", params: msg.params ?? null });
      return;
    }
  }
}

// ─── Subprocess Main Loop ───

async function main(config: FakeLspServerConfig): Promise<void> {
  for (;;) {
    try {
      const msg = await readMessage();
      if (msg === undefined) break;
      await handle(msg, config);
    } catch {
      process.exit(1);
    }
  }
}

// ─── FakeLspServer Test Helper ───

export class FakeLspServer {
  private readonly config: FakeLspServerConfig;
  private transport: StdioLspTransport | null = null;
  private tempConfigPath: string | null = null;
  private _initializeResult: unknown | null = null;

  constructor(config?: Partial<FakeLspServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** The subprocess exited promise (resolves with exit code). Undefined before start(). */
  get exited(): Promise<number> | undefined {
    return this.transport?.exited;
  }

  /** The result returned by the initialize request. Null before start(). */
  get initializeResult(): unknown {
    return this._initializeResult;
  }

  /**
   * Start the fake LSP server subprocess and connect.
   * Returns the connected LspTransport.
   */
  async start(): Promise<LspTransport> {
    if (this.transport) {
      throw new Error("FakeLspServer is already running");
    }

    const tmpDir = path.join(import.meta.dir, "__test_tmp__");
    await mkdir(tmpDir, { recursive: true });

    const configId = crypto.randomUUID();
    const configPath = path.join(tmpDir, `fake-lsp-config-${configId}.json`);
    await Bun.write(configPath, JSON.stringify(this.config));
    this.tempConfigPath = configPath;

    const serverPath = path.join(import.meta.dir, "fake-server.ts");
    this.transport = new StdioLspTransport({
      command: "bun",
      args: ["run", serverPath],
      env: { ...process.env, FAKE_LSP_CONFIG: configPath },
    });

    this._initializeResult = await this.transport.connect();
    return this.transport;
  }

  /**
   * Register a one-shot handler for a server-pushed notification.
   * Returns a promise that resolves with the notification params.
   */
  waitForNotification(method: string, timeoutMs = 10_000): Promise<unknown> {
    if (!this.transport) {
      throw new Error("FakeLspServer is not started");
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Notification "${method}" timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const disposable = this.transport!.onNotification(method, (params) => {
        clearTimeout(timeout);
        disposable.dispose();
        resolve(params);
      });
    });
  }

  /** Stop the server: graceful shutdown + cleanup config file. */
  async stop(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.dispose();
      } catch {
        }
      this.transport = null;
    }
    if (this.tempConfigPath) {
      try {
        await Bun.file(this.tempConfigPath).delete();
      } catch {
      }
      this.tempConfigPath = null;
    }
  }
}

// ─── Entry Point (runs when file is spawned as subprocess) ───

if (import.meta.main) {
  if (process.env.FAKE_LSP_CONFIG) {
    // Configurable mode: read config from temp file
    const text = await Bun.file(process.env.FAKE_LSP_CONFIG).text();
    const config = JSON.parse(text) as FakeLspServerConfig;
    main(config).catch(() => process.exit(1));
  } else {
    // Default backward-compatible mode (no config file provided)
    main(DEFAULT_CONFIG).catch(() => process.exit(1));
  }
}
