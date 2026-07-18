import type { ZodError } from "zod";
import type { RawToolResult } from "./types";
import { redactString } from "../security";
import { createTextToolResult } from "./results";
import { decodeUtf8, safeUtf8End, utf8ByteLength } from "../tool-output/utf8";

export const TOOL_ERROR_MESSAGE_MAX_BYTES = 32 * 1024;
export const TOOL_ERROR_HINT_MAX_BYTES = 2 * 1024;
export const TOOL_ERROR_IDENTIFIER_MAX_BYTES = 128;

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
  | "edit-overlap"
  | "file-not-found"
  | "file-permission-denied"
  | "file-already-exists"
  | "file-too-large"
  | "edit-identical"
  | "grep-error"
  | "glob-error"
  | "binary-not-found"
  | "binary-download-failed"
  | "binary-checksum-mismatch"
  | "binary-install-failed"
  | "binary-unsupported-platform"
  | "binary-validation-failed"
  | "ast-grep-error"
  | "todo-validation"
  | "lsp-error"
  | "lsp-timeout"
  | "lsp-server-not-found"
  | "webfetch-invalid-url"
  | "webfetch-timeout"
  | "webfetch-http-error"
  | "webfetch-size-exceeded"
  | "webfetch-content-type-unsupported";

export interface FormattedToolError {
  name: string;
  kind: ToolErrorKind;
  code: string;
  message: string;
  hint: string;
}

export interface FormatToolErrorOptions {
  error?: unknown;
  kind?: ToolErrorKind;
  code?: string;
  name?: string;
  message?: string;
  hint?: string;
  zodError?: ZodError;
  expectedInput?: string;
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
  "file-not-found": "The file does not exist; check the path and create the file first if needed.",
  "file-permission-denied": "Permission denied; check file permissions or use a different path.",
  "file-already-exists": "The file already exists; use file_edit to modify it instead of file_write.",
  "file-too-large": "The file is too large to read; use offset and limit to read in chunks.",
  "edit-identical": "oldString and newString are identical; provide a meaningful change.",
  "grep-error": "The search command failed; check the pattern and try again.",
  "glob-error": "The file listing command failed; check the pattern and try again.",
  "binary-not-found": "Install the required binary, ensure it is on PATH, or let ArchCode install it into the binary cache.",
  "binary-download-failed": "Check network access to the binary release URL and retry later.",
  "binary-checksum-mismatch": "Do not use this download; retry later or verify the pinned binary manifest before proceeding.",
  "binary-install-failed": "Check cache directory permissions and available disk space, then retry.",
  "binary-unsupported-platform": "Use a supported macOS or Linux arm64/x64 environment, or install the binary manually on PATH.",
  "binary-validation-failed": "The binary found on PATH did not pass validation. Remove the broken binary or install the correct version manually.",
  "ast-grep-error": "The ast-grep command failed; inspect stderr, pattern, language, and file globs before retrying.",
  "todo-validation": "Invalid todo input; check for duplicate IDs or multiple in_progress items.",
  "lsp-error": "The LSP operation failed; check the server status and retry.",
  "lsp-timeout": "The LSP operation timed out; retry or check if the language server is responsive.",
  "lsp-server-not-found": "No language server is available for this file type; ensure a compatible server is configured.",
  "webfetch-invalid-url": "The URL is invalid; ensure it starts with http:// or https:// and contains no credentials.",
  "webfetch-timeout": "The request timed out; try again with a longer timeout or a different URL.",
  "webfetch-http-error": "The server returned an error status; check the URL and try again.",
  "webfetch-size-exceeded": "The response body exceeds the 5 MiB transport safety limit; try a different URL or a narrower resource.",
  "webfetch-content-type-unsupported": "The content type is not supported; only HTML, JSON, and plain text can be fetched.",
};

export function formatToolError(options: FormatToolErrorOptions): FormattedToolError {
  const redactedMessage = redactString(resolveMessage(options));
  const message = boundUtf8(redactedMessage, TOOL_ERROR_MESSAGE_MAX_BYTES);
  const rawCode = options.code ?? extractCode(redactedMessage) ?? codeFromKind(options.kind) ?? "TOOL_EXECUTION_FAILED";
  const kind = options.kind ?? kindFromCode(rawCode) ?? kindFromMessage(message) ?? "execution";
  const code = boundUtf8(redactString(rawCode), TOOL_ERROR_IDENTIFIER_MAX_BYTES);
  const rawName = options.name ?? (options.error !== undefined ? safeErrorName(options.error) : undefined) ?? "ToolError";
  const name = boundUtf8(redactString(rawName), TOOL_ERROR_IDENTIFIER_MAX_BYTES);
  const hint = boundUtf8(
    redactString(options.hint ?? resolveHint(options, message, code)),
    TOOL_ERROR_HINT_MAX_BYTES,
  );

  return {
    name,
    kind,
    code,
    message,
    hint,
  };
}

