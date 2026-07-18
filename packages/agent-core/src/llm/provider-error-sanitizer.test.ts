import { describe, expect, test } from "bun:test";
import { SensitiveValueRedactor, PROVIDER_SECRET_REDACTION_MARKER } from "../provider/sensitive-value-redactor";
import { sanitizeProviderError } from "./provider-error-sanitizer";

describe("sanitizeProviderError", () => {
  test("retains retry metadata without carrying Provider response fields or configured secrets", () => {
    const secret = "configured-secret";
    const redactor = new SensitiveValueRedactor([secret]);
    const raw = Object.assign(new Error(`request URL contains ${secret}`), {
      name: `Provider${secret}Error`,
      status: 429,
      code: `rate_${secret}`,
      retryAfterMs: 1000,
      headers: { "retry-after": "2" },
      url: `https://example.test/?token=${secret}`,
      body: { error: secret },
    });

    const safe = sanitizeProviderError(raw, (text) => redactor.redact(text)) as Error & Record<string, unknown>;
    const serialized = JSON.stringify({
      name: safe.name,
      message: safe.message,
      status: safe.status,
      code: safe.code,
      retryAfterMs: safe.retryAfterMs,
      headers: safe.headers,
      url: safe.url,
      body: safe.body,
    });

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(PROVIDER_SECRET_REDACTION_MARKER);
    expect(safe.status).toBe(429);
    expect(safe.retryAfterMs).toBe(1000);
    expect(safe.url).toBeUndefined();
    expect(safe.body).toBeUndefined();
  });
});
