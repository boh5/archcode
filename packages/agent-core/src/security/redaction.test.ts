import { describe, expect, test } from "bun:test";

import {
  REDACTION_MARKER,
  SecretLiteralPolicyError,
  SecretRedactionPolicy,
} from "./redaction";

describe("SecretRedactionPolicy", () => {
  test("replaces only explicitly registered literal values", () => {
    const literal = "runtime-literal-secret";
    const policy = new SecretRedactionPolicy([literal]);

    expect(policy.redactString(`before:${literal}:after`))
      .toBe(`before:${REDACTION_MARKER}:after`);
    expect(policy.redactValue<Record<string, unknown>>({
      nested: [`echo ${literal}`],
      [literal]: "value",
    })).toEqual({
      nested: [`echo ${REDACTION_MARKER}`],
      [REDACTION_MARKER]: "value",
    });
  });

  test("preserves unregistered tool-shaped values without interpreting names or content", () => {
    const policy = new SecretRedactionPolicy([]);
    const value = {
      tokenBudget: 5_000,
      maxOutputTokens: 64_000,
      authorizationMode: "ask",
      authTokenFile: "apps/web/src/components/composite/ExecutionWorkstream.tsx",
      command: "echo AAAAAAAAAAAAAAA/AAAAAAAAAAAAAAAA",
    };

    expect(policy.redactValue(value)).toEqual(value);
  });

  test("enforces exact literal registry bounds", () => {
    expect(() => new SecretRedactionPolicy(["12345678"])).not.toThrow();
    expect(() => new SecretRedactionPolicy(["x".repeat(16 * 1024)])).not.toThrow();
    expect(() => new SecretRedactionPolicy(["1234567"])).toThrow(SecretLiteralPolicyError);
    expect(() => new SecretRedactionPolicy(["x".repeat(16 * 1024 + 1)])).toThrow(SecretLiteralPolicyError);
    expect(() => new SecretRedactionPolicy(
      Array.from({ length: 257 }, (_, index) => `secret-${index.toString().padStart(4, "0")}`),
    )).toThrow(SecretLiteralPolicyError);
    expect(() => new SecretRedactionPolicy(
      Array.from({ length: 5 }, (_, index) => `${index}${"x".repeat(16 * 1024 - 1)}`),
    )).toThrow(SecretLiteralPolicyError);
  });
});
