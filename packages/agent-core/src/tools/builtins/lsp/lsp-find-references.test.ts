import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { storeManager } from "../../../store/store";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { createMockStore } from "../../../store/test-helpers";
import { inferToolErrorKindFromResult } from "../../errors";
import { createTestToolRegistryFixture } from "../../test-registry";
import { expectBlockedRequest } from "../../test-results";
import type { RawToolResult, ToolExecutionContext } from "../../types";
import { lspFindReferencesTool } from "./lsp-find-references";
import { createDurableTestSessionContext, createTestProjectContext } from "../../test-project-context";

const testDir = path.join(tmpdir(), "archcode-lsp-find-references", crypto.randomUUID());
const registryFixture = createTestToolRegistryFixture({ descriptors: [lspFindReferencesTool] });

beforeEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await registryFixture.dispose();
  await rm(testDir, { recursive: true, force: true });
});

describe("lspFindReferencesTool", () => {
  test("exports descriptor with correct traits, permissions, and schema", () => {
    expect(lspFindReferencesTool.name).toBe("lsp_find_references");
    expect(lspFindReferencesTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(lspFindReferencesTool.permissions).toHaveLength(1);
    expect(lspFindReferencesTool.inputSchema).toBeDefined();
    expect(lspFindReferencesTool.inputSchema.safeParse({ filePath: "src/main.ts", line: 1, character: 0 }).success).toBe(true);
    expect(lspFindReferencesTool.inputSchema.safeParse({ filePath: "src/main.ts", line: 1, character: 0, extra: true }).success).toBe(false);
  });

  test("workspace permission asks for ../ traversal through registry", async () => {
    const durable = await createDurableTestSessionContext(testDir, crypto.randomUUID());
    const ctx = makeCtx({
      toolName: "lsp_find_references",
      toolCallId: "call-1",
      agentName: "lead",
      agentSkills: [],
      input: { filePath: "../outside.ts", line: 1, character: 0 },
      ...durable,
    });

    const result = await registryFixture.registry.execute(
        { toolName: "lsp_find_references", toolCallId: "call-1", input: { filePath: "../outside.ts", line: 1, character: 0 } },
        ctx,
      );
    expect(expectBlockedRequest(result).source).toEqual({ type: "tool_permission", toolCallId: "call-1", toolName: "lsp_find_references" });
  });

  test("returns lsp-server-not-found for unsupported extension", async () => {
    await writeWorkspaceFile("notes.unknownext", "hello\n");

    const result = await lspFindReferencesTool.execute(
      { filePath: "notes.unknownext", line: 1, character: 0 },
      makeCtx(),
    ) as RawToolResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("lsp-server-not-found");
    expect(result.draft.kind === "text" ? result.draft.text : "").toContain("No language mapping found");
  });
});

async function writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(testDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: createMockStore(),
  toolName: "lsp_find_references",
  toolCallId: "call-1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["lsp_find_references"]),
  cwd: testDir,
  storeManager,
    projectContext: createTestProjectContext(testDir), ...overrides,  };
}
