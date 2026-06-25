import { join } from "node:path";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { createProcessRunner, setProcessRunnerForTest } from "../process/runner";
import type { ProcessRunnerResult } from "../process/types";
import { getServerDefinitionById, type LspServerDefinition } from "./server-definitions";

export interface ExecCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecCommand = (command: string[], options?: ExecCommandOptions) => Promise<ExecCommandResult>;

export interface ExecCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class LspInstallerError extends Error {
  readonly serverId: string;
  readonly command: string;
  readonly details?: string;

  constructor(params: { serverId: string; message: string; command: string; details?: string }) {
    super(params.message);
    this.name = "LspInstallerError";
    this.serverId = params.serverId;
    this.command = params.command;
    this.details = params.details;
  }
}

const installLocks = new Map<string, Promise<string>>();
const resolvedBinaryCache = new Map<string, string>();

export interface LspInstallerOptions {
  logger?: Logger;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_NPM_INSTALL_TIMEOUT_MS = 90_000;

export function setInstallerProcessRunnerForTest(fn: Parameters<typeof setProcessRunnerForTest>[0]): void {
  setProcessRunnerForTest(fn);
  installLocks.clear();
  resolvedBinaryCache.clear();
}

export async function resolveServerBinary(serverId: string, options: LspInstallerOptions = {}): Promise<string> {
  const logger = (options.logger ?? silentLogger).child({ module: "lsp.installer" });
  const cached = resolvedBinaryCache.get(serverId);
  if (cached) return cached;

  const existingLock = installLocks.get(serverId);
  if (existingLock) return existingLock;

  const promise = resolveServerBinaryUncached(serverId, {
    logger,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  installLocks.set(serverId, promise);

  try {
    const binaryPath = await promise;
    resolvedBinaryCache.set(serverId, binaryPath);
    return binaryPath;
  } catch (error) {
    logger.warn("lsp.installer.resolve.failed", {
      context: { serverId, error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  } finally {
    installLocks.delete(serverId);
  }
}

async function resolveServerBinaryUncached(serverId: string, options: LspInstallerOptions = {}): Promise<string> {
  const logger = (options.logger ?? silentLogger).child({ module: "lsp.installer" });
  const definition = getServerDefinitionById(serverId);
  if (!definition) {
    logger.warn("lsp.installer.resolve.failed", {
      context: { serverId, reason: "unknown-server" },
    });
    throw new LspInstallerError({
      serverId,
      command: "Check configured LSP server id",
      message: `Unknown LSP server "${serverId}". Check the server id and retry.`,
    });
  }

  const binary = definition.command[0];
  const pathBinary = await findOnPath(binary, { logger });
  if (pathBinary) return pathBinary;

  if (!definition.npmPackage) {
    logger.warn("lsp.installer.resolve.failed", {
      context: { serverId, reason: "binary-not-found", binary },
    });
    throw createManualInstallError(definition);
  }

  return installNpmServer(definition, { logger, timeoutMs: options.timeoutMs, signal: options.signal });
}

async function findOnPath(binary: string, options: LspInstallerOptions = {}): Promise<string | undefined> {
  const logger = (options.logger ?? silentLogger).child({ module: "lsp.installer" });
  const command = process.platform === "win32" ? ["where", binary] : ["which", binary];
  const result = await runInstallerCommand(command);
  if (result.exitCode !== 0) {
    logger.debug("lsp.installer.path.search.failed", { context: { binary, command: command[0], exitCode: result.exitCode } });
    return undefined;
  }

  const firstLine = result.stdout.trim().split(/\r?\n/).find(Boolean);
  return firstLine;
}

async function installNpmServer(definition: LspServerDefinition, options: LspInstallerOptions = {}): Promise<string> {
  const logger = (options.logger ?? silentLogger).child({ module: "lsp.installer" });
  const binary = definition.command[0];
  const installRoot = getInstallRoot(definition.id);
  const tempRoot = `${installRoot}.tmp-${crypto.randomUUID()}`;

  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });

  const installCommand = ["npm", "install", "-g", "--prefix", tempRoot, definition.npmPackage!];
  const timeoutMs = options.timeoutMs ?? DEFAULT_NPM_INSTALL_TIMEOUT_MS;
  const installResult = await runInstallerCommand(installCommand, { timeoutMs, signal: options.signal });

  if (installResult.exitCode !== 0) {
    await rm(tempRoot, { recursive: true, force: true });
    logger.warn("lsp.installer.npm.install.failed", {
      context: { serverId: definition.id, command: "npm install", exitCode: installResult.exitCode },
    });
    throw new LspInstallerError({
      serverId: definition.id,
      command: `npm install -g ${definition.npmPackage}`,
      message: installResult.stderr.includes("timed out")
        ? `Timed out after ${timeoutMs}ms while installing ${definition.id} language server. Run manually: npm install -g ${definition.npmPackage}`
        : `Failed to install ${definition.id} language server. Run manually: npm install -g ${definition.npmPackage}`,
      details: installResult.stderr || installResult.stdout,
    });
  }

  const binaryPath = await findInstalledBinary(tempRoot, binary);
  if (!binaryPath) {
    await rm(tempRoot, { recursive: true, force: true });
    logger.warn("lsp.installer.npm.binary.resolve.failed", {
      context: { serverId: definition.id, binary },
    });
    throw new LspInstallerError({
      serverId: definition.id,
      command: `npm install -g ${definition.npmPackage}`,
      message: `Installed ${definition.npmPackage} but could not find binary "${binary}". Run manually: npm install -g ${definition.npmPackage}`,
    });
  }

  await rm(installRoot, { recursive: true, force: true });
  await mkdir(getInstallBaseDir(), { recursive: true });
  await rename(tempRoot, installRoot);

  return binaryPath.replace(tempRoot, installRoot);
}

async function findInstalledBinary(prefix: string, binary: string): Promise<string | undefined> {
  const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");
  const names = await readdir(binDir).catch(() => []);
  const exact = names.find((name) => name === binary || name === `${binary}.cmd` || name === `${binary}.exe`);
  return exact ? join(binDir, exact) : undefined;
}

function createManualInstallError(definition: LspServerDefinition): LspInstallerError {
  const command = manualInstallCommand(definition);
  return new LspInstallerError({
    serverId: definition.id,
    command,
    message: `${definition.id} language server binary "${definition.command[0]}" was not found on PATH. Install manually: ${command}`,
  });
}

function manualInstallCommand(definition: LspServerDefinition): string {
  if (definition.id === "go") return "go install golang.org/x/tools/gopls@latest";
  if (definition.id === "rust") return "rustup component add rust-analyzer";
  if (definition.id === "c" || definition.id === "cpp") return "Install clangd from your system package manager";
  if (definition.id === "swift") return "Install Xcode command line tools for sourcekit-lsp";
  if (definition.id === "dart") return "Install Dart SDK and ensure dart is on PATH";
  return `Install ${definition.command[0]} and ensure it is on PATH`;
}

function getInstallRoot(serverId: string): string {
  return join(getInstallBaseDir(), serverId);
}

function getInstallBaseDir(): string {
  const base = Bun.env.XDG_CACHE_HOME ?? (Bun.env.HOME ? join(Bun.env.HOME, ".cache") : import.meta.dir);
  return join(base, "archcode", "lsp-servers");
}

async function runInstallerCommand(command: string[], options: ExecCommandOptions = {}): Promise<ExecCommandResult> {
  const result = await createProcessRunner().run({
    argv: toArgv(command),
    cwd: options.cwd,
    env: options.env ? { ...Bun.env, ...options.env } : undefined,
    stdin: null,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });

  return processRunnerResultToExecResult(result);
}

function toArgv(command: string[]): [string, ...string[]] {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Installer command cannot be empty");
  return [executable, ...args];
}

function processRunnerResultToExecResult(result: ProcessRunnerResult): ExecCommandResult {
  if (result.kind === "spawn-failure") {
    return { stdout: "", stderr: result.error.message, exitCode: 1 };
  }

  if (result.kind === "success" || result.kind === "nonzero") {
    return { stdout: result.output.stdout, stderr: result.output.stderr, exitCode: result.exitCode };
  }

  if (result.kind === "timeout") {
    return {
      stdout: result.output.stdout,
      stderr: result.output.stderr || `Process timed out after ${result.timeoutMs}ms`,
      exitCode: result.exitCode ?? 1,
    };
  }

  if (result.kind === "aborted") {
    return {
      stdout: result.output.stdout,
      stderr: result.output.stderr || `Process aborted${result.reason ? `: ${result.reason}` : ""}`,
      exitCode: result.exitCode ?? 1,
    };
  }

  return {
    stdout: result.output.stdout,
    stderr: result.output.stderr || `Process exited due to signal ${result.signal}`,
    exitCode: result.exitCode ?? 1,
  };
}
