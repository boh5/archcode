import { LspFindReferencesInputSchema, type LspLocation, LspError, getLspClientPool, getLanguageIdFromFilename, getServerDefinitionsForLanguage, fileUriToPath, pathToFileUri } from "../../../lsp";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import { createWorkspacePermission } from "../../permission";
import { isRecord } from "./shared";
import { getLspToolLogger } from "./tool-logger";
import { resolveAndValidatePath } from "../../security/path-validator";
import type { ToolExecutionResult } from "../../types";
import { formatReferences } from "./format-output";

interface LspReferenceLocation {
  uri?: string;
  range?: {
    start?: {
      line?: number;
      character?: number;
    };
  };
}

// ─── Tool descriptor ───

export const lspFindReferencesTool = defineTool({
  name: "lsp_find_references",
  description: "Find semantic references for a symbol at a known source position. Use it before renaming or changing a public symbol to identify affected call sites, then read the returned locations; use grep as a text-search fallback, not as proof of symbol identity. Requires a language mapping and an available language server for the source file; otherwise the call returns an error.",
  inputSchema: LspFindReferencesInputSchema,
  traits: {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  },
  permissions: [createWorkspacePermission({ pathKey: "filePath" })],
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    const includeDeclaration = input.includeDeclaration ?? true;
    // Workspace access is enforced by createWorkspacePermission() guard.
    // Out-of-workspace paths may have been explicitly approved.
    const { resolved: resolvedPath } = resolveAndValidatePath(
      input.filePath,
      ctx.cwd,
    );

    const languageId = getLanguageIdFromFilename(resolvedPath);
    if (!languageId) {
      return createToolErrorResult({
        kind: "lsp-server-not-found",
        code: "TOOL_LSP_SERVER_NOT_FOUND",
        message: `No language mapping found for "${input.filePath}". Use a supported source file extension or configure an LSP server for this file type.`,
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

        const result = await client.sendRequest("textDocument/references", {
          textDocument: { uri },
          position: { line: input.line - 1, character: input.character },
          context: { includeDeclaration },
        });

        if (result === null) return "No references found.";

        const locations = parseReferenceLocations(result).sort(sortLocations);
        return formatReferences(locations);
      } finally {
        documentHandle?.release();
        pool.release(poolKey);
      }
    } catch (error) {
      if (error instanceof LspError) {
        getLspToolLogger().warn("lsp.find-references.error", {
          module: "lsp.find-references",
          error,
          context: { lspCode: error.code },
        });
        return createToolErrorResult({
          kind: error.kind,
          code: error.kind === "lsp-timeout" ? "TOOL_LSP_TIMEOUT" : "TOOL_LSP_ERROR",
          error,
          message: error.message,
          meta: { lspCode: error.code, lspData: error.data },
        });
      }

      getLspToolLogger().error("lsp.find-references.failed", {
        module: "lsp.find-references",
        error,
      });
      return createToolErrorResult({
        kind: "lsp-error",
        code: "TOOL_LSP_ERROR",
        error: error instanceof Error ? error : new Error(String(error)),
        message: `LSP find references failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },
});

function parseReferenceLocations(value: unknown): LspLocation[] {
  if (!Array.isArray(value)) return [];

  const locations: LspLocation[] = [];
  for (const item of value) {
    if (!isReferenceLocation(item)) continue;
    locations.push({
      filePath: fileUriToPath(item.uri),
      line: item.range.start.line + 1,
      column: item.range.start.character + 1,
    });
  }
  return locations;
}

function sortLocations(a: LspLocation, b: LspLocation): number {
  return a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column;
}

function isReferenceLocation(value: unknown): value is Required<LspReferenceLocation> & {
  range: { start: { line: number; character: number } };
} {
  if (!isRecord(value) || typeof value.uri !== "string") return false;
  if (!isRecord(value.range) || !isRecord(value.range.start)) return false;
  return typeof value.range.start.line === "number" && typeof value.range.start.character === "number";
}
