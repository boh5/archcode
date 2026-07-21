import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { storeManager } from "../../../store/store";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { LspError, setLspClientPoolForTest, type LspClient, type LspClientPool } from "../../../lsp";
import { createMockStore } from "../../../store/test-helpers";
import { inferToolErrorKindFromResult } from "../../errors";
import { createTestToolRegistryFixture } from "../../test-registry";
import { expectBlockedRequest, expectTextDraft } from "../../test-results";
import type { RawToolResult, ToolExecutionContext } from "../../types";
import { lspDiagnosticsTool } from "./lsp-diagnostics";
import { createDurableTestSessionContext, createTestProjectContext } from "../../test-project-context";

const testRoot = path.join(tmpdir(), `archcode-lsp-diagnostics-unit-${crypto.randomUUID()}`);
const testDir = path.join(testRoot, "workspace");
const canonicalProjectDir = path.join(testRoot, "project");
const registryFixture = createTestToolRegistryFixture({ descriptors: [lspDiagnosticsTool] });

beforeEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
  await Promise.all([
    mkdir(testDir, { recursive: true }),
    mkdir(canonicalProjectDir, { recursive: true }),
  ]);
});

afterEach(() => {
  setLspClientPoolForTest(undefined);
});

afterAll(async () => {
  await registryFixture.dispose();
  await rm(testRoot, { recursive: true, force: true });
});

describe("lspDiagnosticsTool", () => {
  test("exports descriptor with correct traits, permissions, and schema", () => {
    expect(lspDiagnosticsTool.name).toBe("lsp_diagnostics");
    expect(lspDiagnosticsTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(lspDiagnosticsTool.permissions).toHaveLength(1);
    expect(lspDiagnosticsTool.inputSchema).toBeDefined();
    expect(lspDiagnosticsTool.inputSchema.safeParse({ filePath: "src/main.ts" }).success).toBe(true);
    expect(lspDiagnosticsTool.inputSchema.safeParse({ filePath: "src/main.ts", extra: true }).success).toBe(false);
  });

  test("returns lsp-timeout error with stale diagnostics on timeout", async () => {
    await writeWorkspaceFile("timeout.ts", "const ok = true;\n");
    setLspClientPoolForTest(new TimedOutPool() as unknown as LspClientPool);

    const result = await lspDiagnosticsTool.execute({ filePath: "timeout.ts" }, makeCtx()) as RawToolResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("lsp-timeout");
    expect(result.draft.kind === "text" ? result.draft.text : "").toContain("Diagnostics timed out after 10000ms; showing last known diagnostics.");
    expect(result.details?.error?.code).toBe("TOOL_LSP_TIMEOUT");
  });

  test("returns lsp-server-not-found for unsupported extension", async () => {
    await writeWorkspaceFile("notes.unknownext", "hello\n");

    const result = await lspDiagnosticsTool.execute({ filePath: "notes.unknownext" }, makeCtx()) as RawToolResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("lsp-server-not-found");
    expect(result.draft.kind === "text" ? result.draft.text : "").toContain("No language mapping found");
  });

  test("returns lsp-server-not-found when no server definition supports the mapped language", async () => {
    await writeWorkspaceFile("notes.md", "# Title\n");

    const result = await lspDiagnosticsTool.execute({ filePath: "notes.md" }, makeCtx()) as RawToolResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("lsp-server-not-found");
    const payload = JSON.parse(expectTextDraft(result)) as { message: string };
    expect(payload.message).toContain(
      'No language server is available for language "markdown"',
    );
  });

  test("workspace permission asks for ../ traversal through registry", async () => {
    const durable = await createDurableTestSessionContext(canonicalProjectDir, crypto.randomUUID(), testDir);
    const ctx = makeCtx({
      toolName: "lsp_diagnostics",
      toolCallId: "call-1",
      agentName: "lead",
      agentSkills: [],
      input: { filePath: "../outside.ts" },
      ...durable,
    });

    const result = await registryFixture.registry.execute(
        { toolName: "lsp_diagnostics", toolCallId: "call-1", input: { filePath: "../outside.ts" } },
        ctx,
      );
    expect(expectBlockedRequest(result).source).toEqual({ type: "tool_permission", toolCallId: "call-1", toolName: "lsp_diagnostics" });
  });
});

async function writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(testDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: createMockStore(),
    toolName: "lsp_diagnostics",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["lsp_diagnostics"]),
    cwd: testDir,
    storeManager,
    projectContext: createTestProjectContext(canonicalProjectDir),
    ...overrides,
  };
}

class TimedOutPool {
  async acquire(): Promise<LspClient> {
    return new TimedOutClient() as unknown as LspClient;
  }

  release(): void {}
}

class TimedOutClient {
  openTextDocument(): { release(): void } {
    return { release() {} };
  }

  getDiagnosticsSnapshot(): undefined {
    return undefined;
  }

  async waitForDiagnostics(_uri: string, options: { timeoutMs: number }): Promise<never> {
    throw new LspError({
      code: 0,
      kind: "lsp-timeout",
      message: `LSP diagnostics timed out after ${options.timeoutMs}ms. Check whether the language server is responsive and retry.`,
    });
  }
}