export function createToolErrorResult(
  options: FormatToolErrorOptions,
): RawToolResult {
  const formatted = formatToolError(options);
  return createTextToolResult(serializeToolError(formatted), {
    isError: true,
    details: {
      error: {
        kind: formatted.kind,
        code: formatted.code,
        name: formatted.name,
        hint: formatted.hint,
      },
    },
  });
}

export function serializeToolError(error: FormattedToolError): string {
  return JSON.stringify(error);
}

export function normalizeToolErrorResult(
  result: RawToolResult,
  defaults: FormatToolErrorOptions = {},
): RawToolResult {
  if (!result.isError || isStructuredToolError(result)) {
    return result;
  }

  return createToolErrorResult({
    ...defaults,
    message: draftText(result),
  });
}

export function isStructuredToolError(result: RawToolResult): boolean {
  if (result.details?.error) return true;

  try {
    const parsed = JSON.parse(draftText(result)) as Partial<FormattedToolError>;
    return typeof parsed === "object" && parsed !== null && typeof parsed.message === "string" && typeof parsed.hint === "string";
  } catch {
    return false;
  }
}

export function inferToolErrorKindFromResult(
  result: RawToolResult,
): ToolErrorKind | undefined {
  const output = draftText(result);
  const toolError = result.details?.error;
  if (toolError?.kind) return toolError.kind as ToolErrorKind;
  if (toolError?.code) return kindFromCode(toolError.code);
  if (result.details?.process?.timedOut) return "bash-timeout";
  if (result.details?.process?.aborted) return "bash-aborted";
  if (typeof result.details?.process?.exitCode === "number" && result.details.process.exitCode !== 0) return "bash-nonzero";

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

function safeErrorName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return "NonErrorThrow";
  return error.name && error.name !== "Error" ? error.name : undefined;
}

function boundUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  const bytes = new TextEncoder().encode(value);
  return decodeUtf8(bytes.subarray(0, safeUtf8End(bytes, maxBytes)));
}

function draftText(result: RawToolResult): string {
  return result.draft.kind === "text" ? result.draft.text : "Tool execution failed";
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
  if (/file not found/i.test(message)) return "file-not-found";
  if (/permission denied/i.test(message)) return "file-permission-denied";
  if (/already exists/i.test(message)) return "file-already-exists";
  if (/too large/i.test(message)) return "file-too-large";
  if (/identical/i.test(message)) return "edit-identical";
  if (/oldString.*not found|no match/i.test(message)) return "edit-no-match";
  if (/multiple matches|ambiguous/i.test(message)) return "edit-ambiguous";
  if (/overlapping edits/i.test(message)) return "edit-overlap";
  if (/not been read first/i.test(message)) return "read-before-write";
  if (/modified since it was read|write conflict/i.test(message)) return "write-conflict";
  if (/outside workspace/i.test(message)) return "workspace";
  if (/invalid url/i.test(message)) return "webfetch-invalid-url";
  if (/timed out|timeout/i.test(message) && /fetch|request|url/i.test(message)) return "webfetch-timeout";
  if (/http error|status \d{3}/i.test(message)) return "webfetch-http-error";
  if (/size exceeded|too large/i.test(message) && /fetch|response|body/i.test(message)) return "webfetch-size-exceeded";
  if (/content.type unsupported|unsupported content/i.test(message)) return "webfetch-content-type-unsupported";
  return undefined;
}

export function kindFromCode(code: string): ToolErrorKind | undefined {
  switch (code) {
    case "TOOL_UNKNOWN":
      return "unknown-tool";
    case "TOOL_PREPARE_INPUT_FAILED":
      return "prepare-input";
    case "TOOL_INPUT_SCHEMA_INVALID":
    case "TOOL_SCHEMA_INVALID_INPUT":
      return "schema";
    case "TOOL_BEFORE_HOOK_SCHEMA_INVALID":
    case "TOOL_BEFORE_HOOK_INVALID_INPUT":
      return "before-hook-schema";
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
    case "TOOL_EXECUTION_FAILED":
      return "execution";
    case "TOOL_AFTER_HOOK_FAILED":
      return "after-hook";
    case "TOOL_BASH_NONZERO_EXIT":
      return "bash-nonzero";
    case "TOOL_BASH_TIMEOUT":
      return "bash-timeout";
    case "TOOL_BASH_ABORTED":
      return "bash-aborted";
    case "TOOL_CANCELLED":
      return "cancelled";
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
    case "TOOL_FILE_NOT_FOUND":
      return "file-not-found";
    case "TOOL_FILE_PERMISSION_DENIED":
      return "file-permission-denied";
    case "TOOL_FILE_ALREADY_EXISTS":
      return "file-already-exists";
    case "TOOL_FILE_TOO_LARGE":
      return "file-too-large";
    case "TOOL_EDIT_IDENTICAL":
      return "edit-identical";
    case "TOOL_GREP_ERROR":
      return "grep-error";
    case "TOOL_GLOB_ERROR":
      return "glob-error";
    case "TOOL_BINARY_NOT_FOUND":
      return "binary-not-found";
    case "TOOL_BINARY_DOWNLOAD_FAILED":
      return "binary-download-failed";
    case "TOOL_BINARY_CHECKSUM_MISMATCH":
      return "binary-checksum-mismatch";
    case "TOOL_BINARY_INSTALL_FAILED":
      return "binary-install-failed";
    case "TOOL_BINARY_UNSUPPORTED_PLATFORM":
      return "binary-unsupported-platform";
    case "TOOL_BINARY_VALIDATION_FAILED":
      return "binary-validation-failed";
    case "TOOL_AST_GREP_ERROR":
      return "ast-grep-error";
    case "TOOL_TODO_VALIDATION":
      return "todo-validation";
    case "TOOL_LSP_ERROR":
      return "lsp-error";
    case "TOOL_LSP_TIMEOUT":
      return "lsp-timeout";
    case "TOOL_LSP_SERVER_NOT_FOUND":
      return "lsp-server-not-found";
    case "TOOL_WEBFETCH_INVALID_URL":
      return "webfetch-invalid-url";
    case "TOOL_WEBFETCH_TIMEOUT":
      return "webfetch-timeout";
    case "TOOL_WEBFETCH_HTTP_ERROR":
      return "webfetch-http-error";
    case "TOOL_WEBFETCH_SIZE_EXCEEDED":
      return "webfetch-size-exceeded";
    case "TOOL_WEBFETCH_CONTENT_TYPE_UNSUPPORTED":
      return "webfetch-content-type-unsupported";
    default:
      return undefined;
  }
}

