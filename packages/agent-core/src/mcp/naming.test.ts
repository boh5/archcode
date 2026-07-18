import { describe, expect, test } from "bun:test";
import { REDACTION_MARKER } from "../security";
import {
  McpServerNameError,
  McpToolNameError,
  McpDuplicateToolError,
  McpConnectionError,
  McpToolExecutionError,
} from "./errors";
import { SecretRedactionPolicy } from "../security";
import type { McpWarning } from "./errors";
import {
  validateMcpNameSegment,
  toMcpToolRegistryName,
  sanitizeMcpServerNameForRegistry,
} from "./naming";

// ─── validateMcpNameSegment ───

describe("validateMcpNameSegment", () => {
  test("accepts valid server name", () => {
    expect(() => validateMcpNameSegment("context7", "server")).not.toThrow();
  });

  test("accepts valid tool name with hyphens and dots", () => {
    expect(() =>
      validateMcpNameSegment("resolve-library-id", "tool"),
    ).not.toThrow();
  });

  test("accepts name with dots", () => {
    expect(() => validateMcpNameSegment("my.server", "server")).not.toThrow();
  });

  test("rejects empty server name", () => {
    expect(() => validateMcpNameSegment("", "server")).toThrow(McpServerNameError);
  });

  test("rejects empty tool name", () => {
    expect(() => validateMcpNameSegment("", "tool")).toThrow(McpToolNameError);
  });

  test("rejects server name with spaces", () => {
    expect(() => validateMcpNameSegment("my server", "server")).toThrow(
      McpServerNameError,
    );
  });

  test("rejects server name with forward slash", () => {
    expect(() => validateMcpNameSegment("foo/bar", "server")).toThrow(
      McpServerNameError,
    );
  });

  test("rejects name containing double underscores", () => {
    expect(() => validateMcpNameSegment("foo__bar", "server")).toThrow(
      McpServerNameError,
    );

    expect(() => validateMcpNameSegment("foo__bar", "tool")).toThrow(
      McpToolNameError,
    );
  });

  test("accepts name with single underscores", () => {
    expect(() =>
      validateMcpNameSegment("my_server", "server"),
    ).not.toThrow();
  });
});

// ─── toMcpToolRegistryName ───

describe("toMcpToolRegistryName", () => {
  test('returns "mcp__context7__resolve-library-id" for canonical example', () => {
    expect(toMcpToolRegistryName("context7", "resolve-library-id")).toBe(
      "mcp__context7__resolve-library-id",
    );
  });

  test('sanitizes dots in server name: "grep.app" + "search" => "mcp__grep_app__search"', () => {
    expect(toMcpToolRegistryName("grep.app", "search")).toBe(
      "mcp__grep_app__search",
    );
  });

  test("sanitizes dots in both segments: my.server.name + my.tool => mcp__my_server_name__my_tool", () => {
    expect(toMcpToolRegistryName("my.server.name", "my.tool")).toBe(
      "mcp__my_server_name__my_tool",
    );
  });

  test("preserves hyphens (provider-allowed): my-server + resolve-library-id", () => {
    expect(toMcpToolRegistryName("my-server", "resolve-library-id")).toBe(
      "mcp__my-server__resolve-library-id",
    );
  });

  test("preserves underscores: my_server + my_tool", () => {
    expect(toMcpToolRegistryName("my_server", "my_tool")).toBe(
      "mcp__my_server__my_tool",
    );
  });

  test("throws McpServerNameError for invalid server", () => {
    expect(() =>
      toMcpToolRegistryName("bad server", "tool"),
    ).toThrow(McpServerNameError);
  });

  test("throws McpToolNameError for invalid tool", () => {
    expect(() =>
      toMcpToolRegistryName("server", "bad tool"),
    ).toThrow(McpToolNameError);
  });
});

// ─── sanitizeMcpServerNameForRegistry ───

describe("sanitizeMcpServerNameForRegistry", () => {
  test("replaces dots with underscores: grep.app => grep_app", () => {
    expect(sanitizeMcpServerNameForRegistry("grep.app")).toBe("grep_app");
  });

  test("leaves already-safe names unchanged: context7 => context7", () => {
    expect(sanitizeMcpServerNameForRegistry("context7")).toBe("context7");
  });

  test("replaces multiple dots: a.b.c => a_b_c", () => {
    expect(sanitizeMcpServerNameForRegistry("a.b.c")).toBe("a_b_c");
  });

  test("preserves hyphens (provider-allowed): my-server => my-server", () => {
    expect(sanitizeMcpServerNameForRegistry("my-server")).toBe("my-server");
  });

  test("preserves underscores: my_server => my_server", () => {
    expect(sanitizeMcpServerNameForRegistry("my_server")).toBe("my_server");
  });

  test("replaces spaces with underscores", () => {
    expect(sanitizeMcpServerNameForRegistry("my server")).toBe("my_server");
  });

  test("is deterministic (same input → same output)", () => {
    expect(sanitizeMcpServerNameForRegistry("grep.app")).toBe(
      sanitizeMcpServerNameForRegistry("grep.app"),
    );
  });
});

