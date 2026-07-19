import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ModelInfo } from "../provider/model";
import type { ExecutionModelBinding } from "../models";
import { SkillNotFoundError, SkillService } from "../skills";
import { storeManager } from "../store/store";
import { __setSessionsDirForTest } from "../store/sessions-dir";
import type { ToolRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { createTextToolResult } from "../tools/results";
import { createTestToolRegistryFixture, type TestToolRegistryFixture } from "../tools/test-registry";
import { worktreeEnterTool, worktreeExitTool } from "../tools/builtins/worktree";
import { DELEGATION_CORE_TOOLS, MAX_SUB_AGENT_DEPTH } from "./constants";
import {
  ConfiguredAgent,
  IneligibleSessionWorktreeToolError,
  UnknownExtraToolError,
} from "./configured-agent";
import { exploreAgentDefinition, engineerAgentDefinition, goalLeadAgentDefinition } from "./definitions";
import type { AgentDefinition } from "./factory-types";
import type { VersionControl } from "../version-control/detector";
import { setLlmAdapterForTest } from "../llm/adapter";
import type { MemoryExtractionConfig } from "../config";
import { silentLogger } from "../logger";
import { GoalStateManager } from "../goals/state";
import { testReviewExecutionFields } from "../goals/test-review-fixture";
import { createTestProjectContextResolver } from "./test-project-context-resolver";
import type { AgentRunOptions } from "./types";

const tmpRoot = join(tmpdir(), "archcode-configured-agent", crypto.randomUUID());
const worktreeRoot = join(tmpdir(), "archcode-configured-agent-worktree", crypto.randomUUID());
const registryFixtures: TestToolRegistryFixture[] = [];
const outputAccessFixture = createTestToolRegistryFixture();

function createTestRegistry(descriptors: AnyToolDescriptor[]): ToolRegistry {
  const fixture = createTestToolRegistryFixture({ descriptors });
  registryFixtures.push(fixture);
  return fixture.registry;
}

function createTestSkillService(): SkillService {
  return new SkillService({ builtinSkills: {} });
}

function createSkillServiceWithToolGrant(): SkillService {
  return new SkillService({
    builtinSkills: {
      "github-skill": [
        "---",
        "name: github-skill",
        "description: GitHub skill",
        "when_to_use: Use for GitHub watching.",
        "allowed_tools: [github_get_pull_request, github_merge_pull_request]",
        "---",
        "This skill can describe GitHub workflows but cannot grant tools.",
      ].join("\n"),
    },
  });
}

class RecordingBackgroundTaskManager {
  readonly dispatched: string[] = [];
  drainCalls = 0;
  cancelAllCalls = 0;
  private readonly completions = new Map<string, number>();

  dispatch(name: string, _task?: () => Promise<void>): void {
    this.dispatched.push(name);
  }

  async drain(): Promise<void> {
    this.drainCalls += 1;
  }

  cancelAll(): void {
    this.cancelAllCalls += 1;
  }

  getLastCompletedAt(name: string): number | undefined {
    return this.completions.get(name);
  }
}

function makeTool(name: string): AnyToolDescriptor {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).strict(),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    execute: () => createTextToolResult(`${name} result`),
  };
}

