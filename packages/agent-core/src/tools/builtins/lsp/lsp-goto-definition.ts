import { LspGotoDefinitionInputSchema, type LspLocation, LspError, getLspClientPool, getLanguageIdFromFilename, getServerDefinitionsForLanguage, fileUriToPath, pathToFileUri } from "../../../lsp";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import { createWorkspacePermission } from "../../permission";
import { isRecord } from "./shared";
import { getLspToolLogger } from "./tool-logger";
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
  description: "Resolve a symbol at a known source position to its definition location(s). Use lsp_symbols to discover semantic symbols when the position is unknown, then use file_read on the returned definition. Requires a language mapping and an available language server for the source file; otherwise the call returns an error.",
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

        const result = await client.sendRequest("textDocument/definition", {
          textDocument: { uri },
          position: {
            line: input.line - 1,
            character: input.character,
          },
        });

        return formatDefinition(parseDefinitionResult(result));
      } finally {
        documentHandle?.release();
        pool.release(poolKey);
      }
    } catch (error) {
      if (error instanceof LspError) {
        getLspToolLogger().warn("lsp.goto-definition.error", {
          module: "lsp.goto-definition",
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

      getLspToolLogger().error("lsp.goto-definition.failed", {
        module: "lsp.goto-definition",
        error,
      });
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
