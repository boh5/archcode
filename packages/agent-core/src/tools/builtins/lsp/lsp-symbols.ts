import { LspSymbolsInputSchema, type LspSymbol } from "../../../lsp/types";
import { LspError } from "../../../lsp/client";
import { getLspClientPool } from "../../../lsp/client-pool";
import { getLanguageIdFromFilename } from "../../../lsp/language-mapping";
import { BUILTIN_SERVER_DEFINITIONS, getServerDefinitionsForLanguage } from "../../../lsp/server-definitions";
import { fileUriToPath, pathToFileUri } from "../../../lsp/uri-utils";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import { createWorkspacePermission } from "../../permission";
import { isRecord } from "./shared";
import { resolveAndValidatePath } from "../../security/path-validator";
import type { ToolExecutionResult } from "../../types";
import { formatDocumentSymbols, formatWorkspaceSymbols } from "./format-output";

interface RangeLike {
  start?: {
    line?: unknown;
    character?: unknown;
  };
}

// ─── Tool descriptor ───

export const lspSymbolsTool = defineTool({
  name: "lsp_symbols",
  description: "Get document or workspace symbols from a language server.",
  inputSchema: LspSymbolsInputSchema,
  traits: {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  },
  permissions: [createWorkspacePermission({ pathKey: "filePath" })],
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    if (input.scope === "workspace") {
      return handleWorkspaceSymbols(input.query!, ctx);
    }

    return handleDocumentSymbols(input.filePath!, ctx);
  },
});

// ─── Document symbols ───

async function handleDocumentSymbols(
  filePath: string,
  ctx: { workspaceRoot: string },
): Promise<string | ToolExecutionResult> {
  const { resolved: resolvedPath, isWithinWorkspace } = resolveAndValidatePath(
    filePath,
    ctx.workspaceRoot,
  );

  if (!isWithinWorkspace) {
    return createToolErrorResult({
      kind: "workspace",
      code: "TOOL_FILE_OUTSIDE_WORKSPACE",
      message: `Path "${filePath}" is outside the workspace`,
    });
  }

  const languageId = getLanguageIdFromFilename(resolvedPath);
  if (!languageId) {
    return createToolErrorResult({
      kind: "lsp-server-not-found",
      code: "TOOL_LSP_SERVER_NOT_FOUND",
      message: `No language mapping found for "${filePath}". Use a supported source file extension or configure an LSP server for this file type.`,
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

  try {
    const text = await Bun.file(resolvedPath).text();
    const client = await pool.acquire(poolKey, {
      command: serverDefinition.command[0],
      args: serverDefinition.command.slice(1),
      cwd: ctx.workspaceRoot,
    });

    try {
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version: 0,
          text,
        },
      });

      const response = await client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri },
      });
      return formatDocumentSymbols(parseDocumentSymbols(response, resolvedPath));
    } finally {
      pool.release(poolKey);
    }
  } catch (error) {
    return toLspToolErrorResult(error, "LSP document symbols failed");
  }
}

// ─── Workspace symbols ───

async function handleWorkspaceSymbols(
  query: string,
  ctx: { workspaceRoot: string },
): Promise<string | ToolExecutionResult> {
  // Workspace symbols have no file path to infer a language server from, so use
  // the first built-in server (TypeScript) as the default broad workspace indexer.
  const serverDefinition = BUILTIN_SERVER_DEFINITIONS[0];
  if (!serverDefinition) {
    return createToolErrorResult({
      kind: "lsp-server-not-found",
      code: "TOOL_LSP_SERVER_NOT_FOUND",
      message: "Workspace symbols require an available language server. No built-in workspace language server is configured; try scope=\"document\" with a specific filePath so Specra can choose a server from the file language.",
    });
  }

  const pool = getLspClientPool();
  const poolKey = { workspaceRoot: ctx.workspaceRoot, serverId: serverDefinition.id };

  try {
    const client = await pool.acquire(poolKey, {
      command: serverDefinition.command[0],
      args: serverDefinition.command.slice(1),
      cwd: ctx.workspaceRoot,
    });

    try {
      const response = await client.sendRequest("workspaceSymbol/symbol", { query });
      return formatWorkspaceSymbols(parseSymbolInformationList(response));
    } finally {
      pool.release(poolKey);
    }
  } catch (error) {
    return toLspToolErrorResult(error, "LSP workspace symbols failed");
  }
}

