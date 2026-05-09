import type { AfterHook, ToolExecutionContext, ToolExecutionResult } from "../types";

export const REDACTION_MARKER = "[REDACTED:SECRET]";

const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|auth|authorization|bearer|client[_-]?secret|credential|pass(?:word)?|secret|token)/i;
const TOKEN_PATTERN = /\b(?:sk|pk|ghp|github_pat|xox[baprs]|AKIA|ASIA|SG)_[A-Za-z0-9_=-]{8,}\b|\b(?:sk|pk|ghp|github_pat|xox[baprs]|AKIA|ASIA|SG)-[A-Za-z0-9_=-]{8,}\b|\b[A-Za-z0-9+/]{32,}={0,2}\b/g;
const ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_-]*(?:api[_-]?key|auth|authorization|bearer|client[_-]?secret|credential|pass(?:word)?|secret|token)[A-Za-z0-9_-]*\s*[=:]\s*)([^\s&;,]+)/gi;

export function redactString(value: string): string {
  // First replace assignment patterns (key=value where key contains sensitive words)
  let result = value.replace(ASSIGNMENT_PATTERN, `$1${REDACTION_MARKER}`);
  // Then replace token patterns, but skip segments that look like file paths
  // (containing / which is rare in actual tokens but common in paths)
  result = result.replace(TOKEN_PATTERN, (match, offset) => {
    // If the match contains a / it's likely a file path segment, not a token
    if (match.includes("/")) return match;
    return REDACTION_MARKER;
  });
  return result;
}

export function redactValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") {
    return redactString(value) as T;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return REDACTION_MARKER as T;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen)) as T;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTION_MARKER
      : redactValue(item, seen);
  }

  return redacted as T;
}

export function createRedactionHook(): AfterHook {
  return async function redactionAfterHook(
    result: ToolExecutionResult,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    ctx.redactedInput = redactValue(ctx.redactedInput ?? ctx.input);

    return {
      output: redactString(result.output),
      isError: result.isError,
      meta: result.meta ? redactValue(result.meta) : result.meta,
    };
  };
}
