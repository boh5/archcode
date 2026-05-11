import { afterAll, describe, expect, it, mock } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createSessionStore } from "../store/store";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import type { AuditEvent } from "../tools/hooks/audit";
import { createAuditHook } from "../tools/hooks/audit";
import { createExecutionLogger } from "../tools/hooks/logger";
import { REDACTION_MARKER } from "../tools/hooks/redact";
import { createRedactionHook } from "../tools/hooks/redact";
import { createOutputTruncator } from "../tools/hooks/truncate";
import { ToolRegistry } from "../tools/registry";
import type { Logger, ToolDescriptor, ToolExecutionContext } from "../tools/types";
import { registerBuiltinTools } from "./register-tools";

const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function createTmpRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `specra-${prefix}-`));
  tmpRoots.push(root);
  return root;
}

function makeContext(
  toolName: string,
  allowedTools: string[],
  workspaceRoot: string,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  const input = overrides.input ?? {};
  return {
    store: createSessionStore(`register-tools-${crypto.randomUUID()}`),
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(allowedTools),
    workspaceRoot,
    ...overrides,
  };
}

function makeLogger(): Logger & { info: ReturnType<typeof mock> } {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
  };
}

describe("registerBuiltinTools", () => {
  it("registers all 19 builtins including 4 LSP tools", () => {
    const descriptors = createBuiltinToolDescriptors();
    const names = descriptors.map((descriptor) => descriptor.name);

    expect(names).toEqual([
      "file_read",
      "file_write",
      "file_edit",
      "grep",
      "glob",
      "git_status",
      "git_diff",
      "bash",
      "todo_write",
      "ask_user",
      "lsp_diagnostics",
      "lsp_goto_definition",
      "lsp_find_references",
      "lsp_symbols",
      "web_fetch",
      "wait_for_reminder",
      "delegate",
      "background_output",
      "view_tool_output",
    ]);
  });

  it("registers global after hooks in redaction, truncation, audit, logger order", () => {
    const registry = new ToolRegistry();

    registerBuiltinTools(registry);

    expect(registry.globalHooks.after.map((hook) => hook.name)).toEqual([
      "redactionAfterHook",
      "truncationAfterHook",
      "auditAfterHook",
      "executionLoggerAfterHook",
    ]);
  });

  it("allowedTools permits and denies each Tier 2 tool through runtime registry checks", async () => {
    const workspaceRoot = await createTmpRoot("tier2-allowed");
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    registry.globalHooks.after.pop();

    const cases = [
      {
        name: "bash",
        input: { command: "pwd" },
        ctx: { confirmPermission: async () => "approve" as const },
      },
      {
        name: "todo_write",
        input: { todos: [{ content: "wire Tier 2 tools", status: "in_progress" }] },
        ctx: {},
      },
      {
        name: "ask_user",
        input: { questions: [{ question: "Continue?", header: "Confirm", options: [{ label: "Yes", description: "Proceed" }] }] },
        ctx: { askUser: async () => ({ answers: [["Yes"]] }) },
      },
    ] as const;

    for (const testCase of cases) {
      const allowed = await registry.execute(
        {
          toolName: testCase.name,
          toolCallId: `${testCase.name}-allowed`,
          input: testCase.input,
        },
        makeContext(testCase.name, [testCase.name], workspaceRoot, {
          input: testCase.input,
          toolCallId: `${testCase.name}-allowed`,
          ...testCase.ctx,
        }),
      );

      expect(allowed.isError).toBe(false);
      if (testCase.name === "bash") {
        expect(allowed.output).toContain("EXIT_CODE: 0");
      }

      const denied = await registry.execute(
        {
          toolName: testCase.name,
          toolCallId: `${testCase.name}-denied`,
          input: testCase.input,
        },
        makeContext(testCase.name, [], workspaceRoot, {
          input: testCase.input,
          toolCallId: `${testCase.name}-denied`,
          ...testCase.ctx,
        }),
      );

      expect(denied.isError).toBe(true);
      expect(denied.meta?.permissionErrorCode).toBe("TOOL_NOT_ALLOWED");
    }
  });

  it("redacts long secret-bearing output before truncation, audit, and logger", async () => {
    const workspaceRoot = await createTmpRoot("redaction-order");
    const outputDir = join(workspaceRoot, "outputs");
    const rawSecret = "sk_test_1234567890abcdef";
    const longOutput = [
      `token=${rawSecret}`,
      "line 2 safe output",
      "line 3 safe output",
      "line 4 safe output",
      "line 5 safe output",
      `line 6 secret=${rawSecret}`,
    ].join("\n");
    const events: AuditEvent[] = [];
    const logger = makeLogger();
    const registry = new ToolRegistry();
    const fakeTool: ToolDescriptor = {
      name: "fake_secret_output",
      description: "emits long secret-bearing output",
      inputSchema: z.object({ token: z.string() }).strict(),
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      execute: async () => longOutput,
    };

    registry.register(fakeTool);
    registry.globalHooks.after.push(createRedactionHook());
    registry.globalHooks.after.push(
      createOutputTruncator({ outputDir, maxBytes: 40, maxLines: 3 }),
    );
    registry.globalHooks.after.push(createAuditHook({ sink: (event) => { events.push(event); } }));
    registry.globalHooks.after.push(createExecutionLogger(logger));

    const result = await registry.execute(
      {
        toolName: fakeTool.name,
        toolCallId: "fake-secret-call",
        input: { token: rawSecret },
      },
      makeContext(fakeTool.name, [fakeTool.name], workspaceRoot, {
        toolCallId: "fake-secret-call",
        input: { token: rawSecret },
      }),
    );

    expect(result.output).toContain("[Output truncated; full output saved to:");
    expect(result.output).toContain(REDACTION_MARKER);
    expect(result.output).not.toContain(rawSecret);

    const fullOutputPath = result.meta?.fullOutputPath as string;
    const persisted = await Bun.file(fullOutputPath).text();
    expect(persisted).toContain(REDACTION_MARKER);
    expect(persisted).not.toContain(rawSecret);
    expect(JSON.stringify(events)).toContain(REDACTION_MARKER);
    expect(JSON.stringify(events)).not.toContain(rawSecret);

    expect(logger.info).toHaveBeenCalledTimes(1);
    const loggerMeta = logger.info.mock.calls[0][1] as Record<string, unknown>;
    expect(JSON.stringify(loggerMeta)).toContain(REDACTION_MARKER);
    expect(JSON.stringify(loggerMeta)).not.toContain(rawSecret);
  });

  it("existing Tier 1 builtins still register and execute", async () => {
    const workspaceRoot = await createTmpRoot("tier1-execute");
    const samplePath = join(workspaceRoot, "sample.txt");
    await Bun.write(samplePath, "hello tier1\n");

    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    registry.globalHooks.after.pop();

    for (const name of [
      "file_read",
      "file_write",
      "file_edit",
      "grep",
      "glob",
      "git_status",
      "git_diff",
    ]) {
      expect(registry.get(name)).toBeDefined();
    }

    const result = await registry.execute(
      {
        toolName: "file_read",
        toolCallId: "file-read-tier1",
        input: { path: samplePath },
      },
      makeContext("file_read", ["file_read"], workspaceRoot, {
        toolCallId: "file-read-tier1",
        input: { path: samplePath },
      }),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("1: hello tier1");
  });

  describe("memory tools", () => {
    it("registers memory_read and memory_write by default", () => {
      const registry = new ToolRegistry();

      registerBuiltinTools(registry);

      expect(registry.get("memory_read")).toBeDefined();
      expect(registry.get("memory_write")).toBeDefined();
    });
  });

  describe("memory index guard", () => {
    it("adds memory index guard as a global guard", () => {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);

      expect(registry.globalGuards.length).toBeGreaterThanOrEqual(1);
    });

    it("memory index guard denies writes to .specra/memory/index.md", async () => {
      const workspaceRoot = await createTmpRoot("guard-deny");
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      registry.globalHooks.after.pop();

      const result = await registry.execute(
        {
          toolName: "file_write",
          toolCallId: "guard-test",
          input: { path: ".specra/memory/index.md", content: "hacked" },
        },
        makeContext("file_write", ["file_write"], workspaceRoot, {
          toolCallId: "guard-test",
          input: { path: ".specra/memory/index.md", content: "hacked" },
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("MEMORY_INDEX_WRITE_DENIED");
    });

    it("memory index guard allows writes to non-index files", async () => {
      const workspaceRoot = await createTmpRoot("guard-allow");
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      registry.globalHooks.after.pop();

      const result = await registry.execute(
        {
          toolName: "file_write",
          toolCallId: "guard-allow",
          input: { path: "regular-file.txt", content: "hello" },
        },
        makeContext("file_write", ["file_write"], workspaceRoot, {
          toolCallId: "guard-allow",
          input: { path: "regular-file.txt", content: "hello" },
          confirmPermission: async () => "approve" as const,
        }),
      );

      expect(result.isError).toBe(false);
    });

    it("memory index guard does not block read-only tools", async () => {
      const workspaceRoot = await createTmpRoot("guard-readonly");
      const samplePath = join(workspaceRoot, "sample.txt");
      await Bun.write(samplePath, "hello guard\n");

      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      registry.globalHooks.after.pop();

      const result = await registry.execute(
        {
          toolName: "file_read",
          toolCallId: "guard-readonly",
          input: { path: samplePath },
        },
        makeContext("file_read", ["file_read"], workspaceRoot, {
          toolCallId: "guard-readonly",
          input: { path: samplePath },
        }),
      );

      expect(result.isError).toBe(false);
    });
  });
});
