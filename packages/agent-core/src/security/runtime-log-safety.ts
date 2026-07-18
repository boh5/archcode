import type { LogFields, Logger } from "../logger";
import { REDACTION_MARKER, SecretRedactionPolicy } from "./redaction";
import { SENSITIVE_KEY_PATTERN } from "./patterns";

const LOG_VALUE_MAX_BYTES = 1024;
const LOG_MAX_DEPTH = 4;
const LOG_MAX_ITEMS = 32;
const LOG_OMITTED_MARKER = "[OMITTED]";
const LOG_PATH_OR_URL_KEY_PATTERN = /(?:artifact|cwd|header|path|root|uri|url|workspace)/i;
const URL_PATTERN = /\b(?:https?|file):\/\/[^\s"'`<>]+/gi;
const ABSOLUTE_PATH_PATTERN = /(^|[\s"'`(=,:])\/(?:[^\s"'`<>{}\],:;()]+\/)+[^\s"'`<>{}\],:;()]+/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\(?:[^\s"'`<>{}\],:;()]+\\)*[^\s"'`<>{}\],:;()]+/g;

/**
 * Runtime-only logger boundary. Every Runtime-owned logger must pass through
 * this wrapper before it reaches its configured sink.
 *
 * Tool/UI redaction intentionally preserves ordinary absolute paths. Runtime
 * logs have a narrower threat model: they never retain local paths, URLs,
 * headers, raw exception values, or stacks.
 */
export function createRuntimeLogSafetyBoundary(logger: Logger, policy: SecretRedactionPolicy): Logger {
  const emit = (level: "debug" | "info" | "warn" | "error", event: string, fields?: LogFields): void => {
    try {
      logger[level](sanitizeText(event, policy), sanitizeFields(fields, policy));
    } catch {
      // Logging is strictly observational and must never affect runtime work.
    }
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (contextOrModule) => {
      try {
        const safeChild = typeof contextOrModule === "string"
          ? sanitizeText(contextOrModule, policy)
          : {
            ...(contextOrModule.module ? { module: sanitizeText(contextOrModule.module, policy) } : {}),
            ...(contextOrModule.context ? { context: sanitizeRecord(contextOrModule.context, policy) } : {}),
          };
        return createRuntimeLogSafetyBoundary(logger.child(safeChild), policy);
      } catch {
        return createRuntimeLogSafetyBoundary(noopLogger, policy);
      }
    },
  };
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

function sanitizeFields(fields: LogFields | undefined, policy: SecretRedactionPolicy): LogFields | undefined {
  if (!fields) return undefined;

  try {
    const meta = sanitizeRecord(fields.meta, policy);
    const error = "error" in fields ? summarizeError(fields.error, policy) : undefined;
    return {
      ...(fields.module ? { module: sanitizeText(fields.module, policy) } : {}),
      ...(fields.message ? { message: sanitizeText(fields.message, policy) } : {}),
      ...(fields.context ? { context: sanitizeRecord(fields.context, policy) } : {}),
      ...((meta || error) ? { meta: { ...(meta ?? {}), ...(error ? { error } : {}) } } : {}),
    };
  } catch {
    return { meta: { code: "RUNTIME_LOG_FIELDS_UNAVAILABLE" } };
  }
}

function summarizeError(error: unknown, policy: SecretRedactionPolicy): Record<string, string> {
  const value = asRecord(error);
  const name = error instanceof Error
    ? error.name || "Error"
    : typeof value?.name === "string"
      ? value.name
      : "NonError";
  const code = typeof value?.code === "string" || typeof value?.code === "number"
    ? String(value.code)
    : "RUNTIME_LOG_FAILURE";
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Runtime operation failed";

  return {
    name: sanitizeText(name, policy),
    code: sanitizeText(code, policy),
    message: sanitizeText(message || "Runtime operation failed", policy),
  };
}

function sanitizeRecord(value: Record<string, unknown> | undefined, policy: SecretRedactionPolicy): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const result: Record<string, unknown> = {};
  let count = 0;
  for (const [key, nested] of Object.entries(value)) {
    if (count >= LOG_MAX_ITEMS) {
      result.omitted = LOG_OMITTED_MARKER;
      break;
    }
    count += 1;
    result[sanitizeText(key, policy)] = isProtectedLogKey(key)
      ? REDACTION_MARKER
      : sanitizeValue(nested, policy, 0, new WeakSet<object>());
  }
  return result;
}

function sanitizeValue(value: unknown, policy: SecretRedactionPolicy, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return sanitizeText(value, policy);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= LOG_MAX_DEPTH || seen.has(value)) return LOG_OMITTED_MARKER;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, LOG_MAX_ITEMS).map((item) => sanitizeValue(item, policy, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  let count = 0;
  for (const [key, nested] of Object.entries(value)) {
    if (count >= LOG_MAX_ITEMS) {
      result.omitted = LOG_OMITTED_MARKER;
      break;
    }
    count += 1;
    result[sanitizeText(key, policy)] = isProtectedLogKey(key)
      ? REDACTION_MARKER
      : sanitizeValue(nested, policy, depth + 1, seen);
  }
  return result;
}

function isProtectedLogKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || LOG_PATH_OR_URL_KEY_PATTERN.test(key) || /stack/i.test(key);
}

function sanitizeText(value: string, policy: SecretRedactionPolicy): string {
  const redacted = policy.redactString(value)
    .replace(URL_PATTERN, REDACTION_MARKER)
    .replace(ABSOLUTE_PATH_PATTERN, (_match, prefix: string) => `${prefix}${REDACTION_MARKER}`)
    .replace(WINDOWS_PATH_PATTERN, REDACTION_MARKER);
  return truncateUtf8(redacted, LOG_VALUE_MAX_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return `${value.slice(0, end)}${LOG_OMITTED_MARKER}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}