function makeModelInfo(modelId = "configured"): ModelInfo {
  return new ModelInfo({
    model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
    config: {
      name: `${modelId} Model`,
      limit: { context: 64_000, output: 4_096 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "test",
    providerDisplayName: "Test Provider",
    modelId,
  });
}

function makeBinding(
  modelInfo = makeModelInfo(),
  options: ExecutionModelBinding["options"] = { temperature: 0.3 },
): ExecutionModelBinding {
  return {
    modelInfo,
    options,
    summary: {
      selection: { model: modelInfo.qualifiedId },
      providerId: modelInfo.providerId,
      modelId: modelInfo.modelId,
      providerDisplayName: modelInfo.providerDisplayName,
      modelDisplayName: modelInfo.displayName,
      resolution: "agent_default",
      modelRuntimeRevision: "test-revision",
    },
  };
}

const READ_ONLY_FIXTURE_TOOLS = [
  "file_read", "grep", "glob", "git_status", "git_diff", "ast_grep_search",
  "lsp_diagnostics", "lsp_goto_definition", "lsp_find_references", "lsp_symbols", "web_fetch",
] as const;

function makeToolRegistry() {
  return createTestRegistry([
    makeTool("unknown_tool"),
    ...READ_ONLY_FIXTURE_TOOLS.map(makeTool),
    ...DELEGATION_CORE_TOOLS.map(makeTool),
    makeTool("submit_child_result"),
    makeTool("goal_manage"),
    makeTool("project_todo_update"),
  ]);
}

function setupMockStreamText(text = "ok") {
  const fn = mock((_opts: Record<string, unknown>) => ({
    fullStream: (async function* () {
      yield { type: "text-delta", text };
    })(),
    finishReason: Promise.resolve("stop"),
    text: Promise.resolve(text),
    toolCalls: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
  }));

  setLlmAdapterForTest({ streamText: fn as unknown as typeof import("ai").streamText });
  return fn;
}

function setupToolCallStreamText(toolName: string, input: Record<string, unknown> = {}) {
  let round = 0;
  const fn = mock((_opts: Record<string, unknown>) => {
    round += 1;
    if (round > 1) {
      return {
        fullStream: (async function* () {})(),
        finishReason: Promise.resolve("stop"),
        text: Promise.resolve("done"),
        toolCalls: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      };
    }

    return {
      fullStream: (async function* () {
        yield { type: "tool-call", toolCallId: "tool-call-1", toolName, input };
      })(),
      finishReason: Promise.resolve("tool-calls"),
      text: Promise.resolve(""),
      toolCalls: Promise.resolve([{ toolCallId: "tool-call-1", toolName, input }]),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    };
  });

  setLlmAdapterForTest({ streamText: fn as unknown as typeof import("ai").streamText });
  return fn;
}

function definitionWith(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    ...exploreAgentDefinition,
    ...overrides,
    hooks: {
      ...exploreAgentDefinition.hooks,
      ...overrides.hooks,
    },
  };
}

function createAgent(options: {
  definition: AgentDefinition;
  store?: ReturnType<typeof storeManager.create>;
  btm?: RecordingBackgroundTaskManager;
  projectRoot?: string;
  cwd?: string;
  depth?: number;
  toolRegistry?: ReturnType<typeof makeToolRegistry>;
  memoryConfig?: MemoryExtractionConfig;
  skillService?: SkillService;
  versionControl?: VersionControl;
}) {
  const toolRegistry = options.toolRegistry ?? makeToolRegistry();
  const projectRoot = options.projectRoot ?? tmpRoot;
  const cwd = options.cwd ?? projectRoot;
  const store = options.store ?? storeManager.create(crypto.randomUUID(), projectRoot, { cwd, agentName: options.definition.name });
  if (options.definition.name !== "engineer" && options.definition.name !== "goal_lead" && options.definition.name !== "shaper" && store.getState().parentSessionId === undefined) {
    const parentSessionId = crypto.randomUUID();
    storeManager.create(parentSessionId, projectRoot, { cwd, agentName: "engineer" });
    store.setState({ parentSessionId, rootSessionId: parentSessionId });
  }
  return new ConfiguredAgent({
    definition: options.definition,
    toolRegistry,
    skillService: options.skillService ?? createTestSkillService(),
    store,
    storeManager,
    projectContextResolver: createTestProjectContextResolver(storeManager),
    resolveVersionControl: async () => options.versionControl ?? "git",
    projectRoot,
    cwd,
    depth: options.depth,
    backgroundTaskManager: options.btm as never,
    memoryConfig: options.memoryConfig,
    toolOutputAccess: outputAccessFixture.createToolOutputAccess(projectRoot, store.getState().rootSessionId),
    logger: silentLogger,
    resolveAllowedTools: (definition, depth) => {
      const requested = [...definition.tools.tools, ...definition.roleContract.requiredCapabilities];
      const resolved = toolRegistry.resolveForAgent(requested).descriptors.map((tool) => tool.name);
      if (depth >= MAX_SUB_AGENT_DEPTH) {
        return resolved.filter((name) => !(DELEGATION_CORE_TOOLS as readonly string[]).includes(name));
      }
      return resolved;
    },
  });
}

async function runAgent(
  agent: ConfiguredAgent,
  message: string,
  options: AgentRunOptions = {},
) {
  const id = crypto.randomUUID();
  const executionId = `test-${id}`;
  agent.store.getState().append({
    type: "session.messages_committed",
    executionId,
    messages: [{
      id,
      role: "user",
      parts: [{ type: "text", id: `${id}:text`, text: message, createdAt: 1, completedAt: 1 }],
      createdAt: 1,
      completedAt: 1,
      executionId,
      clientRequestId: `request-${id}`,
    }],
  });
  return agent.run(makeBinding(), options);
}

describe("ConfiguredAgent", () => {
  beforeAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(join(tmpRoot, ".archcode", "memory"), { recursive: true });
    await writeFile(join(tmpRoot, ".archcode", "memory", "index.md"), "");
    await writeFile(join(tmpRoot, "AGENTS.md"), "# Test Project\n\nMinimal project context.");
    await mkdir(worktreeRoot, { recursive: true });
    await writeFile(join(worktreeRoot, "AGENTS.md"), "# Worktree Instructions\n\nUse the worktree checkout.");
    __setSessionsDirForTest(() => join(tmpRoot, "sessions"));
  });

  afterEach(() => {
    setLlmAdapterForTest(undefined);
  });

  afterAll(async () => {
    __setSessionsDirForTest(undefined);
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
    await Promise.all([...registryFixtures, outputAccessFixture].map((fixture) => fixture.dispose()));
  });

  test("classifies slash commands without treating command arguments as model input", () => {
    const agent = createAgent({ definition: engineerAgentDefinition });

    expect(agent.classifyCommand("ordinary message")).toBeNull();
    expect(agent.classifyCommand("/compact now")).toBeNull();
    expect(agent.classifyCommand("/compact  ")).toEqual({ name: "compact", args: "" });
    expect(agent.classifyCommand("/unknown value")).toEqual({ name: "unknown", args: "value" });
  });

  test("executes commands before admission and returns continuation as ordinary text", async () => {
    const skillService = new SkillService({
      builtinSkills: {
        "git-master": [
          "---",
          "name: git-master",
          "description: Git expertise",
          "when_to_use: Use for git work.",
          "---",
          "Full body",
        ].join("\n"),
      },
    });
    const agent = createAgent({ definition: engineerAgentDefinition, skillService });
    const command = agent.classifyCommand("/skill use git-master commit changes");

    expect(command).not.toBeNull();
    const result = await agent.executeCommand(command!, makeBinding());

    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.content).toContain("skill_read");
      expect(result.content).toContain("commit changes");
    }
    expect(agent.store.getState().messages).toHaveLength(1);
    expect(agent.store.getState().messages[0]!.parts[0]).toMatchObject({
      type: "system-notice",
      notice: expect.stringContaining("git-master"),
    });
  });

  test("does not append a command notice or continuation after Stop wins during the handler", async () => {
    const abortController = new AbortController();
    const skillService = {
      readForAgent: mock(async () => {
        abortController.abort(new Error("Session family cancelled"));
        return { name: "git-master" };
      }),
    } as unknown as SkillService;
    const agent = createAgent({ definition: engineerAgentDefinition, skillService });
    const command = agent.classifyCommand("/skill use git-master commit changes");

    expect(command).not.toBeNull();
    await expect(agent.executeCommand(command!, makeBinding(), { abort: abortController.signal }))
      .rejects.toThrow("Session family cancelled");
    expect(agent.store.getState().messages).toEqual([]);
  });

  test("handles unknown commands without admitting a model message", async () => {
    const agent = createAgent({ definition: engineerAgentDefinition });
    const command = agent.classifyCommand("/unknown");

    expect(command).not.toBeNull();
    await expect(agent.executeCommand(command!, makeBinding())).resolves.toEqual({ kind: "handled" });
    expect(agent.store.getState().toModelMessages()).toEqual([]);
    expect(agent.store.getState().messages[0]!.parts[0]).toMatchObject({
      type: "system-notice",
      notice: "Unknown command: /unknown",
    });
  });

  test("engineer definition produces all configured lifecycle hooks", async () => {
    const streamFn = setupMockStreamText("root ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, { agentName: "engineer" });
    store.setState({
      messages: [
        {
          id: "user-1",
          role: "user",
          createdAt: Date.now(),
          completedAt: Date.now(),
          parts: [{ type: "text", id: "text-1", text: "x".repeat(120), createdAt: Date.now(), completedAt: Date.now() }],
        },
      ],
      reminders: [
        {
          id: "reminder-1",
          source: { type: "todo_step_reminder", pendingTodos: [] },
          delivery: "auto_inject",
          content: "remember this",
          createdAt: Date.now(),
          consumedAt: null,
        },
      ],
      todos: [{ id: "todo-1", content: "finish", status: "pending" }],
    });

    const agent = createAgent({ definition: engineerAgentDefinition, store, btm });
    await runAgent(agent, "root run");

    const callArgs = streamFn.mock.calls[0]![0] as { messages: unknown[] };
    expect(JSON.stringify(callArgs.messages)).toContain("remember this");
    expect(agent.store.getState().reminders.some((reminder) => reminder.source.type === "todo_loop_continuation")).toBe(true);
    expect(btm.dispatched).toContain("title-generation");
    expect(btm.drainCalls).toBe(0);
  });

  test("Goal Lead leaves next-Run continuation exclusively to the Goal driver", async () => {
    setupMockStreamText("goal turn complete");
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, { agentName: "goal_lead" });
    store.setState({ todos: [{ id: "todo-1", content: "finish goal", status: "pending" }] });

    const agent = createAgent({ definition: goalLeadAgentDefinition, store });
    await runAgent(agent, "continue goal");

    expect(agent.store.getState().reminders.some((reminder) => reminder.source.type === "todo_loop_continuation")).toBe(false);
  });

  test("dispose does not cancel a provided shared background task manager", () => {
    const btm = new RecordingBackgroundTaskManager();
    const agent = createAgent({ definition: engineerAgentDefinition, btm });

    agent.dispose();

    expect(btm.cancelAllCalls).toBe(0);
  });

  test("uses the model binding supplied to this run instead of constructor state", async () => {
    const streamText = setupMockStreamText("explicit model ok");
    const agent = createAgent({ definition: exploreAgentDefinition });
    const modelInfo = makeModelInfo("per-execution");
    const id = crypto.randomUUID();
    agent.store.getState().append({
      type: "session.messages_committed",
      executionId: id,
      messages: [{
        id,
        role: "user",
        parts: [{ type: "text", id: `${id}:text`, text: "explicit model", createdAt: 1, completedAt: 1 }],
        createdAt: 1,
        completedAt: 1,
        executionId: id,
      }],
    });

    await expect(agent.run(makeBinding(modelInfo, { temperature: 0.6 })))
      .resolves.toEqual({ text: "explicit model ok", steps: 0, status: "completed" });
    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({
      model: modelInfo.model,
      temperature: 0.6,
    }));
    expect((streamText.mock.calls[0]![0] as { system: string }).system)
      .not.toContain("Model Overlay");
  });

  test("passes definition skills and SkillService into tool execution context", async () => {
    const skillService = createTestSkillService();
    let capturedContext: { agentSkills: readonly string[]; skillService: SkillService } | undefined;
    const toolRegistry = createTestRegistry([
      makeTool("file_read"),
      makeTool("submit_child_result"),
      {
        name: "capture_context",
        description: "Capture context",
        inputSchema: z.object({ agentSkills: z.array(z.string()).optional() }).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: false },
        outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
        execute: (_input, ctx) => {
          if (!ctx.agentSkills || !ctx.skillService) throw new Error("missing skill context");
          capturedContext = { agentSkills: ctx.agentSkills, skillService: ctx.skillService };
          return createTextToolResult("captured");
        },
      } satisfies AnyToolDescriptor,
    ]);
    setupToolCallStreamText("capture_context", { agentSkills: ["input-must-not-win"] });
    const agentSkills = ["git-master", "review-work"];
    const agent = createAgent({
      definition: definitionWith({ tools: { tools: ["capture_context"] }, skills: agentSkills }),
      toolRegistry,
      skillService,
    });

    await runAgent(agent, "capture skill context");
    expect(capturedContext?.agentSkills).toEqual(agentSkills);
    expect(capturedContext?.skillService).toBe(skillService);
  });

  test("uses Session cwd for prompt and tools while resolving project state from the canonical root", async () => {
    let capturedContext: { cwd: string; projectRoot: string } | undefined;
    const toolRegistry = createTestRegistry([
      makeTool("file_read"),
      makeTool("submit_child_result"),
      {
        name: "capture_workspace",
        description: "Capture workspace roots",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: false },
        outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
        execute: (_input, ctx) => {
          capturedContext = {
            cwd: ctx.cwd,
            projectRoot: ctx.projectContext.project.workspaceRoot,
          };
          return createTextToolResult("captured");
        },
      } satisfies AnyToolDescriptor,
    ]);
    const streamFn = setupToolCallStreamText("capture_workspace");
    const agent = createAgent({
      definition: definitionWith({ tools: { tools: ["capture_workspace"] } }),
      toolRegistry,
      projectRoot: tmpRoot,
      cwd: worktreeRoot,
    });

    await runAgent(agent, "capture workspace context");

    expect(capturedContext).toEqual({ cwd: worktreeRoot, projectRoot: tmpRoot });
    const system = (streamFn.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain(`Project root: ${tmpRoot}`);
    expect(system).toContain(`Working directory: ${worktreeRoot}`);
    expect(system).toContain("Execution mode: worktree");
    expect(system).toContain("Version control: git");
    expect(system).toContain("A Git repository is detected");
    expect(system).toContain("Use the worktree checkout.");
    expect(system).not.toContain("Minimal project context.");
  });

  test("injects the resolved non-Git capability into the prompt", async () => {
    const streamFn = setupMockStreamText("done");
    const agent = createAgent({
      definition: exploreAgentDefinition,
      versionControl: "none",
    });

    await runAgent(agent, "inspect the project");

    const system = (streamFn.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain("Version control: none");
    expect(system).toContain("No Git repository is detected");
    expect(system).toContain("Do not call git_status, git_diff, Session worktree tools, or Git commands");
  });

  test("explorer definition produces auto-compact, auto-inject, and todo-continuation hooks", async () => {
    const streamFn = setupMockStreamText("explore ok");
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, { agentName: "engineer" });
    store.setState({
      reminders: [
        {
          id: "reminder-2",
          source: { type: "todo_step_reminder", pendingTodos: [] },
          delivery: "auto_inject",
          content: "explorer reminder",
          createdAt: Date.now(),
          consumedAt: null,
        },
      ],
      todos: [{ id: "todo-2", content: "continue", status: "pending" }],
    });

    const agent = createAgent({ definition: exploreAgentDefinition, store, btm: new RecordingBackgroundTaskManager() });
    await runAgent(agent, "explore run");

    const callArgs = streamFn.mock.calls[0]![0] as { messages: unknown[] };
    expect(JSON.stringify(callArgs.messages)).toContain("explorer reminder");
    expect(agent.store.getState().reminders.some((reminder) => reminder.source.type === "todo_loop_continuation")).toBe(true);
  });

  test("engineer definition dispatches memory background hooks", async () => {
    setupMockStreamText("engineer memory ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, { agentName: "engineer" });
    store.setState({
      messages: [
        {
          id: "user-memory-1",
          role: "user",
          createdAt: Date.now(),
          completedAt: Date.now(),
          parts: [{ type: "text", id: "text-memory-1", text: "x".repeat(2_100), createdAt: Date.now(), completedAt: Date.now() }],
        },
        {
          id: "user-memory-2",
          role: "user",
          createdAt: Date.now(),
          completedAt: Date.now(),
          parts: [{ type: "text", id: "text-memory-2", text: "y".repeat(2_100), createdAt: Date.now(), completedAt: Date.now() }],
        },
        ...[3, 4, 5].map((index) => ({
          id: `user-memory-${index}`,
          role: "user" as const,
          createdAt: Date.now(),
          completedAt: Date.now(),
          parts: [{ type: "text" as const, id: `text-memory-${index}`, text: `message-${index}`, createdAt: Date.now(), completedAt: Date.now() }],
        })),
      ],
    });
    await writeFile(join(tmpRoot, ".archcode", "memory", "index.md"), `${Array.from({ length: 251 }, (_, index) => `topic-${index}`).join("\n")}\n`);

    const agent = createAgent({ definition: engineerAgentDefinition, store, btm });
    await runAgent(agent, "root run");

    expect(btm.dispatched).toContain("memory-extraction");
    expect(btm.dispatched).toContain("memory-consolidation");
  });

  test("memory config disabled skips memory background hooks", async () => {
    setupMockStreamText("memory disabled ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, { agentName: "engineer" });
    store.setState({
      messages: [
        {
          id: "user-memory-disabled-1",
          role: "user",
          createdAt: Date.now(),
          completedAt: Date.now(),
          parts: [{ type: "text", id: "text-memory-disabled-1", text: "x".repeat(2_100), createdAt: Date.now(), completedAt: Date.now() }],
        },
        {
          id: "user-memory-disabled-2",
          role: "user",
          createdAt: Date.now(),
          completedAt: Date.now(),
          parts: [{ type: "text", id: "text-memory-disabled-2", text: "y".repeat(2_100), createdAt: Date.now(), completedAt: Date.now() }],
        },
      ],
    });
    await writeFile(join(tmpRoot, ".archcode", "memory", "index.md"), `${Array.from({ length: 251 }, (_, index) => `topic-${index}`).join("\n")}\n`);

    const agent = createAgent({
      definition: engineerAgentDefinition,
      store,
      btm,
      memoryConfig: { enabled: false, minMessages: 1, minContentLength: 100, cooldownMs: 0 },
    });
    await runAgent(agent, "root run");

    expect(btm.dispatched).not.toContain("memory-extraction");
    expect(btm.dispatched).not.toContain("memory-consolidation");
  });

  test("memory config custom thresholds are used by extraction hook", async () => {
    setupMockStreamText("memory custom ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, { agentName: "engineer" });
    store.setState({
      messages: [
        {
          id: "user-memory-custom-1",
          role: "user",
          createdAt: Date.now(),
          completedAt: Date.now(),
          parts: [{ type: "text", id: "text-memory-custom-1", text: "z".repeat(150), createdAt: Date.now(), completedAt: Date.now() }],
        },
      ],
    });

    const agent = createAgent({
      definition: engineerAgentDefinition,
      store,
      btm,
      memoryConfig: { enabled: true, minMessages: 1, minContentLength: 100, cooldownMs: 0 },
    });
    await runAgent(agent, "root run");

    expect(btm.dispatched).toContain("memory-extraction");
  });

  test("memory config absent uses default extraction thresholds", async () => {
    setupMockStreamText("memory defaults ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, { agentName: "engineer" });
    store.setState({
      messages: [
        {
          id: "user-memory-defaults-1",
          role: "user",
          createdAt: Date.now(),
          completedAt: Date.now(),
          parts: [{ type: "text", id: "text-memory-defaults-1", text: "z".repeat(150), createdAt: Date.now(), completedAt: Date.now() }],
        },
      ],
    });

    const agent = createAgent({ definition: engineerAgentDefinition, store, btm });
    await runAgent(agent, "root run");

    expect(btm.dispatched).not.toContain("memory-extraction");
  });

  test('titleGeneration "unless-supplied" skips when store title already exists', async () => {
    setupMockStreamText("titled ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, { agentName: "engineer" });
    store.setState({ title: "Supplied Title" });

    const agent = createAgent({ definition: exploreAgentDefinition, store, btm });
    await runAgent(agent, "explore run");

    expect(btm.dispatched).not.toContain("title-generation");
  });

  test('titleGeneration "unless-supplied" dispatches when store title is null', async () => {
    setupMockStreamText("untitled ok");
    const btm = new RecordingBackgroundTaskManager();

    const agent = createAgent({ definition: exploreAgentDefinition, btm });
    await runAgent(agent, "explore run");

    expect(btm.dispatched).toContain("title-generation");
  });

  test("refreshes AGENTS.md before every run", async () => {
    const streamFn = setupMockStreamText("instructions refreshed");
    const agent = createAgent({ definition: exploreAgentDefinition });
    const agentsMdPath = join(tmpRoot, "AGENTS.md");

    try {
      await writeFile(agentsMdPath, "# First Instructions");
      await runAgent(agent, "first run");
      await writeFile(agentsMdPath, "# Second Instructions");
      await runAgent(agent, "second run");
    } finally {
      await writeFile(agentsMdPath, "# Test Project\n\nMinimal project context.");
    }

    const firstCall = streamFn.mock.calls[0]![0] as { system: string };
    const secondCall = streamFn.mock.calls[1]![0] as { system: string };
    expect(firstCall.system).toContain("# First Instructions");
    expect(secondCall.system).toContain("# Second Instructions");
    expect(secondCall.system).not.toContain("# First Instructions");
  });

  test("run forwards maxSteps to the query loop", async () => {
    const streamFn = setupToolCallStreamText("file_read");
    const agent = createAgent({ definition: exploreAgentDefinition });

    const result = await runAgent(agent, "limited run", { maxSteps: 1 });

    expect(result).toEqual({ text: "", steps: 1, status: "max_steps", error: "Max steps (1) reached" });
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(agent.store.getState().executions).toEqual([]);
  });

  test("non-loop runs keep definition tools unchanged and do not expose profile-only GitHub tools", async () => {
    const streamFn = setupMockStreamText("default tools ok");
    const toolRegistry = createTestRegistry(engineerAgentDefinition.tools.tools.map(makeTool));
    const agent = createAgent({ definition: engineerAgentDefinition, toolRegistry });

    await runAgent(agent, "default run");

    const callArgs = streamFn.mock.calls[0]![0] as { system: string };
    expect(callArgs.system).toContain("- file_read");
    expect(callArgs.system).toContain("- file_write");
    expect(callArgs.system).toContain("- bash");
    expect(callArgs.system).not.toContain("github_get_pull_request");
    expect(callArgs.system).not.toContain("github_create_issue_comment");
  });

  test("exposes exactly one cwd transition to eligible interactive root Sessions", async () => {
    const toolRegistry = createTestRegistry([
      ...engineerAgentDefinition.tools.tools.map(makeTool),
      worktreeEnterTool,
      worktreeExitTool,
    ]);

    const rootStream = setupMockStreamText("root tools");
    await runAgent(createAgent({
      definition: engineerAgentDefinition,
      toolRegistry,
      projectRoot: tmpRoot,
      cwd: tmpRoot,
    }), "show root tools");
    const rootSystem = (rootStream.mock.calls[0]![0] as { system: string }).system;
    expect(rootSystem).toContain("- worktree_enter");
    expect(rootSystem).not.toContain("- worktree_exit");

    const worktreeStream = setupMockStreamText("worktree tools");
    await runAgent(createAgent({
      definition: engineerAgentDefinition,
      toolRegistry,
      projectRoot: tmpRoot,
      cwd: worktreeRoot,
    }), "show worktree tools");
    const worktreeSystem = (worktreeStream.mock.calls[0]![0] as { system: string }).system;
    expect(worktreeSystem).not.toContain("- worktree_enter");
    expect(worktreeSystem).toContain("- worktree_exit");
  });

  test("does not expose cwd transitions to Goal-owned root Sessions", async () => {
    const streamFn = setupMockStreamText("goal tools");
    const toolRegistry = createTestRegistry([
      ...goalLeadAgentDefinition.tools.tools.map(makeTool),
      worktreeEnterTool,
      worktreeExitTool,
    ]);
    const sessionId = crypto.randomUUID();
    const goal = await new GoalStateManager(tmpRoot).commit({
      id: crypto.randomUUID(),
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      objective: "Keep Goal sessions out of ordinary worktree transitions.",
      acceptanceCriteria: "The Goal Lead prompt exposes no cwd transition tool.",
      mainSessionId: sessionId,
    });
    const store = storeManager.create(sessionId, tmpRoot, { goalId: goal.id, agentName: "goal_lead" });
    await runAgent(createAgent({
      definition: goalLeadAgentDefinition,
      toolRegistry,
      store,
      projectRoot: tmpRoot,
      cwd: tmpRoot,
    }), "show goal tools");

    const system = (streamFn.mock.calls[0]![0] as { system: string }).system;
    expect(system).not.toContain("- worktree_enter");
    expect(system).not.toContain("- worktree_exit");
  });

  test("derives Goal Lead delegate targets from the current Goal phase", async () => {
    const goalState = new GoalStateManager(tmpRoot);
    const sessionId = crypto.randomUUID();
    const goal = await goalState.commit({
      id: crypto.randomUUID(),
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      objective: "Expose only phase-valid Goal delegation targets.",
      acceptanceCriteria: "The Runtime Envelope matches Goal admission.",
      mainSessionId: sessionId,
    });
    const store = storeManager.create(sessionId, tmpRoot, {
      goalId: goal.id,
      sessionRole: "main",
      agentName: "goal_lead",
    });
    const agent = createAgent({ definition: goalLeadAgentDefinition, store });

    const running = setupMockStreamText("running");
    await runAgent(agent, "running phase");
    expect((running.mock.calls[0]![0] as { system: string }).system)
      .toContain("Allowed delegate targets: plan, build, explore, librarian");

    await goalState.beginReview(goal.id);
    const reviewing = setupMockStreamText("reviewing");
    await runAgent(agent, "reviewing phase");
    expect((reviewing.mock.calls[0]![0] as { system: string }).system)
      .toContain("Allowed delegate targets: reviewer");

    await goalState.finalizeReview(goal.id, {
      expectedReviewGeneration: 1,
      verdict: "NOT_DONE",
      summary: "More work remains.",
      ...testReviewExecutionFields("NOT_DONE"),
      authorization: {
        agentName: "reviewer",
        sessionRole: "review",
        sessionGoalId: goal.id,
        reviewerSessionId: crypto.randomUUID(),
      },
    });
    const notDone = setupMockStreamText("not done");
    await runAgent(agent, "not_done phase");
    const notDonePrompt = (notDone.mock.calls[0]![0] as { system: string }).system;
    expect(notDonePrompt).toContain("Allowed delegate targets: none");
    expect(notDonePrompt).toContain("No delegate target is currently admissible");
  });

  test("extraTools cannot grant cwd transitions to an ineligible Session", async () => {
    const streamFn = setupMockStreamText("should not run");
    const toolRegistry = createTestRegistry([
      ...engineerAgentDefinition.tools.tools.map(makeTool),
      worktreeEnterTool,
      worktreeExitTool,
    ]);
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, {
      goalId: crypto.randomUUID(), agentName: "goal_lead"
    });
    const agent = createAgent({
      definition: engineerAgentDefinition,
      toolRegistry,
      store,
      projectRoot: tmpRoot,
      cwd: tmpRoot,
    });

    await expect(runAgent(agent, "enter a worktree", {
      extraTools: ["worktree_enter"],
    })).rejects.toThrow(IneligibleSessionWorktreeToolError);
    expect(streamFn).not.toHaveBeenCalled();
  });

  test("extraTools add registered tools without narrowing baseline prompt tools", async () => {
    const streamFn = setupMockStreamText("extra tools ok");
    const toolRegistry = createTestRegistry([
      ...engineerAgentDefinition.tools.tools.map(makeTool),
      makeTool("github_get_pull_request"),
      makeTool("github_create_issue_comment"),
    ]);
    const agent = createAgent({ definition: engineerAgentDefinition, toolRegistry });

    await runAgent(agent, "extra tools run", {
      extraTools: ["github_get_pull_request", "github_create_issue_comment", "github_get_pull_request"],
    });

    const callArgs = streamFn.mock.calls[0]![0] as { system: string };
    expect(callArgs.system).toContain("- file_read");
    expect(callArgs.system).toContain("- file_write");
    expect(callArgs.system).toContain("- bash");
    expect(callArgs.system).toContain("- github_get_pull_request");
    expect(callArgs.system).toContain("- github_create_issue_comment");
    expect(callArgs.system).not.toContain("github_rerun_workflow_run");
    expect(callArgs.system.match(/- github_get_pull_request/g)).toHaveLength(1);
  });

  test("extraTools effective tools are enforced in tool execution context", async () => {
    setupToolCallStreamText("github_create_issue_comment");
    let capturedAllowedTools: string[] = [];
    const toolRegistry = createTestRegistry([
      ...engineerAgentDefinition.tools.tools.map(makeTool),
    ]);
    toolRegistry.register({
      name: "github_create_issue_comment",
      description: "Create a GitHub issue comment placeholder",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: false, destructive: false, concurrencySafe: false },
      outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
      execute: (_input, ctx) => {
        capturedAllowedTools = [...ctx.allowedTools];
        return createTextToolResult("commented");
      },
    });
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, { agentName: "engineer" });
    // ProjectContextResolver scans durable Session identities. Mirror the
    // production createSessionFile barrier instead of racing the queued write.
    await storeManager.flushSession(store.getState().sessionId, tmpRoot);
    const agent = createAgent({ definition: engineerAgentDefinition, toolRegistry, store });

    await runAgent(agent, "comment on PR", {
      maxSteps: 1,
      extraTools: ["github_create_issue_comment"],
    });

    expect(capturedAllowedTools).toContain("file_read");
    expect(capturedAllowedTools).toContain("file_write");
    expect(capturedAllowedTools).toContain("bash");
    expect(capturedAllowedTools).toContain("github_create_issue_comment");
  });

  test("unknown extraTools fail before model execution", async () => {
    const streamFn = setupMockStreamText("should not run");
    const agent = createAgent({ definition: engineerAgentDefinition });

    await expect(runAgent(agent, "unknown extra", { extraTools: ["missing_extra_tool"] })).rejects.toThrow(UnknownExtraToolError);
    expect(streamFn).not.toHaveBeenCalled();
  });

  test("skill metadata allowed_tools is prompt metadata only and cannot grant missing tools", async () => {
    const streamFn = setupMockStreamText("skill metadata ok");
    const skillService = createSkillServiceWithToolGrant();
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, {
      agentName: "engineer",
      activeSkillNames: ["github-skill"],
    });
    const agent = createAgent({
      definition: definitionWith({ tools: { tools: ["file_read"] }, skills: ["github-skill"] }),
      skillService,
      store,
    });

    await runAgent(agent, "skill metadata run");

    const callArgs = streamFn.mock.calls[0]![0] as { system: string };
    expect(callArgs.system).toContain("[allowed_tools: github_get_pull_request, github_merge_pull_request]");
    expect(callArgs.system).toContain("This skill can describe GitHub workflows but cannot grant tools.");
    expect(callArgs.system).toContain("- file_read");
    expect(callArgs.system).not.toContain("- github_get_pull_request");
    expect(callArgs.system).not.toContain("- github_merge_pull_request");
  });

  test("fails closed when a persisted active Skill is deleted between runs", async () => {
    const streamFn = setupMockStreamText("active skill loaded");
    const skillName = "ephemeral-skill";
    const skillDir = join(tmpRoot, ".archcode", "skills", skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), [
      "---",
      `name: ${skillName}`,
      "description: Temporary skill",
      "when_to_use: Use for this test.",
      "---",
      "Temporary instructions.",
    ].join("\n"));

    const store = storeManager.create(crypto.randomUUID(), tmpRoot, {
      agentName: "engineer",
      activeSkillNames: [skillName],
    });
    const agent = createAgent({
      definition: definitionWith({ skills: [skillName] }),
      skillService: createTestSkillService(),
      store,
    });

    try {
      await runAgent(agent, "first run");
      expect(store.getState().promptTraces?.at(-1)?.skills.active).toEqual([
        { name: skillName, source: join(await realpath(skillDir), "SKILL.md") },
      ]);
      await rm(skillDir, { recursive: true, force: true });
      const eventStart = store.getState().events.length;
      await expect(runAgent(agent, "second run")).rejects.toBeInstanceOf(SkillNotFoundError);
      const secondRunEvents = store.getState().events.slice(eventStart).map((event) => event.payload);
      const traceIndex = secondRunEvents.findIndex((event) => event.type === "prompt-trace");
      const errorIndex = secondRunEvents.findIndex((event) => event.type === "execution-error");
      expect(secondRunEvents[traceIndex]).toMatchObject({ type: "prompt-trace", trace: { status: "error", skills: { status: "error" } } });
      expect(traceIndex).toBeGreaterThanOrEqual(0);
      expect(errorIndex).toBeGreaterThan(traceIndex);
    } finally {
      await rm(skillDir, { recursive: true, force: true });
    }

    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  test("persists an error Prompt trace before failing closed when Skill listing fails", async () => {
    const streamFn = setupMockStreamText("must not run");
    const skillService = {
      listForAgent: mock(async () => { throw new Error("skill index unreadable"); }),
    } as unknown as SkillService;
    const store = storeManager.create(crypto.randomUUID(), tmpRoot, { agentName: "engineer" });
    const agent = createAgent({ definition: engineerAgentDefinition, skillService, store });

    await expect(runAgent(agent, "list skills")).rejects.toThrow("skill index unreadable");

    const events = store.getState().events.map((event) => event.payload);
    const traceIndex = events.findIndex((event) => event.type === "prompt-trace");
    const errorIndex = events.findIndex((event) => event.type === "execution-error");
    expect(events[traceIndex]).toMatchObject({ type: "prompt-trace", trace: { status: "error", skills: { status: "error", active: [] } } });
    expect(traceIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThan(traceIndex);
    expect(streamFn).not.toHaveBeenCalled();
  });
  test("includeMemoryInPrompt controls memory roots in prompt context", async () => {
    const withMemoryStreamFn = setupMockStreamText("memory ok");
    await runAgent(createAgent({ definition: engineerAgentDefinition }), "with memory");
    const withMemory = withMemoryStreamFn.mock.calls[0]![0] as { system: string };
    expect(withMemory.system).toContain("## Memory");
    expect(withMemory.system).toContain("Memory is non-authoritative historical context");

    const withoutMemoryStreamFn = setupMockStreamText("memory off ok");
    await runAgent(createAgent({ definition: exploreAgentDefinition }), "without memory");
    const withoutMemory = withoutMemoryStreamFn.mock.calls[0]![0] as { system: string };
    expect(withoutMemory.system).toContain("Status: absent. Memory is non-authoritative historical context.");
  });

  test("legacy active workflow context is omitted for agents", async () => {
    const streamFn = setupMockStreamText("no workflow tools ok");
    const sessionId = crypto.randomUUID();
    const goal = await new GoalStateManager(tmpRoot).commit({
      id: crypto.randomUUID(),
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      objective: "Keep retired workflow context out of Goal prompts.",
      acceptanceCriteria: "The Prompt contains no Active Workflow section.",
      mainSessionId: sessionId,
    });
    const store = storeManager.create(sessionId, tmpRoot, { goalId: goal.id, agentName: "goal_lead" });
    const agent = createAgent({
      definition: goalLeadAgentDefinition,
      store,
    });

    await expect(runAgent(agent, "run without workflow tools")).resolves.toEqual({ text: "no workflow tools ok", steps: 0, status: "completed" });
    expect(streamFn).toHaveBeenCalled();
    const callArgs = streamFn.mock.calls[0]![0] as { system: string };
    expect(callArgs.system).not.toContain("## Active Workflow");
  });

  test("simplified Goal retry sessions do not inject legacy operator repair context", async () => {
    const streamFn = setupMockStreamText("simplified retry ok");
    const goalState = new GoalStateManager(tmpRoot);
    const mainSessionId = crypto.randomUUID();
    const goal = await goalState.commit({
      id: crypto.randomUUID(),
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      objective: "Retry from natural language Goal state.",
      acceptanceCriteria: "Reviewer can decide from natural language acceptance criteria.",
      mainSessionId,
    });
    const store = storeManager.create(mainSessionId, tmpRoot, {
      goalId: goal.id,
      sessionRole: "main", agentName: "goal_lead"
    });

    await runAgent(createAgent({ definition: goalLeadAgentDefinition, store }), "retry goal");

    const callArgs = streamFn.mock.calls[0]![0] as { system: string };
    expect(callArgs.system).not.toContain("## Operator Repair Context");
  });

  test("engineer tool execution context uses Engineer attribution at depth zero", async () => {
    setupToolCallStreamText("capture_context");
    let capturedAgentName: string | undefined;
    let capturedDepth: number | undefined;
    const toolRegistry = makeToolRegistry();
    toolRegistry.register({
      name: "capture_context",
      description: "Capture execution context",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: true, destructive: false, concurrencySafe: false },
      outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
      execute: (_input, ctx) => {
        capturedAgentName = ctx.agentName;
        capturedDepth = ctx.currentDepth;
        return createTextToolResult("captured");
      },
    });

    await runAgent(createAgent({
      definition: {
        ...engineerAgentDefinition,
        tools: { ...engineerAgentDefinition.tools, tools: ["capture_context"] },
      },
      toolRegistry,
    }), "root context");

    expect(capturedAgentName).toBe("engineer");
    expect(capturedDepth).toBe(0);
  });

  test("explorer tool execution context uses Explorer attribution at child depth", async () => {
    setupToolCallStreamText("capture_context");
    let capturedAgentName: string | undefined;
    let capturedDepth: number | undefined;
    const toolRegistry = makeToolRegistry();
    toolRegistry.register({
      name: "capture_context",
      description: "Capture execution context",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: true, destructive: false, concurrencySafe: false },
      outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
      execute: (_input, ctx) => {
        capturedAgentName = ctx.agentName;
        capturedDepth = ctx.currentDepth;
        return createTextToolResult("captured");
      },
    });

    await runAgent(createAgent({
      definition: { ...exploreAgentDefinition, tools: { tools: ["capture_context"] } },
      depth: 1,
      toolRegistry,
    }), "explorer context");

    expect(capturedAgentName).toBe("explore");
    expect(capturedDepth).toBe(1);
  });
});
