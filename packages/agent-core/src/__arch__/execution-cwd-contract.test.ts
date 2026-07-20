import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");

function source(relativePath: string): string {
  return readFileSync(join(srcRoot, relativePath), "utf8");
}

function productionTypeScriptFiles(relativeDirectory: string): string[] {
  const directory = join(srcRoot, relativeDirectory);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__test_tmp__") continue;
      files.push(...productionTypeScriptFiles(relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(relativePath);
    }
  }
  return files;
}

describe("Session execution cwd architecture", () => {
  test("Session and Agent runtime contracts require cwd after creation", () => {
    const protocolTypes = readFileSync(resolve(srcRoot, "../../protocol/src/types.ts"), "utf8");
    const agentTypes = source("agents/types.ts");
    const factory = source("agents/factory.ts");
    const configuredAgent = source("agents/configured-agent.ts");
    const sessionAgentManager = source("agents/session-agent-manager.ts");

    expect(protocolTypes).not.toMatch(/interface SessionProjection\s*\{[^}]*\bcwd\?:/s);
    expect(protocolTypes).not.toMatch(/interface SessionSummary\s*\{[^}]*\bcwd\?:/s);
    expect(protocolTypes).not.toMatch(/interface Session\s*\{[^}]*\bcwd\?:/s);
    expect(agentTypes).not.toMatch(/interface Agent\s*\{[^}]*\bcwd\?:/s);
    expect(factory).not.toMatch(/store\.getState\(\)\.cwd\s*\?\?/);
    expect(configuredAgent).not.toMatch(/readonly cwd\?: string/);
    expect(sessionAgentManager).not.toContain("existing.cwd === undefined");
  });

  test("Session registry identity is always scoped by the canonical project root", () => {
    const manager = source("store/session-store-manager.ts");

    expect(manager).toMatch(/private key\(sessionId: string, workspaceRoot: string\): string/);
    expect(manager).toMatch(/get\(sessionId: string, workspaceRoot: string\)/);
    expect(manager).toMatch(/delete\(sessionId: string, workspaceRoot: string,/);
    expect(manager).toMatch(/has\(sessionId: string, workspaceRoot: string\)/);
    expect(manager).not.toContain("findLoadedSession");
    expect(manager).not.toMatch(/workspaceRoot === undefined\s*\?\s*sessionId/);
  });

  test("execution contracts expose cwd instead of overloading workspaceRoot", () => {
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

    const toolExecutionContext = source("tools/types.ts").match(
      /export interface ToolExecutionContext\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(toolExecutionContext).toBeDefined();
    expect(toolExecutionContext).not.toMatch(/\bworkspaceRoot:\s*string\s*;/);
    expect(source("agents/query/types.ts")).not.toMatch(/\bworkspaceRoot\??:\s*string\s*;/);
    expect(source("commands/types.ts")).not.toMatch(/\bworkspaceRoot\??:\s*string\s*;/);
    expect(source("tools/permission/scopes.ts")).not.toMatch(/\bworkspaceRoot:\s*string\s*;/);
  });

  test("tool code never reads an overloaded ctx.workspaceRoot field", () => {
    const files = ["tools", "agents/query", "execution"]
      .flatMap(productionTypeScriptFiles);

    const violations = files.filter((file) => /\bctx\.workspaceRoot\b/.test(source(file)));
    expect(violations, `ctx.workspaceRoot hides Session cwd semantics:\n${violations.join("\n")}`).toEqual([]);
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
    expect(promptTypes).not.toMatch(/interface PromptContext\s*\{[^}]*\bworkspaceRoot:\s*string/);
    expect(promptTypes).toMatch(/interface PromptEnv\s*\{[^}]*\bprojectRoot:\s*string/);
    expect(promptTypes).toMatch(/interface PromptEnv\s*\{[^}]*\bcwd:\s*string/);
  });
});
