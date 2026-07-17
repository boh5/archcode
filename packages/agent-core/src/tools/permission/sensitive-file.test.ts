import { describe, test, expect } from "bun:test";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext } from "../types";
import { classifySensitivePath, createSensitiveFilePermission, isSensitiveFile, SENSITIVE_PATTERNS } from "./sensitive-file";
import { createTestProjectContext } from "../test-project-context";

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return { store: {} as ToolExecutionContext["store"],
  toolName: "file_read",
  toolCallId: "call-1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["file_read", "file_edit", "file_write"]),
  cwd: "/workspace",
  storeManager,
    projectContext: createTestProjectContext("/workspace"), ...overrides,  };
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

describe("classifySensitivePath", () => {
  test("keeps file-tool basename behavior separate from effective Bash credential paths", () => {
    expect(classifySensitivePath({
      inputBasename: "ordinary-link",
      effectiveCanonicalPath: "/home/user/.ssh/id_ed25519",
    })).toEqual({ bashCredential: true, fileToolSensitive: false });
    expect(classifySensitivePath({
      inputBasename: ".env",
      effectiveCanonicalPath: "/workspace/not-sensitive.txt",
    })).toEqual({ bashCredential: false, fileToolSensitive: true });
  });

  test("uses the closed credential set and template exceptions", () => {
    for (const file of [".env", ".env.local", ".npmrc", ".pypirc", ".netrc", "key.pem", "id_dsa_test"]) {
      expect(classifySensitivePath({ inputBasename: file, effectiveCanonicalPath: `/tmp/${file}` }).bashCredential, file).toBe(true);
    }
    for (const file of [".env.example", ".env.sample", ".env.template", "cert.pfx", ".bashrc"]) {
      expect(classifySensitivePath({ inputBasename: file, effectiveCanonicalPath: `/tmp/${file}` }).bashCredential, file).toBe(false);
    }
    expect(classifySensitivePath({ inputBasename: ".env.example", effectiveCanonicalPath: "/home/user/.ssh/.env.example" }).bashCredential).toBe(true);
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
