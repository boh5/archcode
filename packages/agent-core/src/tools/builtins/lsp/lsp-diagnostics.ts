import type { Disposable } from "vscode-jsonrpc";
import { LspDiagnosticsInputSchema, type LspDiagnostic, type LspDiagnosticSeverity } from "../../../lsp/types";
import { LspError } from "../../../lsp/client";
import { getLspClientPool } from "../../../lsp/client-pool";
import { getLanguageIdFromFilename } from "../../../lsp/language-mapping";
import { getServerDefinitionsForLanguage } from "../../../lsp/server-definitions";
import { pathToFileUri } from "../../../lsp/uri-utils";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import { createWorkspacePermission } from "../../permission";
import { isRecord } from "./shared";
import { resolveAndValidatePath } from "../../security/path-validator";
import type { ToolExecutionResult } from "../../types";
import { formatDiagnostics, formatTimeout } from "./format-output";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const DIAGNOSTICS_TIMEOUT_MS = 5_000;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  "__test_tmp__",
]);
const MAX_DIR_FILES = 200;

type LspDiagnosticSeverityFilter = LspDiagnosticSeverity | "all";

interface PublishDiagnosticsParams {
  uri?: string;
  diagnostics?: unknown[];
}

interface SupportedFileEntry {
  filePath: string;
  languageId: string;
  serverId: string;
  command: string[];
}

// ─── Tool descriptor ───

