import { afterAll, describe, expect, it, mock } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { EXPLORER_READ_ONLY_TOOLS, DELEGATION_EXECUTION_TOOLS } from "../tools/groups";
import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { MemoryFileManager } from "../memory/file-manager";
import type { ProjectContext } from "../projects/types";
import { SkillService } from "../skills";
import { storeManager } from "../store/store";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import { createMemoryReadTool } from "../tools/builtins/memory-read";
import { createMemoryWriteTool } from "../tools/builtins/memory-write";
import type { AuditEvent } from "../tools/hooks";
import { createAuditHook, createExecutionLogger, createOutputTruncator, createRedactionHook } from "../tools/hooks";
import { REDACTION_MARKER } from "../tools/security";
import { ToolRegistry } from "../tools/registry";
import { silentLogger, type Logger } from "../logger";
import { createToolExecutionContext, type ToolDescriptor, type ToolExecutionContext } from "../tools/types";
import { ProjectApprovalManager } from "../tools/permission";
import { registerBuiltinTools } from "./register-tools";
import {
  TOOL_GOAL_CREATE,
  TOOL_GOAL_LOCK,
  TOOL_GOAL_RUN,
  TOOL_GOAL_RETRY,
  TOOL_GOAL_CHECK_DONE,
  TOOL_ASK_USER,
  TOOL_BASH,
} from "@archcode/protocol";

const tmpRoots: string[] = [];
const testSkillService = new SkillService({ builtinSkills: {} });

afterAll(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function createTmpRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `archcode-${prefix}-`));
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
  return createToolExecutionContext({ store: storeManager.create(`register-tools-${crypto.randomUUID()}`), storeManager, toolName,
  toolCallId: `${toolName}-call`,
  input,
  step: 0,
  abort: new AbortController().signal,
  startedAt: 0,
  allowedTools: new Set(allowedTools),
  agentSkills: [],
  skillService: testSkillService,
  projectContext,
  ...overrides, });
}

function makeProjectContext(workspaceRoot: string): ProjectContext {
  return {
    project: { slug: "register-tools", name: "Register Tools", workspaceRoot, addedAt: new Date().toISOString() },
    goalState: new GoalStateManager(workspaceRoot),
    hitl: new HitlService(),
    memory: new MemoryFileManager({
      project: join(workspaceRoot, ".archcode", "memory"),
      user: join(workspaceRoot, ".archcode", "user-memory"),
    }),
    approvals: new ProjectApprovalManager(silentLogger),
  };
}

function makeLogger(): Logger & { debug: ReturnType<typeof mock> } {
  const logger: Logger & { debug: ReturnType<typeof mock> } = {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: () => logger,
  };
  return {
    ...logger,
  };
}

