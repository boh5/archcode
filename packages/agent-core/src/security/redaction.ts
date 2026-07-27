export const REDACTION_MARKER = "[REDACTED:SECRET]";

export const SECRET_LITERAL_MIN_BYTES = 8;
export const SECRET_LITERAL_MAX_BYTES = 16 * 1024;
export const SECRET_LITERAL_MAX_COUNT = 256;
export const SECRET_LITERAL_MAX_TOTAL_BYTES = 64 * 1024;
const CIRCULAR_VALUE_MARKER = "[OMITTED:CIRCULAR]";

export class SecretLiteralPolicyError extends Error {
  readonly code = "SECRET_LITERAL_POLICY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SecretLiteralPolicyError";
  }
}

/** Runtime-scoped immutable policy for replacing explicitly configured secret values. */
export class SecretRedactionPolicy {
  readonly #literals: readonly string[];

  constructor(values: Iterable<string>) {
    const unique = [...new Set(values)];
    if (unique.length > SECRET_LITERAL_MAX_COUNT) {
      throw new SecretLiteralPolicyError(`At most ${SECRET_LITERAL_MAX_COUNT} secret literals are allowed`);
    }

    let totalBytes = 0;
    for (const value of unique) {
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes < SECRET_LITERAL_MIN_BYTES || bytes > SECRET_LITERAL_MAX_BYTES) {
        throw new SecretLiteralPolicyError(
          `Secret literals must contain ${SECRET_LITERAL_MIN_BYTES} to ${SECRET_LITERAL_MAX_BYTES} UTF-8 bytes`,
        );
      }
      totalBytes += bytes;
    }
    if (totalBytes > SECRET_LITERAL_MAX_TOTAL_BYTES) {
      throw new SecretLiteralPolicyError(
        `Secret literals exceed the ${SECRET_LITERAL_MAX_TOTAL_BYTES}-byte aggregate limit`,
      );
    }

    this.#literals = unique.sort((left, right) => right.length - left.length);
  }

  redactString(value: string): string {
    let result = value;
    for (const literal of this.#literals) {
      result = result.replaceAll(literal, REDACTION_MARKER);
    }
    return result;
  }

  redactValue<T>(value: T, seen = new WeakSet<object>()): T {
    if (typeof value === "string") return this.redactString(value) as T;
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return CIRCULAR_VALUE_MARKER as T;
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, seen)) as T;
    }
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[this.redactString(key)] = this.redactValue(item, seen);
    }
    return redacted as T;
  }
}
