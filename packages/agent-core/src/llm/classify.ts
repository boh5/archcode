export type LlmErrorKind =
  | "abort"
  | "auth"
  | "config"
  | "context-overflow"
  | "rate-limit"
  | "server"
  | "network"
  | "eof"
  | "sse-parse"
  | "unknown";

export interface LlmErrorClassification {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly statusCode?: number;
}

export type LlmErrorBoundary = "internal" | "provider-request";

export interface LlmErrorClassificationOptions {
  readonly boundary?: LlmErrorBoundary;
}

export function classifyLlmError(error: unknown, options: LlmErrorClassificationOptions = {}): LlmErrorClassification {
  const boundary = options.boundary ?? "internal";
  const statusCode = getStatusCode(error);
  const name = getErrorName(error).toLowerCase();
  const message = getErrorMessage(error).toLowerCase();

  if (name === "aborterror" || message.includes("aborted") || message.includes("aborterror")) {
    return { kind: "abort", retryable: false, statusCode };
  }

  if (statusCode === 401 || statusCode === 403 || includesAny(message, ["unauthorized", "forbidden", "api key", "apikey", "authentication", "auth"])) {
    return { kind: "auth", retryable: false, statusCode };
  }

  if (includesAny(message, ["context length", "context window", "maximum context", "token limit", "too many tokens", "context overflow"])) {
    return { kind: "context-overflow", retryable: false, statusCode };
  }

  if (includesAny(message, ["invalid model", "unknown model", "unsupported model", "invalid request", "configuration", "baseurl", "base url"])) {
    return { kind: "config", retryable: false, statusCode };
  }

  if (statusCode === 429 || message.includes("rate limit") || message.includes("too many requests")) {
    return { kind: "rate-limit", retryable: true, statusCode };
  }

  if (isNonRetryableClientStatus(statusCode)) {
    return { kind: "config", retryable: false, statusCode };
  }

  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return { kind: "server", retryable: true, statusCode };
  }

  if (includesAny(message, ["eof", "premature close", "socket closed", "connection closed"])) {
    return { kind: "eof", retryable: true, statusCode };
  }

  if (includesAny(message, ["sse", "eventsource", "event source", "parse error", "invalid event stream"])) {
    return { kind: "sse-parse", retryable: true, statusCode };
  }

  if (includesAny(message, ["network", "fetch failed", "timeout", "timed out", "econnreset", "etimedout", "enotfound", "eai_again", "socket hang up"])) {
    return { kind: "network", retryable: true, statusCode };
  }

  return { kind: "unknown", retryable: boundary === "provider-request", statusCode };
}

function isNonRetryableClientStatus(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return false;
  if (statusCode < 400 || statusCode > 499) return false;
  return statusCode !== 408 && statusCode !== 409 && statusCode !== 429;
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const candidates = [record.statusCode, record.status, record.code, record.response && typeof record.response === "object" ? (record.response as Record<string, unknown>).status : undefined];
  for (const candidate of candidates) {
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string" && /^\d+$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