export function codeFromKind(kind: ToolErrorKind | undefined): string | undefined {
  switch (kind) {
    case "unknown-tool":
      return "TOOL_UNKNOWN";
    case "prepare-input":
      return "TOOL_PREPARE_INPUT_FAILED";
    case "schema":
      return "TOOL_SCHEMA_INVALID_INPUT";
    case "before-hook-schema":
      return "TOOL_BEFORE_HOOK_INVALID_INPUT";
    case "not-allowed":
      return "TOOL_NOT_ALLOWED";
    case "permission-denied":
      return "TOOL_PERMISSION_DENIED";
    case "permission-confirmation-denied":
      return "TOOL_PERMISSION_CONFIRMATION_DENIED";
    case "permission-confirmation-timeout":
      return "TOOL_PERMISSION_CONFIRMATION_TIMEOUT";
    case "permission-confirmation-unavailable":
      return "TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE";
    case "permission-confirmation-failed":
      return "TOOL_PERMISSION_CONFIRMATION_FAILED";
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
    case "read-before-write":
      return "TOOL_FILE_NOT_READ_FIRST";
    case "write-conflict":
      return "TOOL_FILE_WRITE_CONFLICT";
    case "workspace":
      return "TOOL_FILE_OUTSIDE_WORKSPACE";
    case "edit-no-match":
      return "TOOL_EDIT_NO_MATCH";
    case "edit-ambiguous":
      return "TOOL_EDIT_AMBIGUOUS_MATCH";
    case "edit-overlap":
      return "TOOL_EDIT_OVERLAP";
    case "file-not-found":
      return "TOOL_FILE_NOT_FOUND";
    case "file-permission-denied":
      return "TOOL_FILE_PERMISSION_DENIED";
    case "file-already-exists":
      return "TOOL_FILE_ALREADY_EXISTS";
    case "file-too-large":
      return "TOOL_FILE_TOO_LARGE";
    case "edit-identical":
      return "TOOL_EDIT_IDENTICAL";
    case "grep-error":
      return "TOOL_GREP_ERROR";
    case "glob-error":
      return "TOOL_GLOB_ERROR";
    case "binary-not-found":
      return "TOOL_BINARY_NOT_FOUND";
    case "binary-download-failed":
      return "TOOL_BINARY_DOWNLOAD_FAILED";
    case "binary-checksum-mismatch":
      return "TOOL_BINARY_CHECKSUM_MISMATCH";
    case "binary-install-failed":
      return "TOOL_BINARY_INSTALL_FAILED";
    case "binary-unsupported-platform":
      return "TOOL_BINARY_UNSUPPORTED_PLATFORM";
    case "binary-validation-failed":
      return "TOOL_BINARY_VALIDATION_FAILED";
    case "ast-grep-error":
      return "TOOL_AST_GREP_ERROR";
    case "todo-validation":
      return "TOOL_TODO_VALIDATION";
    case "lsp-error":
      return "TOOL_LSP_ERROR";
    case "lsp-timeout":
      return "TOOL_LSP_TIMEOUT";
    case "lsp-server-not-found":
      return "TOOL_LSP_SERVER_NOT_FOUND";
    case "webfetch-invalid-url":
      return "TOOL_WEBFETCH_INVALID_URL";
    case "webfetch-timeout":
      return "TOOL_WEBFETCH_TIMEOUT";
    case "webfetch-http-error":
      return "TOOL_WEBFETCH_HTTP_ERROR";
    case "webfetch-size-exceeded":
      return "TOOL_WEBFETCH_SIZE_EXCEEDED";
    case "webfetch-content-type-unsupported":
      return "TOOL_WEBFETCH_CONTENT_TYPE_UNSUPPORTED";
    default:
      return undefined;
  }
}