describe("registerBuiltinTools", () => {
  it("registers all 24 builtins including 4 LSP and 2 ast-grep tools", () => {
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
      "cancel_session",
      "skill_list",
      "skill_read",
      "view_tool_output",
    ]);
  });

  it("registers global after hooks in redaction, truncation, audit, logger order", () => {
    const registry = new ToolRegistry();

    registerBuiltinTools(registry, silentLogger);

    expect(registry.globalHooks.after.map((hook) => hook.name)).toEqual([
      "redactionAfterHook",
      "truncationAfterHook",
      "auditAfterHook",
      "executionLoggerAfterHook",
    ]);
  });

  it("does not register legacy workflow or artifact tools", () => {
    const registry = new ToolRegistry();

    registerBuiltinTools(registry, silentLogger);

    expect(registry.get("workflow_create")).toBeUndefined();
    expect(registry.get("workflow_read")).toBeUndefined();
    expect(registry.get("workflow_update_stage")).toBeUndefined();
    expect(registry.get("workflow_propose_interactions")).toBeUndefined();
    expect(registry.get("workflow_request_interactions")).toBeUndefined();
    expect(registry.get("workflow_task_check")).toBeUndefined();
    expect(registry.get("artifact_read")).toBeUndefined();
    expect(registry.get("artifact_write")).toBeUndefined();
  });

  it("blocks effectful tools in Goal main sessions until the Goal is claimed", async () => {
    const workspaceRoot = await createTmpRoot("goal-bootstrap-guard");
    const projectContext = makeProjectContext(workspaceRoot);
    const goal = await projectContext.goalState.create(
      projectContext.project.slug,
      "Bootstrap guard",
      "architect",
      [{ id: "artifact", kind: "file_exists", params: { path: "artifact.txt" } }],
      { maxRetries: 1, backoffMs: 100, escalateOnFailure: true },
      [],
    );
    await projectContext.goalState.lock(goal.id, "architect");
    const store = storeManager.create("goal-bootstrap-main-session", workspaceRoot);
    store.getState().setGoalId(goal.id);
    store.getState().setSessionRole("main");
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, silentLogger);
    const bashInput = { description: "Print cwd", command: "pwd" };

    const denied = await registry.execute(
      { toolName: TOOL_BASH, toolCallId: "bash-before-claim", input: bashInput },
      makeContext(TOOL_BASH, [TOOL_BASH], workspaceRoot, {
        store,
        projectContext,
        input: bashInput,
        toolCallId: "bash-before-claim",
      }),
    );
    const claimed = await registry.execute(
      { toolName: TOOL_GOAL_RUN, toolCallId: "goal-run-claim", input: { goalId: goal.id } },
      makeContext(TOOL_GOAL_RUN, [TOOL_GOAL_RUN], workspaceRoot, {
        store,
        projectContext,
        input: { goalId: goal.id },
        toolCallId: "goal-run-claim",
      }),
    );
    const allowed = await registry.execute(
      { toolName: TOOL_BASH, toolCallId: "bash-after-claim", input: bashInput },
      makeContext(TOOL_BASH, [TOOL_BASH], workspaceRoot, {
        store,
        projectContext,
        input: bashInput,
        toolCallId: "bash-after-claim",
      }),
    );

    expect(denied.isError).toBe(true);
    expect(denied.meta?.permissionErrorCode).toBe("GOAL_BOOTSTRAP_TOOL_DENIED");
    expect(claimed.isError).toBe(false);
    expect(allowed.isError).toBe(false);
    expect(allowed.output).toContain("EXIT_CODE: 0");
  });

  it("allowedTools permits and denies each Tier 2 tool through runtime registry checks", async () => {
    const workspaceRoot = await createTmpRoot("tier2-allowed");
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, silentLogger);
    registry.globalHooks.after.pop();

    const cases = [
      {
        name: "bash",
        input: { description: "Print working directory", command: "pwd" },
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

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const loggerMeta = (logger.debug.mock.calls[0][1] as { meta: Record<string, unknown> }).meta;
    expect(loggerMeta).toMatchObject({
      toolName: fakeTool.name,
      toolCallId: "fake-secret-call",
      isError: false,
      outputSize: result.output.length,
    });
    expect("input" in loggerMeta).toBe(false);
    expect("redactedInput" in loggerMeta).toBe(false);
    expect("output" in loggerMeta).toBe(false);
    expect("rawOutput" in loggerMeta).toBe(false);
    expect(JSON.stringify(loggerMeta)).not.toContain(rawSecret);
  });

  it("existing Tier 1 builtins still register and execute", async () => {
    const workspaceRoot = await createTmpRoot("tier1-execute");
    const samplePath = join(workspaceRoot, "sample.txt");
    await Bun.write(samplePath, "hello tier1\n");

    const registry = new ToolRegistry();
    registerBuiltinTools(registry, silentLogger);
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

      registerBuiltinTools(registry, silentLogger);

      expect(registry.get("memory_read")).toBeDefined();
      expect(registry.get("memory_write")).toBeDefined();
    });
  });

  describe("memory index permission", () => {
    it("memory index permission denies writes to .archcode/memory/index.md", async () => {
      const workspaceRoot = await createTmpRoot("perm-deny");
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, silentLogger);
      registry.globalHooks.after.pop();

      const result = await registry.execute(
        {
          toolName: "file_write",
          toolCallId: "perm-test",
          input: { path: ".archcode/memory/index.md", content: "hacked" },
        },
        makeContext("file_write", ["file_write"], workspaceRoot, {
          toolCallId: "perm-test",
          input: { path: ".archcode/memory/index.md", content: "hacked" },
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("PROTECTED_PATH_WRITE_DENIED");
    });

    it("memory index permission allows writes to non-index files", async () => {
      const workspaceRoot = await createTmpRoot("perm-allow");
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, silentLogger);
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
      registerBuiltinTools(registry, silentLogger);
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

  describe("protected .archcode mutation permissions", () => {
    it("bash denies commands that reference .archcode paths", async () => {
      const workspaceRoot = await createTmpRoot("bash-archcode-deny");
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, silentLogger);
      registry.globalHooks.after.pop();

      const result = await registry.execute(
        {
          toolName: "bash",
          toolCallId: "bash-archcode-deny",
          input: {
            description: "Attempt scripted write to .archcode",
            command: "python3 -c \"open('.archcode/workflows/wf/TASKS.md','w').write('---')\"",
          },
        },
        makeContext("bash", ["bash"], workspaceRoot, {
          toolCallId: "bash-archcode-deny",
          input: {
            description: "Attempt scripted write to .archcode",
            command: "python3 -c \"open('.archcode/workflows/wf/TASKS.md','w').write('---')\"",
          },
          confirmPermission: async () => "approve" as const,
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("PROTECTED_PATH_WRITE_DENIED");
    });
  });

  describe("EXPLORER_READ_ONLY_TOOLS trait integrity", () => {
    it("each listed tool has traits.readOnly === true", () => {
      // Build the same set of descriptors that registerBuiltinTools produces
      const descriptors = [
        ...createBuiltinToolDescriptors(),
        createMemoryReadTool(),
        createMemoryWriteTool(),
      ];
      const toolMap = new Map(descriptors.map((d) => [d.name, d]));
      const errors: string[] = [];

      for (const toolName of EXPLORER_READ_ONLY_TOOLS) {
        const descriptor = toolMap.get(toolName);
        expect(descriptor, `${toolName} should exist in registered descriptors`).toBeDefined();
        if (descriptor && !descriptor.traits.readOnly) {
          errors.push(`${toolName}: readOnly=${descriptor.traits.readOnly}`);
        }
      }
      expect(errors).toEqual([]);
    });
  });

  describe("DELEGATION_EXECUTION_TOOLS", () => {
    it("includes exactly delegate, background_output, wait_for_reminder, view_tool_output, cancel_session", () => {
      expect(DELEGATION_EXECUTION_TOOLS).toEqual([
        "delegate",
        "background_output",
        "wait_for_reminder",
        "view_tool_output",
        "cancel_session",
      ]);
    });
  });

  describe("Goal/HITL tool contract", () => {
    it("goal tool constants resolve to correct string values", () => {
      expect(TOOL_GOAL_CREATE).toBe("goal_create");
      expect(TOOL_GOAL_LOCK).toBe("goal_lock");
      expect(TOOL_GOAL_RUN).toBe("goal_run");
      expect(TOOL_GOAL_RETRY).toBe("goal_retry");
      expect(TOOL_GOAL_CHECK_DONE).toBe("goal_check_done");
    });

    it("all goal tool names follow goal_* prefix convention", () => {
      const goalNames = [
        TOOL_GOAL_CREATE,
        TOOL_GOAL_LOCK,
        TOOL_GOAL_RUN,
        TOOL_GOAL_RETRY,
        TOOL_GOAL_CHECK_DONE,
      ];
      for (const name of goalNames) {
        expect(name).toMatch(/^goal_/);
      }
    });

    it("ask_user is registered as the agent-facing question tool", () => {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, silentLogger);

      const tool = registry.get(TOOL_ASK_USER);
      expect(tool).toBeDefined();
      expect(tool!.name).toBe("ask_user");
    });

    it("no human_check tool is registered (HITL uses ask_user in Phase 1)", () => {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, silentLogger);

      const tool = registry.get("human_check");
      expect(tool).toBeUndefined();
    });

    it("no human_check tool exists in any builtin descriptor", () => {
      const descriptors = createBuiltinToolDescriptors();
      const names = descriptors.map((d) => d.name);
      expect(names).not.toContain("human_check");
    });

    it("ask_user is not replaced by human_check — agent questions flow through existing tool", () => {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, silentLogger);

      const askUserTool = registry.get(TOOL_ASK_USER);
      expect(askUserTool).toBeDefined();
      expect(askUserTool!.name).toBe("ask_user");

      const humanCheckTool = registry.get("human_check");
      expect(humanCheckTool).toBeUndefined();
    });
  });
});
