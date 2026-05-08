import type { ZodError } from "zod";
import type { ToolExecutionResult } from "./types";
import { redactString, redactValue } from "./hooks/redact";

export const TOOL_ERROR_META_KEY = "toolError";

export type ToolErrorKind =
  | "unknown-tool"
  | "prepare-input"
  | "schema"
  | "before-hook-schema"
  | "not-allowed"
  | "permission-denied"
  | "permission-confirmation-denied"
  | "permission-confirmation-timeout"
  | "permission-confirmation-unavailable"
  | "permission-confirmation-failed"
  | "execution"
  | "after-hook"
  | "bash-nonzero"
  | "bash-timeout"
  | "bash-aborted"
  | "cancelled"
  | "read-before-write"
  | "write-conflict"
  | "workspace"
  | "edit-no-match"
  | "edit-ambiguous"
  | "edit-overlap";

export interface FormattedToolError {
  name?: string;
  code?: string;
  message: string;
  details?: unknown;
  hint: string;
}

export interface FormatToolErrorOptions {
  error?: unknown;
  kind?: ToolErrorKind;
  code?: string;
  name?: string;
  message?: string;
  details?: unknown;
  hint?: string;
  zodError?: ZodError;
  expectedInput?: string;
  meta?: Record<string, unknown>;
}

const CODE_PATTERN = /\[(TOOL_[A-Z0-9_]+|PATH_[A-Z0-9_]+)\]/g;

const HINTS: Record<ToolErrorKind, string> = {
  "unknown-tool": "Use only tools currently registered and available in this execution context.",
  "prepare-input": "Check the tool input shape and retry with valid, non-secret-bearing arguments.",
  schema: "Retry with input matching the tool schema; remove unknown fields and use the required value types.",
  "before-hook-schema": "Retry with input matching the tool schema after hook normalization; remove unknown fields and use the required value types.",
  "not-allowed": "Choose an allowed tool for this agent run or ask the user to enable the required tool.",
  "permission-denied": "Do not retry the same call unchanged; choose a safer tool/input or ask the user for a permitted action.",
  "permission-confirmation-denied": "The user denied confirmation; do not repeat this action unless the user changes their decision.",
  "permission-confirmation-timeout": "Confirmation timed out; ask the user before retrying this action.",
  "permission-confirmation-unavailable": "Interactive confirmation is unavailable; use a non-sensitive alternative or ask the user to run it manually.",
  "permission-confirmation-failed": "Confirmation handling failed; ask the user for guidance before retrying.",
  execution: "Inspect the safe error details, adjust the tool input, then retry only if the action is still necessary.",
  "after-hook": "Tool post-processing failed; inspect the safe details and retry only if the underlying action is still needed.",
  "bash-nonzero": "The command exited nonzero; inspect stdout, stderr, and exitCode, then fix the command or environment before retrying.",
  "bash-timeout": "The command timed out; retry with a shorter command, increase timeoutMs, or break the work into smaller steps.",
  "bash-aborted": "The command was aborted or cancelled; stop the action unless the user explicitly asks to retry.",
  cancelled: "The operation was cancelled; stop or ask the user whether to retry.",
  "read-before-write": "Read the target file first with file_read, then retry the write/edit with current content.",
  "write-conflict": "Re-read the file to refresh the snapshot before retrying the edit or write.",
  workspace: "Use a path inside the workspace and avoid symlink or parent-directory escapes.",
  "edit-no-match": "Re-read the file and retry with an oldString that exactly matches the current content.",
  "edit-ambiguous": "Retry with more surrounding context so oldString matches exactly one location.",
  "edit-overlap": "Split or adjust edits so each oldString targets a non-overlapping section.",
};

export function formatToolError(options: FormatToolErrorOptions): FormattedToolError {
  const message = redactString(resolveMessage(options));
  const code = redactString(options.code ?? extractCode(message) ?? codeFromKind(options.kind) ?? "TOOL_EXECUTION_FAILED");
  const rawName = options.name ?? (options.error !== undefined ? safeErrorName(options.error) : undefined);
  const name = rawName ? redactString(rawName) : undefined;
  const hint = redactString(options.hint ?? resolveHint(options, message, code));
  const details = resolveDetails(options);

  return {
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
    message,
    ...(details !== undefined ? { details: redactValue(details) } : {}),
    hint,
  };
}

export function createToolErrorResult(
  options: FormatToolErrorOptions,
): ToolExecutionResult {
  const formatted = formatToolError(options);

  return {
    output: serializeToolError(formatted),
    isError: true,
    meta: redactValue({
      ...options.meta,
      [TOOL_ERROR_META_KEY]: formatted,
    }),
  };
}

export function serializeToolError(error: FormattedToolError): string {
  return JSON.stringify(error);
}

export function normalizeToolErrorResult(
  result: ToolExecutionResult,
  defaults: FormatToolErrorOptions = {},
): ToolExecutionResult {
  if (!result.isError || isStructuredToolError(result)) {
    return result;
  }

  return createToolErrorResult({
    ...defaults,
    message: result.output,
    details: result.meta,
    meta: result.meta,
  });
}

export function isStructuredToolError(result: ToolExecutionResult): boolean {
  if (result.meta?.[TOOL_ERROR_META_KEY]) return true;

  try {
    const parsed = JSON.parse(result.output) as Partial<FormattedToolError>;
    return typeof parsed === "object" && parsed !== null && typeof parsed.message === "string" && typeof parsed.hint === "string";
  } catch {
    return false;
  }
}

