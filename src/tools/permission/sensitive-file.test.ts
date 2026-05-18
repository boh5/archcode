import { describe, test, expect } from "bun:test";
import type { ToolExecutionContext } from "../types";
import { createSensitiveFilePermission, isSensitiveFile, SENSITIVE_PATTERNS } from "./sensitive-file";
import { createTestProjectContext } from "../test-project-context";

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    store: {} as ToolExecutionContext["store"],
    toolName: "file_read",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["file_read", "file_edit", "file_write"]),
    workspaceRoot: "/workspace",
    projectContext: createTestProjectContext("/workspace"),
    ...overrides,
  };
}

describe("isSensitiveFile", () => {
  test.each([
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.example", false],
    [".env.template", false],
    [".env.sample", false],
    ["key.pem", true],
    ["secret.key", true],
    ["cert.p12", true],
    ["id_rsa", true],
    ["id_rsa.pub", true],
    ["id_ed25519", true],
    [".gitconfig", true],
    [".bashrc", true],
    [".zshrc", true],
    [".npmrc", true],
    ["README.md", false],
    ["index.ts", false],
    ["package.json", false],
    [".gitignore", false],
    ["tsconfig.json", false],
    ["main.go", false],
  ])("isSensitiveFile(%j) returns %j", (filename, expected) => {
    expect(isSensitiveFile(filename)).toBe(expected);
  });
});

describe("SENSITIVE_PATTERNS", () => {
  test("is a non-empty array of RegExp", () => {
    expect(Array.isArray(SENSITIVE_PATTERNS)).toBe(true);
    expect(SENSITIVE_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});

describe("createSensitiveFilePermission", () => {
  test("returns ask for .env files", async () => {
    const permission = createSensitiveFilePermission();
    const decision = await permission({ path: "/workspace/.env" }, makeCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("sensitive");
    expect(decision.prompt).toBeTruthy();
  });

  test("returns ask for .pem files", async () => {
    const permission = createSensitiveFilePermission();
    const decision = await permission({ path: "/workspace/cert.pem" }, makeCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("sensitive");
  });

  test("returns allow for non-sensitive files", async () => {
    const permission = createSensitiveFilePermission();
    const decision = await permission({ path: "/workspace/index.ts" }, makeCtx());

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("returns allow for .env.example files", async () => {
    const permission = createSensitiveFilePermission();
    const decision = await permission({ path: "/workspace/.env.example" }, makeCtx());

    expect(decision).toEqual({ outcome: "allow" });
  });
});
