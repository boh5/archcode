import { describe, expect, test } from "bun:test";
import {
  MCP_ALIAS_MAX_LENGTH,
  sanitizeMcpServerNameForRegistry,
  toMcpToolRegistryName,
  validateMcpNameSegment,
} from "./naming";

describe("MCP aliases", () => {
  test("is stable, provider-safe and retains a readable identity prefix", () => {
    const first = toMcpToolRegistryName("context7", "resolve-library-id");
    const second = toMcpToolRegistryName("context7", "resolve-library-id");
    expect(first).toBe(second);
    expect(first).toMatch(/^mcp__context7__resolve-library-id__[a-f0-9]{20}$/);
    expect(first.length).toBeLessThanOrEqual(MCP_ALIAS_MAX_LENGTH);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("disambiguates identities that sanitize to the same visible text", () => {
    const dot = toMcpToolRegistryName("grep.app", "find.tool");
    const underscore = toMcpToolRegistryName("grep_app", "find_tool");
    expect(dot).not.toBe(underscore);
    expect(dot.replace(/[a-f0-9]{20}$/, "")).toBe(underscore.replace(/[a-f0-9]{20}$/, ""));
  });

  test("bounds long legal and punctuation-heavy tool names", () => {
    const alias = toMcpToolRegistryName("server-name", `name.with.${"x".repeat(300)}/unicode-工具`);
    expect(alias.length).toBeLessThanOrEqual(64);
    expect(alias).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("different original names do not collide after truncation", () => {
    const prefix = "x".repeat(100);
    expect(toMcpToolRegistryName("docs", `${prefix}a`)).not.toBe(toMcpToolRegistryName("docs", `${prefix}b`));
  });

  test("keeps the raw identity in the hash without exposing it in a redacted prefix", () => {
    const raw = "lookup-metadata-secret-value";
    const alias = toMcpToolRegistryName("docs", raw, "lookup-[REDACTED:SECRET]");
    expect(alias).not.toContain("metadata-secret-value");
    expect(alias).not.toBe(toMcpToolRegistryName("docs", "lookup-other-secret", "lookup-[REDACTED:SECRET]"));
  });

  test("server config name validation remains strict", () => {
    expect(() => validateMcpNameSegment("docs.server", "server")).not.toThrow();
    expect(() => validateMcpNameSegment("bad server", "server")).toThrow("must match");
    expect(() => validateMcpNameSegment("bad__server", "server")).toThrow("consecutive underscores");
  });

  test("sanitizer never returns an empty segment", () => {
    expect(sanitizeMcpServerNameForRegistry("...")).toBe("___");
    expect(sanitizeMcpServerNameForRegistry("工具")).toBe("__");
  });
});
