import { afterAll, describe, expect, it, mock } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { EXPLORER_READ_ONLY_TOOLS, DELEGATION_EXECUTION_TOOLS } from "../tools/groups";
import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { LoopStateManager } from "../loops/state";
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
  TOOL_GOAL_MANAGE,
  TOOL_ASK_USER,
  TOOL_BASH,
  TOOL_TODO_WRITE,
  TOOL_GITHUB_CREATE_ISSUE_COMMENT,
  TOOL_GITHUB_GET_PULL_REQUEST,
  TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
  TOOL_GITHUB_GET_WORKFLOW_RUN,
  TOOL_GITHUB_LIST_ISSUE_COMMENTS,
  TOOL_GITHUB_LIST_PULL_REQUESTS,
  TOOL_GITHUB_LIST_WORKFLOW_RUNS,
  TOOL_GITHUB_RERUN_WORKFLOW_RUN,
  TOOL_COMPRESS,
  TOOL_WORKTREE_ENTER,
  TOOL_WORKTREE_EXIT,
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
  return createToolExecutionContext({
    store: storeManager.create(`register-tools-${crypto.randomUUID()}`),
    storeManager,
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
    cwd: overrides.cwd ?? workspaceRoot,
  });
}

function makeProjectContext(workspaceRoot: string): ProjectContext {
  return {
    project: { slug: "register-tools", name: "Register Tools", workspaceRoot, addedAt: new Date().toISOString() },
    goalState: new GoalStateManager(workspaceRoot),
    loopState: new LoopStateManager(workspaceRoot),
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
  it("registers all 27 builtins including dynamic Session worktree transitions", () => {
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
      TOOL_COMPRESS,
      TOOL_WORKTREE_ENTER,
      TOOL_WORKTREE_EXIT,
    ]);
  });

  it("registers redaction before truncation, audit, and logger after hooks", () => {
    const registry = new ToolRegistry();

    registerBuiltinTools(registry, silentLogger);

    expect(registry.globalHooks.after.map((hook) => hook.name)).toEqual([
      "redactionAfterHook",
      "truncationAfterHook",
      "auditAfterHook",
      "executionLoggerAfterHook",
    ]);
  });

  it("registers only Loop lifecycle policies as global permissions", () => {
    const registry = new ToolRegistry();

    registerBuiltinTools(registry, silentLogger);

    expect(registry.globalPermissions).toHaveLength(1);
    expect(registry.globalPermissions.map((permission) => permission.name)).not.toContain("loopCollisionToolPermission");
    expect(registry.globalHooks.after.map((hook) => hook.name)).not.toContain("collisionReleaseAfterHook");
  });

  it("registers GitHub connector-backed tools without adding them to builtin descriptor groups", () => {
    const registry = new ToolRegistry();

    registerBuiltinTools(registry, silentLogger);

    for (const toolName of [
      TOOL_GITHUB_GET_PULL_REQUEST,
      TOOL_GITHUB_LIST_PULL_REQUESTS,
      TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
      TOOL_GITHUB_LIST_ISSUE_COMMENTS,
      TOOL_GITHUB_CREATE_ISSUE_COMMENT,
      TOOL_GITHUB_LIST_WORKFLOW_RUNS,
      TOOL_GITHUB_GET_WORKFLOW_RUN,
      TOOL_GITHUB_RERUN_WORKFLOW_RUN,
    ]) {
      expect(registry.get(toolName)).toBeDefined();
      expect(createBuiltinToolDescriptors().map((descriptor) => descriptor.name)).not.toContain(toolName);
    }
    expect(registry.get(TOOL_GITHUB_CREATE_ISSUE_COMMENT)?.traits.readOnly).toBe(false);
    expect(registry.get(TOOL_GITHUB_RERUN_WORKFLOW_RUN)?.traits.readOnly).toBe(false);
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

  it("registers only the active Goal tool surface", () => {
    const registry = new ToolRegistry();

    registerBuiltinTools(registry, silentLogger);

    expect(registry.get(TOOL_GOAL_MANAGE)).toBeDefined();

    for (const oldName of ["goal_create", "goal_lock", "goal_run", "goal_retry", "goal_check_done", "goal_evidence", "goal_artifact_read", "goal_artifact_write"]) {
      expect(registry.get(oldName)).toBeUndefined();
    }
  });

  it("does not gate ordinary tools based on Goal lifecycle state", async () => {
    const workspaceRoot = await createTmpRoot("goal-main-tools");
    const projectContext = makeProjectContext(workspaceRoot);
    const goal = await projectContext.goalState.create({
      projectId: projectContext.project.slug,
      objective: "Verify Goal lifecycle does not govern unrelated tool execution.",
      acceptanceCriteria: "Agent/tool permissions decide ordinary tool availability.",
    });
    const store = storeManager.create("goal-main-tools-session", workspaceRoot);
    store.getState().setGoalId(goal.id);
    store.getState().setSessionRole("main");
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, silentLogger);
    const bashInput = { description: "Print cwd", command: "pwd" };

    const result = await registry.execute(
      { toolName: TOOL_BASH, toolCallId: "bash-in-goal-main-session", input: bashInput },
      makeContext(TOOL_BASH, [TOOL_BASH], workspaceRoot, {
        store,
        projectContext,
        input: bashInput,
        toolCallId: "bash-in-goal-main-session",
      }),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("EXIT_CODE: 0");
    const unchangedGoal = await projectContext.goalState.read(goal.id);
    expect(unchangedGoal.status).toBe("draft");
  });

  it("allows todo_write cleanup while a Goal is reviewing or done", async () => {
    const workspaceRoot = await createTmpRoot("goal-todo-cleanup");
    const projectContext = makeProjectContext(workspaceRoot);
    const goal = await projectContext.goalState.create({
      projectId: projectContext.project.slug,
      objective: "Verify todo bookkeeping is independent from Goal lifecycle state.",
      acceptanceCriteria: "Todo updates continue to work while a Goal is reviewing and after it is done.",
    });
    const store = storeManager.create("goal-todo-cleanup-session", workspaceRoot);
    store.getState().setGoalId(goal.id);
    store.getState().setSessionRole("main");
    await projectContext.goalState.start(goal.id, { mainSessionId: store.getState().sessionId });
    await projectContext.goalState.beginReview(goal.id);
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, silentLogger);
    const reviewingTodoInput = {
      todos: [{ id: "reviewing-cleanup", content: "Record review cleanup", status: "completed" as const }],
    };

    const duringReview = await registry.execute(
      { toolName: TOOL_TODO_WRITE, toolCallId: "todo-during-review", input: reviewingTodoInput },
      makeContext(TOOL_TODO_WRITE, [TOOL_TODO_WRITE], workspaceRoot, {
        store,
        projectContext,
        input: reviewingTodoInput,
        toolCallId: "todo-during-review",
      }),
    );
    await projectContext.goalState.finalizeReview(goal.id, {
      verdict: "DONE",
      summary: "Verified todo cleanup after review.",
      evidenceRefs: [{ kind: "test_output", ref: "register-tools.test.ts", summary: "Todo cleanup regression passed." }],
      authorization: {
        agentName: "reviewer",
        sessionRole: "review",
        sessionGoalId: goal.id,
        reviewerSessionId: "review-session",
      },
    });
    const doneTodoInput = {
      todos: [{ id: "done-cleanup", content: "Record terminal cleanup", status: "completed" as const }],
    };
    const afterDone = await registry.execute(
      { toolName: TOOL_TODO_WRITE, toolCallId: "todo-after-done", input: doneTodoInput },
      makeContext(TOOL_TODO_WRITE, [TOOL_TODO_WRITE], workspaceRoot, {
        store,
        projectContext,
        input: doneTodoInput,
        toolCallId: "todo-after-done",
      }),
    );

    expect(duringReview.isError).toBe(false);
    expect(duringReview.output).toContain("Todos updated");
    expect(afterDone.isError).toBe(false);
    expect(afterDone.output).toContain("Todos updated");
    expect(store.getState().todos).toEqual([
      { id: "done-cleanup", content: "Record terminal cleanup", status: "completed" },
    ]);
    const terminalGoal = await projectContext.goalState.read(goal.id);
    expect(terminalGoal.status).toBe("done");
  });

  it("treats old Goal executable names as unknown tools", async () => {
    const workspaceRoot = await createTmpRoot("old-goal-unknown");
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, silentLogger);

    for (const oldName of ["goal_create", "goal_lock", "goal_run", "goal_retry", "goal_check_done"]) {
      const result = await registry.execute(
        { toolName: oldName, toolCallId: `${oldName}-unknown`, input: {} },
        makeContext(oldName, [oldName], workspaceRoot, {
          input: {},
          toolCallId: `${oldName}-unknown`,
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("TOOL_UNKNOWN");
    }
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
            command: "python3 -c \"open('.archcode/goals/goal_test/goal.json','w').write('---')\"",
          },
        },
        makeContext("bash", ["bash"], workspaceRoot, {
          toolCallId: "bash-archcode-deny",
          input: {
            description: "Attempt scripted write to .archcode",
            command: "python3 -c \"open('.archcode/goals/goal_test/goal.json','w').write('---')\"",
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
      expect(TOOL_GOAL_MANAGE).toBe("goal_manage");
    });

    it("all goal tool names follow goal_* prefix convention", () => {
      const goalNames = [
        TOOL_GOAL_MANAGE,
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

    it("no human_check tool is registered because HITL uses ask_user", () => {
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