export function inferToolErrorKindFromResult(
  result: ToolExecutionResult,
): ToolErrorKind | undefined {
  const output = result.output;
  const permissionCode = result.meta?.permissionErrorCode;
  if (typeof permissionCode === "string") {
    return kindFromCode(permissionCode) ?? "permission-denied";
  }

  if (result.meta?.timedOut === true) return "bash-timeout";
  if (result.meta?.aborted === true) return "bash-aborted";
  if (typeof result.meta?.exitCode === "number" && result.meta.exitCode !== 0) return "bash-nonzero";

  const code = extractCode(output);
  const byCode = code ? kindFromCode(code) : undefined;
  if (byCode) return byCode;

  if (/timed out/i.test(output)) return "bash-timeout";
  if (/\baborted\b|\bcancelled\b|\bcanceled\b/i.test(output)) return "bash-aborted";

  return undefined;
}

export function extractCode(message: string): string | undefined {
  CODE_PATTERN.lastIndex = 0;
  return CODE_PATTERN.exec(message)?.[1];
}

function resolveMessage(options: FormatToolErrorOptions): string {
  if (options.message !== undefined) return options.message;
  if (options.zodError) return options.zodError.message;
  if (options.error instanceof Error) return options.error.message;
  if (options.error !== undefined) return String(options.error);
  return "Tool execution failed";
}

function resolveDetails(options: FormatToolErrorOptions): unknown {
  if (options.details !== undefined) return options.details;
  if (options.zodError) {
    return {
      issues: options.zodError.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
      ...(options.expectedInput ? { expectedInput: options.expectedInput } : {}),
    };
  }

  if (options.error instanceof Error && options.error.cause !== undefined) {
    return { cause: String(options.error.cause) };
  }

  return undefined;
}

function safeErrorName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return "NonErrorThrow";
  return error.name && error.name !== "Error" ? error.name : undefined;
}

function resolveHint(
  options: FormatToolErrorOptions,
  message: string,
  code: string,
): string {
  if (options.kind && HINTS[options.kind]) return HINTS[options.kind];

  const kind = kindFromCode(code) ?? kindFromMessage(message);
  if (kind) return HINTS[kind];

  return HINTS.execution;
}

function kindFromMessage(message: string): ToolErrorKind | undefined {
  if (/oldString.*not found|no match/i.test(message)) return "edit-no-match";
  if (/multiple matches|ambiguous/i.test(message)) return "edit-ambiguous";
  if (/overlapping edits/i.test(message)) return "edit-overlap";
  if (/not been read first/i.test(message)) return "read-before-write";
  if (/modified since it was read|write conflict/i.test(message)) return "write-conflict";
  if (/outside workspace/i.test(message)) return "workspace";
  return undefined;
}

function kindFromCode(code: string): ToolErrorKind | undefined {
  switch (code) {
    case "TOOL_BASH_NONZERO_EXIT":
      return "bash-nonzero";
    case "TOOL_BASH_TIMEOUT":
      return "bash-timeout";
    case "TOOL_BASH_ABORTED":
      return "bash-aborted";
    case "TOOL_UNKNOWN":
      return "unknown-tool";
    case "TOOL_PREPARE_INPUT_FAILED":
      return "prepare-input";
    case "TOOL_NOT_ALLOWED":
      return "not-allowed";
    case "TOOL_PERMISSION_DENIED":
      return "permission-denied";
    case "TOOL_PERMISSION_CONFIRMATION_DENIED":
      return "permission-confirmation-denied";
    case "TOOL_PERMISSION_CONFIRMATION_TIMEOUT":
      return "permission-confirmation-timeout";
    case "TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE":
      return "permission-confirmation-unavailable";
    case "TOOL_PERMISSION_CONFIRMATION_FAILED":
      return "permission-confirmation-failed";
    case "TOOL_FILE_NOT_READ_FIRST":
      return "read-before-write";
    case "TOOL_FILE_WRITE_CONFLICT":
      return "write-conflict";
    case "TOOL_FILE_OUTSIDE_WORKSPACE":
    case "PATH_OUTSIDE_WORKSPACE":
      return "workspace";
    case "TOOL_EDIT_NO_MATCH":
      return "edit-no-match";
    case "TOOL_EDIT_AMBIGUOUS_MATCH":
      return "edit-ambiguous";
    case "TOOL_EDIT_OVERLAP":
      return "edit-overlap";
    default:
      return undefined;
  }
}

function codeFromKind(kind: ToolErrorKind | undefined): string | undefined {
  switch (kind) {
    case "schema":
      return "TOOL_SCHEMA_INVALID_INPUT";
    case "before-hook-schema":
      return "TOOL_BEFORE_HOOK_INVALID_INPUT";
    case "execution":
      return "TOOL_EXECUTION_FAILED";
    case "after-hook":
      return "TOOL_AFTER_HOOK_FAILED";
    case "bash-nonzero":
      return "TOOL_BASH_NONZERO_EXIT";
    case "bash-timeout":
      return "TOOL_BASH_TIMEOUT";
    case "bash-aborted":
      return "TOOL_BASH_ABORTED";
    case "cancelled":
      return "TOOL_CANCELLED";
    default:
      return undefined;
  }
}