// ─── Error Classes ───

describe("McpServerNameError", () => {
  test("has correct name, message, and fields", () => {
    const err = new McpServerNameError("bad name", "contains spaces");
    expect(err.name).toBe("McpServerNameError");
    expect(err.message).toBe(
      'Invalid MCP server name "bad name": contains spaces',
    );
    expect(err.value).toBe("bad name");
    expect(err.reason).toBe("contains spaces");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("McpToolNameError", () => {
  test("has correct name, message, and fields", () => {
    const err = new McpToolNameError("bad/tool", "contains slash");
    expect(err.name).toBe("McpToolNameError");
    expect(err.message).toBe(
      'Invalid MCP tool name "bad/tool": contains slash',
    );
    expect(err.value).toBe("bad/tool");
    expect(err.reason).toBe("contains slash");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("McpDuplicateToolError", () => {
  test("has correct name, message, and fields", () => {
    const err = new McpDuplicateToolError(
      "my-server",
      "my-tool",
      "mcp__my-server__my-tool",
    );
    expect(err.name).toBe("McpDuplicateToolError");
    expect(err.message).toBe(
      'Duplicate tool "my-tool" in server "my-server" (registry: "mcp__my-server__my-tool")',
    );
    expect(err.serverName).toBe("my-server");
    expect(err.toolName).toBe("my-tool");
    expect(err.registryName).toBe("mcp__my-server__my-tool");
  });
});

describe("McpConnectionError", () => {
  test("has correct name and fields without cause", () => {
    const err = new McpConnectionError("my-server");
    expect(err.name).toBe("McpConnectionError");
    expect(err.message).toBe(
      'MCP connection failed for server "my-server"',
    );
    expect(err.serverName).toBe("my-server");
    expect(err.cause).toBeUndefined();
  });

  test("includes cause message when provided as Error", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new McpConnectionError("my-server", cause);
    expect(err.message).toBe(
      'MCP connection failed for server "my-server": ECONNREFUSED',
    );
    expect(err.cause).toBe(cause);
  });
});

describe("McpToolExecutionError", () => {
  test("has correct name and fields without cause", () => {
    const err = new McpToolExecutionError("my-server", "my-tool");
    expect(err.name).toBe("McpToolExecutionError");
    expect(err.message).toBe(
      'MCP tool execution failed for "my-server.my-tool"',
    );
    expect(err.serverName).toBe("my-server");
    expect(err.toolName).toBe("my-tool");
    expect(err.cause).toBeUndefined();
  });

  test("includes cause message when provided as Error", () => {
    const cause = new Error("timeout");
    const err = new McpToolExecutionError("my-server", "my-tool", cause);
    expect(err.message).toBe(
      'MCP tool execution failed for "my-server.my-tool": timeout',
    );
    expect(err.cause).toBe(cause);
  });
});

// ─── McpWarning ───

describe("McpWarning", () => {
  test("can carry server name, tool name, and message", () => {
    const warning: McpWarning = {
      serverName: "my-server",
      toolName: "my-tool",
      message: "Deprecated parameter ignored",
    };
    expect(warning.serverName).toBe("my-server");
    expect(warning.toolName).toBe("my-tool");
    expect(warning.message).toBe("Deprecated parameter ignored");
  });

  test("works with only a message (serverName and toolName optional)", () => {
    const warning: McpWarning = {
      message: "Some diagnostic info",
    };
    expect(warning.serverName).toBeUndefined();
    expect(warning.toolName).toBeUndefined();
    expect(warning.message).toBe("Some diagnostic info");
  });
});

// ─── Redaction Safety ───

describe("redaction safety", () => {
  test("error classes do not retain raw secret values in public fields", () => {
    // McpConnectionError and McpToolExecutionError should never expose raw
    // header values or expanded secrets via their typed public fields.
    const err = new McpConnectionError("my-server");
    // The public fields are serverName (string) and cause (unknown).
    // Neither is a place for raw secret storage.
    expect(Object.keys(err)).toEqual(
      expect.arrayContaining(["serverName"]),
    );
    // Verify serverName is the server name, not a secret
    expect(err.serverName).toBe("my-server");
  });

  test("McpWarning message can hold redacted content safely", () => {
    const raw = "Authorization: Bearer sk-abc123";
    const redacted = new SecretRedactionPolicy(["sk-abc123"]).redactString(raw);
    const warning: McpWarning = {
      serverName: "test-server",
      message: redacted,
    };
    expect(warning.message).not.toContain("sk-abc123");
    expect(warning.message).toContain(REDACTION_MARKER);
  });
});
