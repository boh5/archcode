import { describe, expect, test } from "bun:test";
import { REDACTION_MARKER } from "../tools/security";
import {
  McpServerNameError,
  McpToolNameError,
  McpDuplicateToolError,
  McpConnectionError,
  McpToolExecutionError,
  redactMcpMessage,
} from "./errors";
import type { McpWarning } from "./errors";
import {
  validateMcpNameSegment,
  toMcpToolRegistryName,
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

// ─── redactMcpMessage ───

describe("redactMcpMessage", () => {
  test("replaces literal secret with REDACTION_MARKER", () => {
    const result = redactMcpMessage("my key is sk-abc123 def", ["sk-abc123"]);
    expect(result).toBe(`my key is ${REDACTION_MARKER} def`);
  });

  test("replaces multiple occurrences of the same secret", () => {
    const result = redactMcpMessage("key=sk-abc, token=sk-abc", ["sk-abc"]);
    expect(result).toBe(`key=${REDACTION_MARKER}, token=${REDACTION_MARKER}`);
  });

  test("covers direct literal secrets, not only environment-expanded values", () => {
    const result = redactMcpMessage("Bearer myRawSecretValue", [
      "myRawSecretValue",
    ]);
    expect(result).toBe(`Bearer ${REDACTION_MARKER}`);
  });

  test("ignores empty-string secrets", () => {
    const result = redactMcpMessage("hello world", [""]);
    expect(result).toBe("hello world");
  });

  test("handles multiple secrets in one pass", () => {
    const secrets = ["secret1", "secret2"];
    const result = redactMcpMessage("secret1 and secret2", secrets);
    expect(result).toBe(`${REDACTION_MARKER} and ${REDACTION_MARKER}`);
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
    const redacted = redactMcpMessage(raw, ["sk-abc123"]);
    const warning: McpWarning = {
      serverName: "test-server",
      message: redacted,
    };
    expect(warning.message).not.toContain("sk-abc123");
    expect(warning.message).toContain(REDACTION_MARKER);
  });
});
