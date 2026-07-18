import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { storeManager } from "../../../store/store";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { createMockStore } from "../../../store/test-helpers";
import { createTestToolRegistryFixture } from "../../test-registry";
import { expectBlockedRequest } from "../../test-results";
import type { ToolExecutionContext } from "../../types";
import { lspSymbolsTool } from "./lsp-symbols";
import { createDurableTestSessionContext, createTestProjectContext } from "../../test-project-context";

const testDir = path.join(tmpdir(), "archcode-lsp-symbols", crypto.randomUUID());
const registryFixture = createTestToolRegistryFixture({ descriptors: [lspSymbolsTool] });

beforeEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await registryFixture.dispose();
  await rm(testDir, { recursive: true, force: true });
});

describe("lspSymbolsTool", () => {
  test("exports descriptor with correct traits, permissions, and schema", () => {
    expect(lspSymbolsTool.name).toBe("lsp_symbols");
    expect(lspSymbolsTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(lspSymbolsTool.permissions).toHaveLength(1);
    expect(lspSymbolsTool.inputSchema.safeParse({ scope: "document", filePath: "src/main.ts" }).success).toBe(true);
    expect(lspSymbolsTool.inputSchema.safeParse({ scope: "workspace", query: "main" }).success).toBe(true);
    expect(lspSymbolsTool.inputSchema.safeParse({ scope: "document" }).success).toBe(false);
    expect(lspSymbolsTool.inputSchema.safeParse({ scope: "workspace" }).success).toBe(false);
    expect(lspSymbolsTool.inputSchema.safeParse({ scope: "workspace", query: "main", extra: true }).success).toBe(false);
  });

  test("schema rejects document scope without filePath", () => {
    const parsed = lspSymbolsTool.inputSchema.safeParse({ scope: "document" });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("filePath is required when scope is 'document'");
    }
  });

  test("schema rejects workspace scope without query", () => {
    const parsed = lspSymbolsTool.inputSchema.safeParse({ scope: "workspace" });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("query is required when scope is 'workspace'");
    }
  });

  test("workspace permission asks for document path outside workspace through registry", async () => {
    const input = { scope: "document", filePath: "../outside.ts" };
    const durable = await createDurableTestSessionContext(testDir, crypto.randomUUID());
    const ctx = makeCtx({ toolName: "lsp_symbols", toolCallId: "call-1", agentName: "engineer", agentSkills: [], input, ...durable });

    const result = await registryFixture.registry.execute(
        { toolName: "lsp_symbols", toolCallId: "call-1", input },
        ctx,
      );
    expect(expectBlockedRequest(result).source).toEqual({ type: "tool_permission", toolCallId: "call-1", toolName: "lsp_symbols" });
  });

});

async function writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(testDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: createMockStore(),
  toolName: "lsp_symbols",
  toolCallId: "call-1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["lsp_symbols"]),
  cwd: testDir,
  storeManager,
    projectContext: createTestProjectContext(testDir), ...overrides,  };
}
