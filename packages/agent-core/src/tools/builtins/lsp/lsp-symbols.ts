import { LspSymbolsInputSchema, type LspSymbol, LspError, getLspClientPool, getLanguageIdFromFilename, BUILTIN_SERVER_DEFINITIONS, getServerDefinitionsForLanguage, fileUriToPath, pathToFileUri } from "../../../lsp";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import { createWorkspacePermission } from "../../permission";
import { isRecord } from "./shared";
import { getLspToolLogger } from "./tool-logger";
import { resolveAndValidatePath } from "../../security/path-validator";
import { createTextToolResult } from "../../results";
import type { RawToolResult } from "../../types";
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
  description: "Discover document or workspace symbols by semantic name. A typical code-intelligence chain is lsp_symbols -> lsp_goto_definition or lsp_find_references -> file_read. Symbol output reports 1-based line and column values; pass line through unchanged, but pass character=column-1 to goto-definition or find-references because their character input is 0-based. Document scope selects a server from filePath; workspace scope uses ArchCode's built-in workspace server. If no suitable server is available, the call returns an error; fall back to grep/glob for textual discovery.",
  inputSchema: LspSymbolsInputSchema,
  traits: {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  permissions: [createWorkspacePermission({ pathKey: "filePath" })],
  async execute(input, ctx): Promise<RawToolResult> {
    if (input.scope === "workspace") {
      return handleWorkspaceSymbols(input.query!, ctx);
    }

    return handleDocumentSymbols(input.filePath!, ctx);
  },
});

// ─── Document symbols ───

async function handleDocumentSymbols(
  filePath: string,
  ctx: { cwd: string },
): Promise<RawToolResult> {
  // Workspace access is enforced by createWorkspacePermission() guard.
  // Out-of-workspace paths may have been explicitly approved.
  const { resolved: resolvedPath } = resolveAndValidatePath(
    filePath,
    ctx.cwd,
  );

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
    });
  }

  const pool = getLspClientPool();
  const poolKey = { workspaceRoot: ctx.cwd, serverId: serverDefinition.id };
  const uri = pathToFileUri(resolvedPath);

  try {
    const text = await Bun.file(resolvedPath).text();
    const client = await pool.acquire(poolKey, {
      command: serverDefinition.command[0],
      args: serverDefinition.command.slice(1),
      cwd: ctx.cwd,
      ...(serverDefinition.initializationOptions ? { initializationOptions: serverDefinition.initializationOptions } : {}),
    });

    let documentHandle;
    try {
      documentHandle = client.openTextDocument({ uri, languageId, text });

      const response = await client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri },
      });
      return createTextToolResult(formatDocumentSymbols(parseDocumentSymbols(response, resolvedPath)));
    } finally {
      documentHandle?.release();
      pool.release(poolKey);
    }
  } catch (error) {
    logLspToolError(error, "document symbols");
    return toLspToolErrorResult(error, "LSP document symbols failed");
  }
}

// ─── Workspace symbols ───

async function handleWorkspaceSymbols(
  query: string,
  ctx: { cwd: string },
): Promise<RawToolResult> {
  // Workspace symbols have no file path to infer a language server from, so use
  // the first built-in server (TypeScript) as the default broad workspace indexer.
  const serverDefinition = BUILTIN_SERVER_DEFINITIONS[0];
  if (!serverDefinition) {
    return createToolErrorResult({
      kind: "lsp-server-not-found",
      code: "TOOL_LSP_SERVER_NOT_FOUND",
      message: "Workspace symbols require an available language server. No built-in workspace language server is configured; try scope=\"document\" with a specific filePath so ArchCode can choose a server from the file language.",
    });
  }

  const pool = getLspClientPool();
  const poolKey = { workspaceRoot: ctx.cwd, serverId: serverDefinition.id };

  try {
    const client = await pool.acquire(poolKey, {
      command: serverDefinition.command[0],
      args: serverDefinition.command.slice(1),
      cwd: ctx.cwd,
      ...(serverDefinition.initializationOptions ? { initializationOptions: serverDefinition.initializationOptions } : {}),
    });

    try {
      const response = await client.sendRequest("workspaceSymbol/symbol", { query });
      return createTextToolResult(formatWorkspaceSymbols(parseSymbolInformationList(response)));
    } finally {
      pool.release(poolKey);
    }
  } catch (error) {
    logLspToolError(error, "workspace symbols");
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

function logLspToolError(error: unknown, scope: string): void {
  if (error instanceof LspError) {
    getLspToolLogger().warn("lsp.symbols.error", {
      module: "lsp.symbols",
      error,
      context: { scope, lspCode: error.code },
    });
  } else {
    getLspToolLogger().error("lsp.symbols.failed", {
      module: "lsp.symbols",
      error,
      context: { scope },
    });
  }
}

function toLspToolErrorResult(error: unknown, label: string): RawToolResult {
  if (error instanceof LspError) {
    return createToolErrorResult({
      kind: error.kind,
      code: error.kind === "lsp-timeout" ? "TOOL_LSP_TIMEOUT" : "TOOL_LSP_ERROR",
      error,
      message: error.message,
    });
  }

  return createToolErrorResult({
    kind: "lsp-error",
    code: "TOOL_LSP_ERROR",
    error: error instanceof Error ? error : new Error(String(error)),
    message: `${label}: ${error instanceof Error ? error.message : String(error)}`,
  });
}
