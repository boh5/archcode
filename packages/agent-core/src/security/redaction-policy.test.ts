import { describe, expect, test } from "bun:test";

import {
  REDACTION_MARKER,
  SecretLiteralPolicyError,
  SecretRedactionPolicy,
} from "./redaction";

function stream(policy: SecretRedactionPolicy, input: string, chunkSizes: readonly number[]): string {
  const redactor = policy.createStreamRedactor();
  let output = "";
  let offset = 0;
  let chunkIndex = 0;
  while (offset < input.length) {
    const size = chunkSizes[chunkIndex % chunkSizes.length]!;
    output += redactor.push(input.slice(offset, offset + size));
    offset += size;
    chunkIndex += 1;
  }
  return output + redactor.finish();
}

describe("SecretRedactionPolicy", () => {
  test("matches one-shot output at every two-chunk split without corrupting paths", async () => {
    const literal = "runtime-literal-secret";
    const policy = new SecretRedactionPolicy([literal]);
    const input = [
      "/private/var/folders/ab/cd/T/archcode-bash-cwd-fixture",
      literal,
      "password=assignment-secret-value",
      "AAAAAAAAAAAAAAA/AAAAAAAAAAAAAAAA",
    ].join("|");
    const expected = policy.redactString(input);

    for (let split = 0; split <= input.length; split += 1) {
      const redactor = policy.createStreamRedactor();
      const actual = await redactor.push(input.slice(0, split))
        + await redactor.push(input.slice(split))
        + await redactor.finish();
      expect(actual).toBe(expected);
    }
    expect(expected).toContain("/private/var/folders/ab/cd/T/archcode-bash-cwd-fixture");
    expect(expected).not.toContain(literal);
  });

  test("streaming output equals one-shot output across literal, assignment, and token chunk boundaries", () => {
    const literal = "runtime-literal-secret";
    const policy = new SecretRedactionPolicy([literal]);
    const input = [
      "prefix",
      literal,
      "password=assignment-secret-value",
      "sk_test_token_1234567890",
      "suffix",
    ].join("|");

    const expected = policy.redactString(input);
    expect(stream(policy, input, [1])).toBe(expected);
    expect(stream(policy, input, [2, 7, 3, 11])).toBe(expected);
    expect(stream(policy, input, [input.length])).toBe(expected);
    expect(expected).not.toContain(literal);
  });

  test("keeps long assignment and token runs redacted after they exceed carry", () => {
    const policy = new SecretRedactionPolicy([]);
    const assignment = `before password=${"x".repeat(80 * 1024)} after`;
    const token = `before ${"A".repeat(80 * 1024)} after`;

    expect(stream(policy, assignment, [997, 4093])).toBe(policy.redactString(assignment));
    expect(stream(policy, token, [1021, 2053])).toBe(policy.redactString(token));
    expect(stream(policy, assignment, [997, 4093])).toContain(REDACTION_MARKER);
  });

  test("enforces exact literal entry boundaries", () => {
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

  test("keeps a max-size literal match while bounding multibyte carry by UTF-8 bytes", async () => {
    const literal = "s".repeat(16 * 1024);
    const policy = new SecretRedactionPolicy([literal]);
    const redactor = policy.createStreamRedactor();
    const firstInput = `${"😀".repeat(20_000)}${literal.slice(0, literal.length / 2)}`;
    const firstOutput = await redactor.push(firstInput);
    const retainedBytes = Buffer.byteLength(firstInput, "utf8") - Buffer.byteLength(firstOutput, "utf8");

    expect(retainedBytes).toBeLessThanOrEqual(16 * 1024 + 64);
    const output = firstOutput + await redactor.push(literal.slice(literal.length / 2)) + await redactor.finish();
    expect(output).toBe(policy.redactString(`${"😀".repeat(20_000)}${literal}`));
    expect(output).not.toContain(literal);
  });
});
