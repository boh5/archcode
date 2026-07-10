import { handleFileDiagnostics } from "../builtins/lsp/lsp-diagnostics";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult, type FormattedToolError } from "../errors";
import { TOOL_LSP_DIAGNOSTICS } from "../names";
import { resolveAndValidatePath } from "../security";
import type { AfterHook, ToolExecutionContext, ToolExecutionResult } from "../types";

const POST_EDIT_DIAGNOSTICS_HEADER = "Post-edit diagnostics:";
const DEFAULT_INPUT_PATH_KEYS = ["path"] as const;
const MAX_DIAGNOSTIC_FILES = 10;

interface PostEditDiagnosticsHookOptions {
  inputPathKeys?: readonly string[];
  includeDiffPaths?: boolean;
}

export function createPostEditDiagnosticsHook(options: PostEditDiagnosticsHookOptions = {}): AfterHook {
  return async (result, ctx) => {
    if (result.isError || ctx.abort.aborted) return;
    if (!ctx.allowedTools.has(TOOL_LSP_DIAGNOSTICS)) return;

    const paths = collectCandidatePaths(result, ctx, options);
    if (paths.length === 0) return;

    const diagnostics: string[] = [];
    const unavailable: string[] = [];

    for (const path of paths.slice(0, MAX_DIAGNOSTIC_FILES)) {
      try {
        const { resolved } = resolveAndValidatePath(path, ctx.cwd);
        const diagnostic = await handleFileDiagnostics(resolved, path, "all", ctx);
        appendDiagnosticsEntry(diagnostics, unavailable, path, diagnostic, paths.length);
      } catch (error) {
        unavailable.push(`${path}: ${errorMessage(error)}`);
      }
    }

    const skipped = paths.length > MAX_DIAGNOSTIC_FILES
      ? paths.length - MAX_DIAGNOSTIC_FILES
      : 0;
    return appendPostEditDiagnostics(result, diagnostics, unavailable, skipped);
  };
}

function appendDiagnosticsEntry(
  diagnosticOutputs: string[],
  unavailable: string[],
  path: string,
  diagnosticResult: string | ToolExecutionResult,
  totalPaths: number,
): void {
  if (typeof diagnosticResult === "string") {
    if (isEmptyDiagnosticsOutput(diagnosticResult)) return;
    diagnosticOutputs.push(formatDiagnosticsEntry(path, diagnosticResult, totalPaths));
    return;
  }

  if (!diagnosticResult.isError) {
    if (isEmptyDiagnosticsOutput(diagnosticResult.output)) return;
    diagnosticOutputs.push(formatDiagnosticsEntry(path, diagnosticResult.output, totalPaths));
    return;
  }

  const kind = inferToolErrorKindFromResult(diagnosticResult);
  if (kind === "lsp-server-not-found") return;

  unavailable.push(`${path}: ${diagnosticErrorMessage(diagnosticResult)}`);
}

function appendPostEditDiagnostics(
  result: ToolExecutionResult,
  diagnostics: string[],
  unavailable: string[],
  skipped: number,
): ToolExecutionResult | undefined {
  if (diagnostics.length === 0 && unavailable.length === 0 && skipped === 0) return undefined;

  const sections: string[] = [];
  if (diagnostics.length > 0) {
    sections.push(`${POST_EDIT_DIAGNOSTICS_HEADER}\n${diagnostics.join("\n")}`);
  }
  if (unavailable.length > 0) {
    sections.push(`Post-edit diagnostics unavailable:\n${unavailable.join("\n")}`);
  }
  if (skipped > 0) {
    sections.push(`Post-edit diagnostics skipped ${skipped} additional file(s).`);
  }

  return {
    ...result,
    output: `${result.output}\n\n${sections.join("\n")}`,
    meta: {
      ...result.meta,
      postEditDiagnostics: {
        diagnostics,
        unavailable,
        skipped,
      },
    },
  };
}

function formatDiagnosticsEntry(path: string, diagnostics: string, totalPaths: number): string {
  if (totalPaths === 1) return diagnostics;
  return `${path}:\n${diagnostics}`;
}

function isEmptyDiagnosticsOutput(output: string): boolean {
  return output.trim() === "No diagnostics found.";
}

function collectCandidatePaths(
  result: ToolExecutionResult,
  ctx: ToolExecutionContext,
  options: PostEditDiagnosticsHookOptions,
): string[] {
  const paths: string[] = [];

  if (options.includeDiffPaths !== false) {
    paths.push(...diffPathsFromResult(result));
  }

  const inputPathKeys = options.inputPathKeys ?? DEFAULT_INPUT_PATH_KEYS;
  if (inputPathKeys.length > 0 && isRecord(ctx.input)) {
    for (const key of inputPathKeys) {
      const value = ctx.input[key];
      if (typeof value === "string") paths.push(value);
    }
  }

  return [...new Set(paths)];
}

function diffPathsFromResult(result: ToolExecutionResult): string[] {
  const diffs = result.meta?.diffs;
  if (!isRecord(diffs) || !Array.isArray(diffs.files)) return [];

  const paths: string[] = [];
  for (const file of diffs.files) {
    if (!isRecord(file) || typeof file.path !== "string") continue;
    if (file.status === "deleted") continue;
    paths.push(file.path);
  }

  return paths;
}

function diagnosticErrorMessage(result: ToolExecutionResult): string {
  const error = result.meta?.[TOOL_ERROR_META_KEY];
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  try {
    const parsed = JSON.parse(result.output) as Partial<FormattedToolError>;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Fall back to the raw tool output below.
  }

  return result.output;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
