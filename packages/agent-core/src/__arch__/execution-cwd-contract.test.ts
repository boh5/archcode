import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");

function source(relativePath: string): string {
  return readFileSync(join(srcRoot, relativePath), "utf8");
}

describe("Session execution cwd architecture", () => {
  test("Session and Agent runtime contracts require cwd", () => {
    const protocolTypes = readFileSync(resolve(srcRoot, "../../protocol/src/types.ts"), "utf8");
    const agentTypes = source("agents/types.ts");
    const configuredAgent = source("agents/configured-agent.ts");

    expect(protocolTypes).toMatch(/interface SessionProjection\s*\{[^}]*\bcwd:\s*string;/s);
    expect(protocolTypes).toMatch(/interface SessionSummary\s*\{[^}]*\bcwd:\s*string;/s);
    expect(protocolTypes).toMatch(/interface Session\s*\{[^}]*\bcwd:\s*string;/s);
    expect(agentTypes).toMatch(/interface Agent\s*\{[^}]*\breadonly cwd:\s*string;/s);
    expect(configuredAgent).toMatch(/\breadonly cwd:\s*string;/);
  });

  test("Session registry identity is always scoped by the canonical project root", () => {
    const manager = source("store/session-store-manager.ts");

    expect(manager).toMatch(/private key\(sessionId: string, workspaceRoot: string\): string/);
    expect(manager).toMatch(/get\(sessionId: string, workspaceRoot: string\)/);
    expect(manager).toMatch(/delete\(sessionId: string, workspaceRoot: string,/);
    expect(manager).toMatch(/has\(sessionId: string, workspaceRoot: string\)/);
  });

  test("execution contracts expose cwd", () => {
    const contracts = [
      "tools/types.ts",
      "agents/query/types.ts",
      "commands/types.ts",
      "tools/permission/scopes.ts",
    ] as const;

    for (const file of contracts) {
      const text = source(file);
      expect(text, `${file} must expose an explicit cwd contract`).toMatch(/\bcwd\??:\s*(?:readonly\s+)?string\b|readonly\s+cwd\??:\s*string\b/);
    }
  });

  test("every source-facing tool family anchors execution to Session cwd", () => {
    const sourceFacingTools = [
      "tools/builtins/file-read.ts",
      "tools/builtins/file-write.ts",
      "tools/builtins/file-edit.ts",
      "tools/builtins/grep.ts",
      "tools/builtins/glob.ts",
      "tools/builtins/ast-grep/search.ts",
      "tools/builtins/ast-grep/replace.ts",
      "tools/builtins/git-status.ts",
      "tools/builtins/git-diff.ts",
      "tools/builtins/bash.ts",
      "tools/builtins/skill-list.ts",
      "tools/builtins/skill-read.ts",
      "tools/builtins/lsp/lsp-diagnostics.ts",
      "tools/builtins/lsp/lsp-goto-definition.ts",
      "tools/builtins/lsp/lsp-find-references.ts",
      "tools/builtins/lsp/lsp-symbols.ts",
    ] as const;

    for (const file of sourceFacingTools) {
      expect(source(file), `${file} must resolve from the current Session cwd`).toContain("ctx.cwd");
    }
  });

  test("prompt context has one canonical project root and one execution cwd", () => {
    const promptTypes = source("prompt/types.ts");
    expect(promptTypes).toMatch(/interface PromptEnv\s*\{[^}]*\bprojectRoot:\s*string/);
    expect(promptTypes).toMatch(/interface PromptEnv\s*\{[^}]*\bcwd:\s*string/);
  });
});
