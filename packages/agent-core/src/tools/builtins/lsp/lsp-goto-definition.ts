import { LspGotoDefinitionInputSchema, type LspLocation, LspError, getLspClientPool, getLanguageIdFromFilename, getServerDefinitionsForLanguage, fileUriToPath, pathToFileUri } from "../../../lsp";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import { createWorkspacePermission } from "../../permission";
import { isRecord } from "./shared";
import { resolveAndValidatePath } from "../../security/path-validator";
import type { ToolExecutionResult } from "../../types";
import { formatDefinition } from "./format-output";

interface LspPosition {
  line?: unknown;
  character?: unknown;
}

interface LspRange {
  start?: unknown;
}

interface LspRawLocation {
  uri?: unknown;
  range?: unknown;
}

interface LspRawLocationLink {
  targetUri?: unknown;
  targetRange?: unknown;
}

export const lspGotoDefinitionTool = defineTool({
  name: "lsp_goto_definition",
  description: "Get definition location(s) for a symbol at a file position using the language server.",
  inputSchema: LspGotoDefinitionInputSchema,
  traits: {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  },
  permissions: [createWorkspacePermission({ pathKey: "filePath" })],
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    // Workspace access is enforced by createWorkspacePermission() guard.
    // Out-of-workspace paths may have been explicitly approved.
    const { resolved: resolvedPath } = resolveAndValidatePath(
      input.filePath,
      ctx.workspaceRoot,
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

        const result = await client.sendRequest("textDocument/definition", {
          textDocument: { uri },
          position: {
            line: input.line - 1,
            character: input.character,
          },
        });

        return formatDefinition(parseDefinitionResult(result));
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
        message: `LSP goto definition failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },
});

function parseDefinitionResult(result: unknown): LspLocation[] {
  if (result === null || result === undefined) return [];
  if (Array.isArray(result)) {
    return result
      .map((item) => locationFromUnknown(item))
      .filter((location): location is LspLocation => location !== undefined);
  }

  const location = locationFromUnknown(result);
  return location ? [location] : [];
}

function locationFromUnknown(value: unknown): LspLocation | undefined {
  if (!isRecord(value)) return undefined;

  const locationLink = value as LspRawLocationLink;
  if (typeof locationLink.targetUri === "string") {
    return locationFromUriAndRange(
      locationLink.targetUri,
      locationLink.targetRange,
    );
  }

  const location = value as LspRawLocation;
  if (typeof location.uri === "string") {
    return locationFromUriAndRange(
      location.uri,
      location.range,
    );
  }

  return undefined;
}

function locationFromUriAndRange(uri: string, range: unknown): LspLocation | undefined {
  if (!isRecord(range)) return undefined;
  const start = (range as LspRange).start;
  if (!isRecord(start)) return undefined;

  const position = start as LspPosition;
  if (typeof position.line !== "number" || typeof position.character !== "number") {
    return undefined;
  }

  return {
    filePath: fileUriToPath(uri),
    line: position.line + 1,
    column: position.character + 1,
  };
}


