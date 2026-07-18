import { describe, expect, test } from "bun:test";
import {
  PROVIDER_SECRET_REDACTION_MARKER,
  SensitiveValueRedactor,
} from "./sensitive-value-redactor";

describe("SensitiveValueRedactor", () => {
  test("redacts raw, URI, form-query, and JSON-escaped forms", () => {
    const secret = "query secret+&\"";
    const redactor = new SensitiveValueRedactor([secret]);
    const formEncoded = new URLSearchParams({ value: secret }).toString().slice("value=".length);
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);

    for (const candidate of [secret, encodeURIComponent(secret), formEncoded, jsonEscaped]) {
      expect(redactor.redact(`before ${candidate} after`)).toBe(
        `before ${PROVIDER_SECRET_REDACTION_MARKER} after`,
      );
    }
  });

  test("redacts secrets split across arbitrary stream chunks", () => {
    const redactor = new SensitiveValueRedactor(["header-secret"]);
    const stream = redactor.createTextStream();
    const output = [stream.push("before hea"), stream.push("der-sec"), stream.push("ret after"), stream.flush()].join("");

    expect(output).toBe(`before ${PROVIDER_SECRET_REDACTION_MARKER} after`);
    expect(output).not.toContain("header-secret");
  });

  test("redacts nested object keys and values", () => {
    const redactor = new SensitiveValueRedactor(["configured-secret"]);

    expect(redactor.redactValue({ configured_secret: { nested: ["configured-secret"] } }))
      .toEqual({ configured_secret: { nested: [PROVIDER_SECRET_REDACTION_MARKER] } });
    expect(redactor.redactValue<Record<string, unknown>>({ "configured-secret": "safe" }))
      .toEqual({ [PROVIDER_SECRET_REDACTION_MARKER]: "safe" });
  });
});
