export type SensitiveTextRedactor = (text: string) => string;

export function redactSensitiveValue<T>(value: T, redact: SensitiveTextRedactor): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, redact)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [redact(key), redactSensitiveValue(nested, redact)]),
  ) as T;
}

/** Remove Provider-configured values while retaining only retry/classification metadata. */
export function sanitizeProviderError(
  error: unknown,
  redact: SensitiveTextRedactor,
): Error {
  const source = isRecord(error) ? error : undefined;
  const sanitized = new Error(redact(errorMessage(error)));
  sanitized.name = redact(error instanceof Error && error.name ? error.name : "ProviderError");

  copyNumberOrString(source, sanitized, "statusCode", redact);
  copyNumberOrString(source, sanitized, "status", redact);
  copyNumberOrString(source, sanitized, "code", redact);
  copyNumberOrString(source, sanitized, "retryAfter", redact);
  copyNumberOrString(source, sanitized, "retryAfterMs", redact);

  const retryAfter = retryAfterHeader(source?.headers);
  if (retryAfter !== undefined) {
    Object.defineProperty(sanitized, "headers", {
      configurable: false,
      enumerable: true,
      value: Object.freeze({ "retry-after": retryAfter }),
      writable: false,
    });
  }
  return sanitized;
}

function copyNumberOrString(
  source: Record<string, unknown> | undefined,
  target: Error,
  key: string,
  redact: SensitiveTextRedactor,
): void {
  const value = source?.[key];
  if (typeof value !== "number" && typeof value !== "string") return;
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: true,
    value: typeof value === "string" ? redact(value) : value,
    writable: false,
  });
}

function retryAfterHeader(value: unknown): string | number | undefined {
  if (!isRecord(value)) return undefined;
  const getter = typeof value.get === "function"
    ? (value.get as (name: string) => unknown).call(value, "retry-after")
    : undefined;
  for (const candidate of [value["retry-after"], value["Retry-After"], getter]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string") {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) return candidate;
      if (Number.isFinite(Date.parse(candidate))) return candidate;
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