// ─── Symbol parsing ───

function parseDocumentSymbols(response: unknown, filePath: string): LspSymbol[] {
  if (!Array.isArray(response)) return [];

  return response.flatMap((item) => {
    if (isDocumentSymbol(item)) {
      return flattenDocumentSymbol(item, filePath);
    }

    const symbol = toLspSymbolFromSymbolInformation(item);
    return symbol ? [symbol] : [];
  });
}

function flattenDocumentSymbol(symbol: Record<string, unknown>, filePath: string): LspSymbol[] {
  const current = toLspSymbolFromDocumentSymbol(symbol, filePath);
  const children = Array.isArray(symbol.children)
    ? symbol.children.flatMap((child) => isRecord(child) ? flattenDocumentSymbol(child, filePath) : [])
    : [];

  return current ? [current, ...children] : children;
}

function parseSymbolInformationList(response: unknown): LspSymbol[] {
  if (!Array.isArray(response)) return [];
  return response.flatMap((item) => {
    const symbol = toLspSymbolFromSymbolInformation(item);
    return symbol ? [symbol] : [];
  });
}

function isDocumentSymbol(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isRecord(value.range) && !isRecord(value.location);
}

function toLspSymbolFromDocumentSymbol(symbol: Record<string, unknown>, filePath: string): LspSymbol | undefined {
  const name = typeof symbol.name === "string" ? symbol.name : undefined;
  const kind = typeof symbol.kind === "number" ? symbolKindToString(symbol.kind) : undefined;
  const position = rangeStart(symbol.range);
  if (!name || !kind || !position) return undefined;

  return {
    name,
    kind,
    filePath,
    line: position.line + 1,
    column: position.character + 1,
  };
}

function toLspSymbolFromSymbolInformation(symbol: unknown): LspSymbol | undefined {
  if (!isRecord(symbol) || !isRecord(symbol.location)) return undefined;

  const name = typeof symbol.name === "string" ? symbol.name : undefined;
  const kind = typeof symbol.kind === "number" ? symbolKindToString(symbol.kind) : undefined;
  const uri = typeof symbol.location.uri === "string" ? symbol.location.uri : undefined;
  const locationRange = isRecord(symbol.location.range) ? symbol.location.range : undefined;
  const position = rangeStart(locationRange);
  if (!name || !kind || !uri || !position) return undefined;

  return {
    name,
    kind,
    filePath: fileUriToPath(uri),
    line: position.line + 1,
    column: position.character + 1,
  };
}

function rangeStart(range: unknown): { line: number; character: number } | undefined {
  if (!isRecord(range)) return undefined;
  const start = (range as RangeLike).start;
  if (!start || typeof start.line !== "number" || typeof start.character !== "number") return undefined;
  return { line: start.line, character: start.character };
}

function symbolKindToString(kind: number): string {
  switch (kind) {
    case 1:
      return "File";
    case 2:
      return "Module";
    case 3:
      return "Namespace";
    case 4:
      return "Package";
    case 5:
      return "Class";
    case 6:
      return "Method";
    case 7:
      return "Property";
    case 8:
      return "Field";
    case 9:
      return "Constructor";
    case 10:
      return "Enum";
    case 11:
      return "Interface";
    case 12:
      return "Function";
    case 13:
      return "Variable";
    case 14:
      return "Constant";
    case 15:
      return "String";
    case 16:
      return "Number";
    case 17:
      return "Boolean";
    case 18:
      return "Array";
    case 19:
      return "Object";
    case 20:
      return "Key";
    case 21:
      return "Null";
    case 22:
      return "EnumMember";
    case 23:
      return "Struct";
    case 24:
      return "Event";
    case 25:
      return "Operator";
    case 26:
      return "TypeParameter";
    default:
      return `Unknown(${kind})`;
  }
}

// ─── Error helpers ───

function toLspToolErrorResult(error: unknown, label: string): ToolExecutionResult {
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
    message: `${label}: ${error instanceof Error ? error.message : String(error)}`,
  });
}


