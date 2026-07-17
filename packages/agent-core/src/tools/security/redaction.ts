import { ASSIGNMENT_PATTERN, SENSITIVE_KEY_PATTERN, TOKEN_PATTERN } from "../../security/patterns";

export const REDACTION_MARKER = "[REDACTED:SECRET]";

export function redactString(value: string): string {
  // First replace assignment patterns (key=value where key contains sensitive words)
  let result = value.replace(ASSIGNMENT_PATTERN, `$1${REDACTION_MARKER}`);
  // TOKEN_PATTERN is also the authoritative token detector. Every match must
  // be masked so a detector-positive value can never survive display redaction.
  result = result.replace(TOKEN_PATTERN, REDACTION_MARKER);
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
