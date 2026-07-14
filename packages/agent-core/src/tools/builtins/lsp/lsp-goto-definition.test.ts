import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { storeManager } from "../../../store/store";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { createMockStore } from "../../../store/test-helpers";
import { inferToolErrorKindFromResult } from "../../errors";
import { ToolRegistry } from "../../registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import { lspGotoDefinitionTool } from "./lsp-goto-definition";
import { createDurableTestSessionContext, createTestProjectContext } from "../../test-project-context";
import { SessionHitlPause } from "../../../execution/session-hitl-pause";

const testDir = path.join(import.meta.dir, "__test_tmp__", "lsp-goto-definition", crypto.randomUUID());

beforeEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("lspGotoDefinitionTool", () => {
  test("exports descriptor with correct traits, permissions, and schema", () => {
    expect(lspGotoDefinitionTool.name).toBe("lsp_goto_definition");
    expect(lspGotoDefinitionTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(lspGotoDefinitionTool.permissions).toHaveLength(1);
    expect(lspGotoDefinitionTool.inputSchema.safeParse({ filePath: "src/main.ts", line: 1, character: 0 }).success).toBe(true);
    expect(lspGotoDefinitionTool.inputSchema.safeParse({ filePath: "src/main.ts", line: 1, character: 0, extra: true }).success).toBe(false);
  });

  test("workspace permission asks for traversal through registry and pauses for durable Session HITL", async () => {
    const registry = new ToolRegistry();
    registry.register(lspGotoDefinitionTool);
    const sessionId = crypto.randomUUID();
    const durable = await createDurableTestSessionContext(testDir, sessionId);
    const ctx = makeCtx({
      toolName: "lsp_goto_definition",
      toolCallId: "call-1",
      agentName: "engineer",
      agentSkills: [],
      input: { filePath: "../outside.ts", line: 1, character: 0 },
      ...durable,
    });

    try {
      await registry.execute(
        { toolName: "lsp_goto_definition", toolCallId: "call-1", input: { filePath: "../outside.ts", line: 1, character: 0 } },
        ctx,
      );
      throw new Error("Expected LSP traversal permission to pause for Session HITL");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionHitlPause);
      if (!(error instanceof SessionHitlPause)) throw error;
      expect(error.record.source).toEqual({ type: "tool_permission", sessionId, toolCallId: "call-1", toolName: "lsp_goto_definition" });
    }
  });

  test("returns lsp-server-not-found for unsupported extension", async () => {
    await writeWorkspaceFile("notes.unknownext", "hello\n");

    const result = await lspGotoDefinitionTool.execute({ filePath: "notes.unknownext", line: 1, character: 0 }, makeCtx()) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("lsp-server-not-found");
    expect(result.output).toContain("No language mapping found");
  });
});

async function writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(testDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: createMockStore(),
  toolName: "lsp_goto_definition",
  toolCallId: "call-1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["lsp_goto_definition"]),
  cwd: testDir,
  storeManager,
    projectContext: createTestProjectContext(testDir), ...overrides,  };
}
