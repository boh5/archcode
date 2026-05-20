import { join } from "node:path";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
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

let execCommand: ExecCommand = runExecCommand;

export function setExecCommandForTest(fn: ExecCommand | undefined): void {
  execCommand = fn ?? runExecCommand;
  installLocks.clear();
  resolvedBinaryCache.clear();
}

export async function resolveServerBinary(serverId: string): Promise<string> {
  const cached = resolvedBinaryCache.get(serverId);
  if (cached) return cached;

  const existingLock = installLocks.get(serverId);
  if (existingLock) return existingLock;

  const promise = resolveServerBinaryUncached(serverId);
  installLocks.set(serverId, promise);

  try {
    const binaryPath = await promise;
    resolvedBinaryCache.set(serverId, binaryPath);
    return binaryPath;
  } finally {
    installLocks.delete(serverId);
  }
}

async function resolveServerBinaryUncached(serverId: string): Promise<string> {
  const definition = getServerDefinitionById(serverId);
  if (!definition) {
    throw new LspInstallerError({
      serverId,
      command: "Check configured LSP server id",
      message: `Unknown LSP server "${serverId}". Check the server id and retry.`,
    });
  }

  const binary = definition.command[0];
  const pathBinary = await findOnPath(binary);
  if (pathBinary) return pathBinary;

  if (!definition.npmPackage) {
    throw createManualInstallError(definition);
  }

  return installNpmServer(definition);
}

async function findOnPath(binary: string): Promise<string | undefined> {
  const command = process.platform === "win32" ? ["where", binary] : ["which", binary];
  const result = await execCommand(command);
  if (result.exitCode !== 0) return undefined;

  const firstLine = result.stdout.trim().split(/\r?\n/).find(Boolean);
  return firstLine;
}

async function installNpmServer(definition: LspServerDefinition): Promise<string> {
  const binary = definition.command[0];
  const installRoot = getInstallRoot(definition.id);
  const tempRoot = `${installRoot}.tmp-${crypto.randomUUID()}`;

  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });

  const installCommand = ["npm", "install", "-g", "--prefix", tempRoot, definition.npmPackage!];
  const installResult = await execCommand(installCommand);

  if (installResult.exitCode !== 0) {
    await rm(tempRoot, { recursive: true, force: true });
    throw new LspInstallerError({
      serverId: definition.id,
      command: `npm install -g ${definition.npmPackage}`,
      message: `Failed to install ${definition.id} language server. Run manually: npm install -g ${definition.npmPackage}`,
      details: installResult.stderr || installResult.stdout,
    });
  }

  const binaryPath = await findInstalledBinary(tempRoot, binary);
  if (!binaryPath) {
    await rm(tempRoot, { recursive: true, force: true });
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
  return join(base, "specra", "lsp-servers");
}

async function runExecCommand(command: string[], options: ExecCommandOptions = {}): Promise<ExecCommandResult> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...Bun.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}
