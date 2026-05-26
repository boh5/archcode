import { afterAll, describe, expect, it, mock } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { EXPLORER_READ_ONLY_TOOLS, DELEGATION_EXECUTION_TOOLS } from "../tools/groups";
import { WorkflowArtifactManager } from "../agents/workflow/artifacts";
import { WorkflowStateManager } from "../agents/workflow/state";
import { MemoryFileManager } from "../memory/file-manager";
import type { ProjectContext } from "../projects/types";
import { SkillService } from "../skills";
import { storeManager } from "../store/store";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import type { AuditEvent } from "../tools/hooks";
import { createAuditHook, createExecutionLogger, createOutputTruncator, createRedactionHook } from "../tools/hooks";
import { REDACTION_MARKER } from "../tools/security";
import { ToolRegistry } from "../tools/registry";
import { createToolExecutionContext, type Logger, type ToolDescriptor, type ToolExecutionContext } from "../tools/types";
import { ProjectApprovalManager } from "../tools/permission";
import { registerBuiltinTools } from "./register-tools";

const tmpRoots: string[] = [];
const testSkillService = new SkillService({ builtinSkills: {} });

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
  const projectContext = overrides.projectContext ?? makeProjectContext(workspaceRoot);
  return createToolExecutionContext({
    store: storeManager.create(`register-tools-${crypto.randomUUID()}`),
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(allowedTools),
    agentSkills: [],
    skillService: testSkillService,
    projectContext,
    ...overrides,
  });
}

function makeProjectContext(workspaceRoot: string): ProjectContext {
  const workflowState = new WorkflowStateManager(workspaceRoot);
  return {
    project: { slug: "register-tools", name: "Register Tools", workspaceRoot, addedAt: new Date().toISOString() },
    workflowState,
    memory: new MemoryFileManager({
      project: join(workspaceRoot, ".specra", "memory"),
      user: join(workspaceRoot, ".specra", "user-memory"),
    }),
    approvals: new ProjectApprovalManager(),
    artifacts: new WorkflowArtifactManager(workspaceRoot, workflowState),
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
  it("registers all 23 builtins including 4 LSP and 2 ast-grep tools", () => {
    const descriptors = createBuiltinToolDescriptors();
    const names = descriptors.map((descriptor) => descriptor.name);

    expect(names).toEqual([
      "file_read",
      "file_write",
      "file_edit",
      "grep",
      "glob",
      "ast_grep_search",
      "ast_grep_replace",
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
      "skill_list",
      "skill_read",
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

  describe("memory index permission", () => {
    it("memory index permission denies writes to .specra/memory/index.md", async () => {
      const workspaceRoot = await createTmpRoot("perm-deny");
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      registry.globalHooks.after.pop();

      const result = await registry.execute(
        {
          toolName: "file_write",
          toolCallId: "perm-test",
          input: { path: ".specra/memory/index.md", content: "hacked" },
        },
        makeContext("file_write", ["file_write"], workspaceRoot, {
          toolCallId: "perm-test",
          input: { path: ".specra/memory/index.md", content: "hacked" },
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("SPECRA_PROTECTED_PATH_WRITE_DENIED");
    });

    it("memory index permission allows writes to non-index files", async () => {
      const workspaceRoot = await createTmpRoot("perm-allow");
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      registry.globalHooks.after.pop();

      const result = await registry.execute(
        {
          toolName: "file_write",
          toolCallId: "perm-allow",
          input: { path: "regular-file.txt", content: "hello" },
        },
        makeContext("file_write", ["file_write"], workspaceRoot, {
          toolCallId: "perm-allow",
          input: { path: "regular-file.txt", content: "hello" },
          confirmPermission: async () => "approve" as const,
        }),
      );

      expect(result.isError).toBe(false);
    });

    it("memory index permission does not block read-only tools", async () => {
      const workspaceRoot = await createTmpRoot("perm-readonly");
      const samplePath = join(workspaceRoot, "sample.txt");
      await Bun.write(samplePath, "hello permission\n");

      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      registry.globalHooks.after.pop();

      const result = await registry.execute(
        {
          toolName: "file_read",
          toolCallId: "perm-readonly",
          input: { path: samplePath },
        },
        makeContext("file_read", ["file_read"], workspaceRoot, {
          toolCallId: "perm-readonly",
          input: { path: samplePath },
        }),
      );

      expect(result.isError).toBe(false);
    });
  });

  describe("EXPLORER_READ_ONLY_TOOLS trait integrity", () => {
    it("each listed tool has traits.readOnly === true", () => {
      const descriptors = createBuiltinToolDescriptors();
      const toolMap = new Map(descriptors.map((d) => [d.name, d]));
      const errors: string[] = [];

      for (const toolName of EXPLORER_READ_ONLY_TOOLS) {
        const descriptor = toolMap.get(toolName);
        expect(descriptor, `${toolName} should exist in builtin descriptors`).toBeDefined();
        if (descriptor && !descriptor.traits.readOnly) {
          errors.push(`${toolName}: readOnly=${descriptor.traits.readOnly}`);
        }
      }
      expect(errors).toEqual([]);
    });
  });

  describe("DELEGATION_EXECUTION_TOOLS", () => {
    it("includes exactly delegate, background_output, wait_for_reminder, view_tool_output", () => {
      expect(DELEGATION_EXECUTION_TOOLS).toEqual([
        "delegate",
        "background_output",
        "wait_for_reminder",
        "view_tool_output",
      ]);
    });
  });
});
