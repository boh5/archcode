import { describe, expect, it } from "bun:test";
import {
  ASSIGNMENT_PATTERN,
  SENSITIVE_KEY_PATTERN,
  TOKEN_PATTERN,
  containsSecretPattern,
} from "./patterns";

describe("SENSITIVE_KEY_PATTERN", () => {
  it("matches common sensitive key names", () => {
    expect(SENSITIVE_KEY_PATTERN.test("api_key")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("API_KEY")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("apiKey")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("password")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("PASSWORD")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("token")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("secret")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("authorization")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("bearer")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("client_secret")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("credential")).toBe(true);
  });

  it("does not match non-sensitive key names", () => {
    expect(SENSITIVE_KEY_PATTERN.test("username")).toBe(false);
    expect(SENSITIVE_KEY_PATTERN.test("email")).toBe(false);
    expect(SENSITIVE_KEY_PATTERN.test("name")).toBe(false);
    expect(SENSITIVE_KEY_PATTERN.test("description")).toBe(false);
  });
});

describe("TOKEN_PATTERN", () => {
  it("matches well-known token prefixes with underscore separator", () => {
    TOKEN_PATTERN.lastIndex = 0;
    expect(TOKEN_PATTERN.test("sk_test_1234567890abcdef")).toBe(true);
    TOKEN_PATTERN.lastIndex = 0;
    expect(TOKEN_PATTERN.test("pk_live_abcdef1234567890")).toBe(true);
    TOKEN_PATTERN.lastIndex = 0;
    expect(TOKEN_PATTERN.test("ghp_ABCDEFGHIJKLMNOPQRST")).toBe(true);
  });

  it("matches well-known token prefixes with dash separator", () => {
    TOKEN_PATTERN.lastIndex = 0;
    expect(TOKEN_PATTERN.test("sk-test-1234567890abcdef")).toBe(true);
  });

  it("matches long base64-like strings (32+ chars)", () => {
    TOKEN_PATTERN.lastIndex = 0;
    expect(TOKEN_PATTERN.test("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890AB")).toBe(true);
  });

  it("does not match short strings", () => {
    TOKEN_PATTERN.lastIndex = 0;
    expect(TOKEN_PATTERN.test("short")).toBe(false);
  });

  it("does not match AWS-style keys without underscore/dash separator", () => {
    TOKEN_PATTERN.lastIndex = 0;
    expect(TOKEN_PATTERN.test("AKIAIOSFODNN7EXAMPLE")).toBe(false);
  });
});

describe("ASSIGNMENT_PATTERN", () => {
  it("matches key=value patterns with sensitive keys", () => {
    ASSIGNMENT_PATTERN.lastIndex = 0;
    expect(ASSIGNMENT_PATTERN.test("api_key=sk_test_1234567890")).toBe(true);
    ASSIGNMENT_PATTERN.lastIndex = 0;
    expect(ASSIGNMENT_PATTERN.test("token: abc123def456")).toBe(true);
    ASSIGNMENT_PATTERN.lastIndex = 0;
    expect(ASSIGNMENT_PATTERN.test("password=secret123")).toBe(true);
  });

  it("does not match non-sensitive key assignments", () => {
    ASSIGNMENT_PATTERN.lastIndex = 0;
    expect(ASSIGNMENT_PATTERN.test("name=John")).toBe(false);
  });
});

describe("containsSecretPattern", () => {
  it("detects API keys in content", () => {
    const result = containsSecretPattern("api_key=sk_test_1234567890abcdef");
    expect(result.found).toBe(true);
    expect(result.patterns).toContain("assignment");
  });

  it("detects passwords in content", () => {
    const result = containsSecretPattern("password=mysecret123");
    expect(result.found).toBe(true);
    expect(result.patterns).toContain("assignment");
  });

  it("detects tokens in content", () => {
    const result = containsSecretPattern("sk_abcdef1234567890abcdefghij");
    expect(result.found).toBe(true);
    expect(result.patterns).toContain("token");
  });

  it("detects AWS-style keys with underscore", () => {
    const result = containsSecretPattern("AKIA_IOSFODNN7EXAMPLE12345678");
    expect(result.found).toBe(true);
    expect(result.patterns).toContain("token");
  });

  it("returns empty patterns for clean content", () => {
    const result = containsSecretPattern("This is a normal text about project architecture.");
    expect(result.found).toBe(false);
    expect(result.patterns).toEqual([]);
  });

  it("returns multiple pattern names when both match", () => {
    const result = containsSecretPattern("token=sk_test_1234567890abcdef");
    expect(result.found).toBe(true);
    expect(result.patterns).toContain("assignment");
    expect(result.patterns).toContain("token");
  });

  it("does not flag normal assignment patterns", () => {
    const result = containsSecretPattern("name=MyProject&version=1.0");
    expect(result.found).toBe(false);
  });
});