export const lspDiagnosticsTool = defineTool({
  name: "lsp_diagnostics",
  description: "Get language-server diagnostics for a file or directory path.",
  inputSchema: LspDiagnosticsInputSchema,
  traits: {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  },
  permissions: [createWorkspacePermission({ pathKey: "filePath" })],
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    const severity = input.severity ?? "all";
    const { resolved: resolvedPath, isWithinWorkspace } = resolveAndValidatePath(
      input.filePath,
      ctx.workspaceRoot,
    );

    if (!isWithinWorkspace) {
      return createToolErrorResult({
        kind: "workspace",
        code: "TOOL_FILE_OUTSIDE_WORKSPACE",
        message: `Path "${input.filePath}" is outside the workspace`,
      });
    }

    try {
      const stats = await stat(resolvedPath);
      if (stats.isDirectory()) {
        return handleDirectoryDiagnostics(resolvedPath, severity, ctx);
      }
    } catch (error) {
      return createToolErrorResult({
        kind: "lsp-error",
        code: "TOOL_LSP_ERROR",
        error: error instanceof Error ? error : new Error(String(error)),
        message: `Unable to access path "${input.filePath}": ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return handleFileDiagnostics(resolvedPath, input.filePath, severity, ctx);
  },
});

// ─── Single-file handler (existing logic, extracted) ───

async function handleFileDiagnostics(
  resolvedPath: string,
  displayPath: string,
  severity: LspDiagnosticSeverityFilter,
  ctx: { workspaceRoot: string },
): Promise<string | ToolExecutionResult> {
  const languageId = getLanguageIdFromFilename(resolvedPath);
  if (!languageId) {
    return createToolErrorResult({
      kind: "lsp-server-not-found",
      code: "TOOL_LSP_SERVER_NOT_FOUND",
      message: `No language mapping found for "${displayPath}". Use a supported source file extension or configure an LSP server for this file type.`,
    });
  }

  const serverDefinition = getServerDefinitionsForLanguage(languageId)[0];
  if (!serverDefinition) {
    return createToolErrorResult({
      kind: "lsp-server-not-found",
      code: "TOOL_LSP_SERVER_NOT_FOUND",
      message: `No language server is available for language "${languageId}". Install or configure a compatible server, then retry.`,
      meta: { languageId },
    });
  }

  const pool = getLspClientPool();
  const poolKey = { workspaceRoot: ctx.workspaceRoot, serverId: serverDefinition.id };
  const uri = pathToFileUri(resolvedPath);
  let disposable: Disposable | undefined;
  let lastDiagnostics: LspDiagnostic[] = [];

  try {
    const text = await Bun.file(resolvedPath).text();
    const client = await pool.acquire(poolKey, {
      command: serverDefinition.command[0],
      args: serverDefinition.command.slice(1),
      cwd: ctx.workspaceRoot,
    });

    try {
      const diagnosticsPromise = new Promise<LspDiagnostic[]>((resolve) => {
        disposable = client.onNotification("textDocument/publishDiagnostics", (params) => {
          const published = parsePublishDiagnostics(params, resolvedPath, uri, severity);
          if (!published) return;
          lastDiagnostics = published;
          resolve(published);
        });
      });

      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version: 0,
          text,
        },
      });

      const diagnostics = await waitForDiagnostics(diagnosticsPromise, DIAGNOSTICS_TIMEOUT_MS);
      return formatDiagnostics(diagnostics, displayPath);
    } finally {
      disposable?.dispose();
      pool.release(poolKey);
    }
  } catch (error) {
    if (error instanceof DiagnosticsTimeoutError) {
      return createToolErrorResult({
        kind: "lsp-timeout",
        code: "TOOL_LSP_TIMEOUT",
        message: `${formatTimeout("Diagnostics", DIAGNOSTICS_TIMEOUT_MS)}\n${formatDiagnostics(lastDiagnostics, displayPath)}`,
        meta: { diagnostics: lastDiagnostics, timeoutMs: DIAGNOSTICS_TIMEOUT_MS },
      });
    }

    if (error instanceof LspError) {
      return createToolErrorResult({
        kind: error.kind,
        code: error.kind === "lsp-timeout" ? "TOOL_LSP_TIMEOUT" : "TOOL_LSP_ERROR",
        error,
        message: error.message,
        meta: { lspCode: error.code, lspData: error.data },
      });
    }

    return createToolErrorResult({
      kind: "lsp-error",
      code: "TOOL_LSP_ERROR",
      error: error instanceof Error ? error : new Error(String(error)),
      message: `LSP diagnostics failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ─── Directory handler ───

/**
 * Walk a directory recursively, collecting supported source files.
 * Skips patterns: node_modules, .git, dist, build, coverage, .turbo, .next,
 * __test_tmp__, hidden dirs (starting with "."). Symlinks are not followed
 * to avoid cycles. Stops at MAX_DIR_FILES (200) per request.
 */
async function walkSupportedFiles(rootPath: string): Promise<{
  supportedFiles: SupportedFileEntry[];
  totalFilesFound: number;
}> {
  const allFiles: string[] = [];
  let totalFileCount = 0;

  async function walk(currentPath: string) {
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        totalFileCount++;
        if (allFiles.length < MAX_DIR_FILES) {
          allFiles.push(fullPath);
        }
      }
    }
  }

  await walk(rootPath);

  const supportedFiles: SupportedFileEntry[] = [];

  for (const filePath of allFiles) {
    const lang = getLanguageIdFromFilename(filePath);
    if (!lang) continue;

    const serverDefs = getServerDefinitionsForLanguage(lang);
    if (!serverDefs || serverDefs.length === 0) continue;

    supportedFiles.push({
      filePath,
      languageId: lang,
      serverId: serverDefs[0].id,
      command: serverDefs[0].command,
    });
  }

  return { supportedFiles, totalFilesFound: totalFileCount };
}

function sortDiagnostics(a: LspDiagnostic, b: LspDiagnostic): number {
  const fpCmp = a.filePath.localeCompare(b.filePath);
  if (fpCmp !== 0) return fpCmp;
  if (a.line !== b.line) return a.line - b.line;
  if (a.column !== b.column) return a.column - b.column;
  return a.severity.localeCompare(b.severity);
}

function formatDirectoryDiagnostics(
  diagnostics: LspDiagnostic[],
  totalFilesFound: number,
  warnings: string[],
): string {
  if (diagnostics.length === 0) {
    const result = "No diagnostics found.";
    return warnings.length > 0 ? `${result}\n${warnings.join("\n")}` : result;
  }

  const lines = diagnostics.map((d) => {
    const codeStr = d.code ? ` ${d.code}` : "";
    return `${d.filePath}:${d.line}:${d.column} ${d.severity}${codeStr}: ${d.message}`;
  });

  let result = `Diagnostics:\n${lines.join("\n")}`;

  if (warnings.length > 0) {
    result += `\n${warnings.join("\n")}`;
  }

  if (totalFilesFound > MAX_DIR_FILES) {
    result += `\n[Directory diagnostics limited to ${MAX_DIR_FILES} files. ${totalFilesFound} total files found.]`;
  }

  return result;
}

async function handleDirectoryDiagnostics(
  dirPath: string,
  severity: LspDiagnosticSeverityFilter,
  ctx: { workspaceRoot: string },
): Promise<string | ToolExecutionResult> {
  const { supportedFiles, totalFilesFound } = await walkSupportedFiles(dirPath);

  if (supportedFiles.length === 0) {
    if (totalFilesFound === 0) {
      return "No diagnostics found.";
    }
    return "No diagnostics found (no supported language files).";
  }

  const filesToProcess = supportedFiles
    .slice(0, MAX_DIR_FILES)
    .sort((a, b) => a.filePath.localeCompare(b.filePath));

  const serverGroups = new Map<string, SupportedFileEntry[]>();
  for (const entry of filesToProcess) {
    const group = serverGroups.get(entry.serverId);
    if (group) {
      group.push(entry);
    } else {
      serverGroups.set(entry.serverId, [entry]);
    }
  }

  const pool = getLspClientPool();
  const allDiagnostics: LspDiagnostic[] = [];
  const warnings: string[] = [];

  for (const [, serverFiles] of serverGroups) {
    const serverId = serverFiles[0].serverId;
    const poolKey = { workspaceRoot: ctx.workspaceRoot, serverId };
    const firstEntry = serverFiles[0];

    let client;
    try {
      client = await pool.acquire(poolKey, {
        command: firstEntry.command[0],
        args: firstEntry.command.slice(1),
        cwd: ctx.workspaceRoot,
      });
    } catch (error) {
      warnings.push(`[Warning: Language server for ${firstEntry.languageId} could not be started: ${formatWarningMessage(error)}]`);
      continue;
    }

    try {
      for (const entry of serverFiles) {
        try {
          const text = await Bun.file(entry.filePath).text();
          const uri = pathToFileUri(entry.filePath);

          // Register one-shot handler before sending didOpen
          const diagnosticsPromise = new Promise<LspDiagnostic[]>((resolve) => {
            const disposable = client.onNotification("textDocument/publishDiagnostics", (params) => {
              const parsed = parsePublishDiagnostics(params, entry.filePath, uri, severity);
              if (parsed) {
                disposable.dispose();
                resolve(parsed);
              }
            });
          });

          client.sendNotification("textDocument/didOpen", {
            textDocument: {
              uri,
              languageId: entry.languageId,
              version: 0,
              text,
            },
          });

          const diagnostics = await waitForDiagnostics(diagnosticsPromise, DIAGNOSTICS_TIMEOUT_MS);
          allDiagnostics.push(...diagnostics);
        } catch (error) {
          warnings.push(`[Warning: Failed to process ${path.basename(entry.filePath)}: ${formatWarningMessage(error)}]`);
          continue;
        }
      }
    } finally {
      pool.release(poolKey);
    }
  }

  allDiagnostics.sort(sortDiagnostics);

  return formatDirectoryDiagnostics(allDiagnostics, totalFilesFound, warnings);
}

// ─── Diagnostics helpers ───

async function waitForDiagnostics(
  diagnosticsPromise: Promise<LspDiagnostic[]>,
  timeoutMs: number,
): Promise<LspDiagnostic[]> {
  let timeout: Timer | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new DiagnosticsTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([diagnosticsPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function parsePublishDiagnostics(
  params: unknown,
  filePath: string,
  expectedUri: string,
  severityFilter: LspDiagnosticSeverityFilter,
): LspDiagnostic[] | undefined {
  if (!isRecord(params)) return undefined;

  const publishParams = params as PublishDiagnosticsParams;
  if (publishParams.uri !== expectedUri || !Array.isArray(publishParams.diagnostics)) {
    return undefined;
  }

  return publishParams.diagnostics
    .map((diagnostic) => toLspDiagnostic(diagnostic, filePath))
    .filter((diagnostic): diagnostic is LspDiagnostic => diagnostic !== undefined)
    .filter((diagnostic) => severityFilter === "all" || diagnostic.severity === severityFilter);
}

function toLspDiagnostic(diagnostic: unknown, filePath: string): LspDiagnostic | undefined {
  if (!isRecord(diagnostic) || !isRecord(diagnostic.range)) return undefined;
  const range = diagnostic.range;
  if (!isRecord(range.start)) return undefined;

  const line = typeof range.start.line === "number" ? range.start.line + 1 : undefined;
  const column = typeof range.start.character === "number" ? range.start.character + 1 : undefined;
  const message = typeof diagnostic.message === "string" ? diagnostic.message : undefined;
  if (line === undefined || column === undefined || message === undefined) return undefined;

  return {
    filePath,
    line,
    column,
    severity: diagnosticSeverityToString(diagnostic.severity),
    message,
    ...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
  };
}

function diagnosticSeverityToString(severity: unknown): LspDiagnosticSeverity {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "error";
  }
}



function formatWarningMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class DiagnosticsTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`LSP diagnostics timed out after ${timeoutMs}ms`);
    this.name = "DiagnosticsTimeoutError";
  }
}
