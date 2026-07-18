export const TOOL_OUTPUT_ERROR_CODES = [
  "TOOL_OUTPUT_FORBIDDEN",
  "TOOL_OUTPUT_NOT_FOUND",
  "TOOL_OUTPUT_EXPIRED",
  "TOOL_OUTPUT_EVICTED",
  "TOOL_OUTPUT_UNAVAILABLE",
  "TOOL_OUTPUT_INVALID_CURSOR",
  "TOOL_OUTPUT_INVALID_PATTERN",
  "TOOL_OUTPUT_SEARCH_TIMEOUT",
  "TOOL_OUTPUT_POLICY_VIOLATION",
] as const;

export type ToolOutputErrorCode = (typeof TOOL_OUTPUT_ERROR_CODES)[number];

const DEFAULT_MESSAGES: Readonly<Record<ToolOutputErrorCode, string>> = {
  TOOL_OUTPUT_FORBIDDEN: "Tool output is not available to this Session family",
  TOOL_OUTPUT_NOT_FOUND: "Tool output does not exist",
  TOOL_OUTPUT_EXPIRED: "Tool output has expired",
  TOOL_OUTPUT_EVICTED: "Tool output was evicted by retention limits",
  TOOL_OUTPUT_UNAVAILABLE: "Tool output is unavailable",
  TOOL_OUTPUT_INVALID_CURSOR: "Tool output cursor is invalid",
  TOOL_OUTPUT_INVALID_PATTERN: "Tool output search pattern is invalid",
  TOOL_OUTPUT_SEARCH_TIMEOUT: "Tool output search timed out",
  TOOL_OUTPUT_POLICY_VIOLATION: "Tool output violates the configured output policy",
};

export class ToolOutputError extends Error {
  readonly name = "ToolOutputError";

  constructor(
    public readonly code: ToolOutputErrorCode,
    message: string = DEFAULT_MESSAGES[code],
  ) {
    super(message);
  }

  toJSON(): { code: ToolOutputErrorCode; name: "ToolOutputError"; message: string } {
    return { code: this.code, name: this.name, message: this.message };
  }
}

export function isToolOutputError(error: unknown): error is ToolOutputError {
  return error instanceof ToolOutputError;
}
