import { LspFindReferencesInputSchema, type LspLocation } from "../../../lsp/types";
import { LspError } from "../../../lsp/client";
import { getLspClientPool } from "../../../lsp/client-pool";
import { getLanguageIdFromFilename } from "../../../lsp/language-mapping";
import { getServerDefinitionsForLanguage } from "../../../lsp/server-definitions";
import { fileUriToPath, pathToFileUri } from "../../../lsp/uri-utils";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import { isRecord, createWorkspaceGuardForFilePath } from "./shared";
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
  description: "Find references for a symbol at a source position using the language server.",
  inputSchema: LspFindReferencesInputSchema,
  traits: {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  },
  guards: [createWorkspaceGuardForFilePath()],
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    const includeDeclaration = input.includeDeclaration ?? true;
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

        const result = await client.sendRequest("textDocument/references", {
          textDocument: { uri },
          position: { line: input.line - 1, character: input.character },
          context: { includeDeclaration },
        });

        if (result === null) return "No references found.";

        const locations = parseReferenceLocations(result).sort(sortLocations);
        return formatReferences(locations);
      } finally {
        pool.release(poolKey);
      }
    } catch (error) {
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


