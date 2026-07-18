export const PROVIDER_SECRET_REDACTION_MARKER = "[REDACTED_PROVIDER_SECRET]";

export interface StreamingSensitiveTextRedactor {
  push(text: string): string;
  flush(): string;
}

/** Immutable value-level redactor for secrets already accepted into one Provider config. */
export class SensitiveValueRedactor {
  readonly #patterns: readonly string[];

  constructor(values: readonly string[]) {
    const patterns = new Set<string>();
    for (const value of values) {
      if (value.length === 0) continue;
      patterns.add(value);
      patterns.add(encodeURIComponent(value));
      patterns.add(new URLSearchParams({ value }).toString().slice("value=".length));
      const jsonEncoded = JSON.stringify(value);
      if (jsonEncoded.length >= 2) patterns.add(jsonEncoded.slice(1, -1));
    }
    this.#patterns = Object.freeze(
      [...patterns].filter((value) => value.length > 0).sort((left, right) => right.length - left.length),
    );
  }

  redact(text: string): string {
    let redacted = text;
    for (const pattern of this.#patterns) {
      redacted = redacted.split(pattern).join(PROVIDER_SECRET_REDACTION_MARKER);
    }
    return redacted;
  }

  redactValue<T>(value: T): T {
    return redactNestedValue(value, (text) => this.redact(text)) as T;
  }

  createTextStream(): StreamingSensitiveTextRedactor {
    let pending = "";
    return {
      push: (text) => {
        pending += text;
        const redacted = this.redact(pending);
        const heldLength = this.#longestSecretPrefixSuffix(redacted);
        const emitLength = redacted.length - heldLength;
        pending = redacted.slice(emitLength);
        return redacted.slice(0, emitLength);
      },
      flush: () => {
        const output = this.redact(pending);
        pending = "";
        return output;
      },
    };
  }

  #longestSecretPrefixSuffix(text: string): number {
    let longest = 0;
    for (const pattern of this.#patterns) {
      const upper = Math.min(pattern.length - 1, text.length);
      for (let length = upper; length > longest; length -= 1) {
        if (text.endsWith(pattern.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
    return longest;
  }
}

function redactNestedValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactNestedValue(item, redact));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [redact(key), redactNestedValue(nested, redact)]),
  );
}
