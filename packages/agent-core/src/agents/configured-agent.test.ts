import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ModelInfo } from "../provider/model";
import type { ExecutionModelBinding } from "../models";
import { SkillNotFoundError, SkillService } from "../skills";
import { SessionStoreManager } from "../store/session-store-manager";
import { __setSessionsDirForTest } from "../store/sessions-dir";
import type { ToolRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { createTextToolResult } from "../tools/results";
import { toolSearchTool } from "../tools/builtins/tool-search";
import { createAuditHook, type AuditEvent } from "../tools/hooks/audit";
import { createTestToolRegistryFixture, type TestToolRegistryFixture } from "../tools/test-registry";
import { registerBuiltinTools } from "../core/register-tools";
import { worktreeEnterTool, worktreeExitTool } from "../tools/builtins/worktree";
import { DELEGATION_CONTROL_TOOLS } from "./constants";
import {
  ConfiguredAgent,
  IneligibleSessionWorktreeToolError,
  UnknownExtraToolError,
  projectStateActivatedTools,
  type ConfiguredAgentOptions,
  type ToolVisibilityFacts,
} from "./configured-agent";
import { defaultAgentDefinitions, discussionAgentDefinition, exploreAgentDefinition, leadAgentDefinition } from "./definitions";
import { isRootAgentName } from "./root-session-identity";
import type { AgentDefinition } from "./factory-types";
import type { AgentMcpToolSnapshot } from "./factory-types";
import type { VersionControl } from "../version-control/detector";
import { setLlmAdapterForTest } from "../llm/adapter";
import { MemoryPolicyRuntime } from "../memory";
import { createInMemoryLogger, silentLogger, type Logger } from "../logger";
import { createTestProjectContextResolver } from "./test-project-context-resolver";
import type { AgentRunOptions } from "./types";
import { SessionGoalService } from "../session-goal";
import type { ProjectContextResolver } from "../projects/context-resolver";
import {
  testExecutionLoadedToolRefs,
  testExecutionMemoryPolicy,
  testExecutionToolAuthorizationSnapshot,
} from "../testing/test-execution-fixtures";
import {
  EMPTY_ATTACHMENT_MODEL_PROJECTOR,
  resolveEmptyAttachmentReadPaths,
} from "../attachments/test-helpers";
import { buildDeferredToolDirectory, projectVisibleTools } from "./tool-visibility";
import { NO_STATE_DEFERRED_BUILTINS } from "./tool-visibility/search-eval-cases";
import {
  TOOL_TOOL_SEARCH,
  type AgentTreeNode,
  type AgentTreeProjection,
  type ToolChildSessionLink,
  type UserSessionPart,
} from "@archcode/protocol";

const tmpRoot = join(tmpdir(), "archcode-configured-agent", crypto.randomUUID());
const worktreeRoot = join(tmpdir(), "archcode-configured-agent-worktree", crypto.randomUUID());
const registryFixtures: TestToolRegistryFixture[] = [];
const outputAccessFixture = createTestToolRegistryFixture();
const productionBuiltinRegistryFixture = createTestToolRegistryFixture();
registerBuiltinTools(productionBuiltinRegistryFixture.registry, silentLogger, { github: { enabled: false } });
registryFixtures.push(productionBuiltinRegistryFixture);
const storeManager = new SessionStoreManager({ logger: silentLogger });
const sessions = new Map<string, { sessionId: string; workspaceRoot: string }>();

function createStore(
  sessionId: string,
  workspaceRoot: string,
  options: Parameters<SessionStoreManager["create"]>[2],
) {
  sessions.set(`${workspaceRoot}\0${sessionId}`, { sessionId, workspaceRoot });
  const normalizedOptions = options.parentSessionId === undefined && options.source === undefined
    ? { ...options, source: { kind: "direct" as const } }
    : options;
  return storeManager.create(sessionId, workspaceRoot, normalizedOptions);
}

function createTestRegistry(descriptors: AnyToolDescriptor[]): ToolRegistry {
  const fixture = createTestToolRegistryFixture({ descriptors });
  registryFixtures.push(fixture);
  return fixture.registry;
}

function createTestSkillService(): SkillService {
  return new SkillService();
}

async function createPromptMemoryResolver(
  projectRoot: string,
  readPromptManifest: () => Promise<unknown>,
): Promise<ProjectContextResolver> {
  const resolver = createTestProjectContextResolver(storeManager);
  const context = await resolver.resolve(projectRoot);
  resolver.alias(projectRoot, {
    ...context,
    memory: { readPromptManifest } as unknown as typeof context.memory,
  });
  return resolver;
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
      resolution: "profile_default",
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
    makeTool("file_write"),
    makeTool("file_edit"),
    ...DELEGATION_CONTROL_TOOLS.map(makeTool),
    makeTool("project_todo_update"),
  ]);
}

function setupMockStreamText(text = "ok") {
  const fn = mock((_opts: Record<string, unknown>) => ({
    fullStream: (async function* () {
      yield { type: "text-start", id: "output" };
      yield { type: "text-delta", id: "output", text };
      yield { type: "text-end", id: "output" };
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
        fullStream: (async function* () {
          yield { type: "text-start", id: "output" };
          yield { type: "text-delta", id: "output", text: "done" };
          yield { type: "text-end", id: "output" };
        })(),
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
  skillService?: SkillService;
  projectContextResolver?: ProjectContextResolver;
  versionControl?: VersionControl;
  sessionGoalService?: SessionGoalService;
  resolveMcpToolSnapshot?: () => AgentMcpToolSnapshot;
  getAgentTreeProjection?: ConfiguredAgentOptions["getAgentTreeProjection"];
  toolOutputAccess?: ConfiguredAgentOptions["toolOutputAccess"];
  logger?: Logger;
}) {
  const toolRegistry = options.toolRegistry ?? makeToolRegistry();
  const projectRoot = options.projectRoot ?? tmpRoot;
  const cwd = options.cwd ?? projectRoot;
  let store = options.store;
  if (store === undefined && !isRootAgentName(options.definition.name)) {
    const parentSessionId = crypto.randomUUID();
    createStore(parentSessionId, projectRoot, { cwd, agentName: "lead" });
    store = createStore(crypto.randomUUID(), projectRoot, {
      cwd,
      agentName: options.definition.name,
      parentSessionId,
      rootSessionId: parentSessionId,
    });
  }
  store ??= createStore(crypto.randomUUID(), projectRoot, { cwd, agentName: options.definition.name });
  if (!isRootAgentName(options.definition.name) && store.getState().parentSessionId === undefined) {
    const parentSessionId = crypto.randomUUID();
    createStore(parentSessionId, projectRoot, { cwd, agentName: "lead" });
    const agentType = options.definition.name as "analyst" | "build" | "explore" | "librarian";
    store.setState({
      agentName: agentType,
      parentSessionId,
      rootSessionId: parentSessionId,
      source: undefined,
      delegationRequest: {
        agent_type: agentType,
        profile: agentType === "analyst" || agentType === "build" ? "deep" : "fast",
        title: "Configured Agent test child",
        objective: "Exercise the configured Agent test contract.",
        skills: [...store.getState().activeSkillNames],
        background: false,
      },
    });
  }
  const depth = options.depth ?? 0;
  const resolveAllowedTools = (definition: AgentDefinition, agentDepth: number) => {
    const requested = [...definition.tools.authorized, ...definition.roleContract.requiredCapabilities];
    const resolved = toolRegistry.resolveForAgent(requested).descriptors.map((tool) => tool.name);
    if (
      definition.childPolicy === undefined
      || (definition.tools.delegateTargets?.length ?? 0) === 0
      || agentDepth >= definition.childPolicy.maxDepth
    ) {
      return resolved.filter((name) => !(DELEGATION_CONTROL_TOOLS as readonly string[]).includes(name));
    }
    return resolved;
  };
  const canDelegate = resolveAllowedTools(options.definition, depth).includes("delegate");
  const delegationTargets = canDelegate
    ? (options.definition.tools.delegateTargets ?? []).map((agentName) => {
        const target = defaultAgentDefinitions.find((candidate) => candidate.name === agentName);
        if (target === undefined) throw new Error(`Missing test Agent definition: ${agentName}`);
        return Object.freeze({
          agentName: target.name,
          profiles: Object.freeze([...target.profiles]),
          builtinSkillNames: Object.freeze([...target.skills]),
        });
      })
    : [];
  return new ConfiguredAgent({
    definition: options.definition,
    toolRegistry,
    skillService: options.skillService ?? createTestSkillService(),
    store,
    storeManager,
    projectContextResolver: options.projectContextResolver ?? createTestProjectContextResolver(storeManager),
    ...(options.sessionGoalService === undefined ? {} : { sessionGoalService: options.sessionGoalService }),
    resolveVersionControl: async () => options.versionControl ?? "git",
    projectRoot,
    cwd,
    depth: options.depth,
    backgroundTaskManager: options.btm as never,
    toolOutputAccess: options.toolOutputAccess
      ?? outputAccessFixture.createToolOutputAccess(projectRoot, store.getState().rootSessionId),
    attachmentProjector: EMPTY_ATTACHMENT_MODEL_PROJECTOR,
    resolveAttachmentReadPaths: resolveEmptyAttachmentReadPaths,
    logger: options.logger ?? silentLogger,
    delegationCapabilities: Object.freeze({
      parentAgentName: options.definition.name,
      depth,
      targets: Object.freeze(delegationTargets),
    }),
    resolveAllowedTools,
    resolveMcpToolSnapshot: options.resolveMcpToolSnapshot,
    getAgentTreeProjection: options.getAgentTreeProjection,
  });
}

async function runAgent(
  agent: ConfiguredAgent,
  message: string,
  options: Partial<AgentRunOptions> & {
    readonly extraTools?: readonly string[];
    readonly toolProjection?: readonly string[];
    readonly userMessageParts?: readonly UserSessionPart[];
  } = {},
) {
  const id = crypto.randomUUID();
  const {
    extraTools = [],
    toolProjection,
    userMessageParts = [],
    toolAuthorizationSnapshot = {
      extraTools: [...extraTools],
      toolProjection: toolProjection === undefined ? null : [...toolProjection],
    },
    loadedToolRefs = [],
    reconcileExecutionToolLoads = async () => {},
    ...rest
  } = options;
  const runOptions: AgentRunOptions = {
    executionId: `test-${id}`,
    runOrdinal: 0,
    initialStep: 0,
    memoryPolicy: new MemoryPolicyRuntime().claim(),
    toolAuthorizationSnapshot,
    loadedToolRefs,
    reconcileExecutionToolLoads,
    ...rest,
  };
  const executionId = runOptions.executionId;
  const binding = makeBinding();
  agent.store.getState().append({
    type: "execution-start",
    executionId,
    binding: binding.summary,
    memoryPolicy: runOptions.memoryPolicy,
    origin: "tool_call",
    maxSteps: runOptions.maxSteps ?? 50,
    executionSkills: [],
    toolAuthorizationSnapshot: runOptions.toolAuthorizationSnapshot,
    loadedToolRefs: [...runOptions.loadedToolRefs],
  });
  agent.store.getState().append({
    type: "session.messages_committed",
    executionId,
    messages: [{
      id,
      role: "user",
      parts: [
        { type: "text", id: `${id}:text`, text: message, createdAt: 1, completedAt: 1 },
        ...userMessageParts,
      ],
      createdAt: 1,
      completedAt: 1,
      executionId,
      clientRequestId: `request-${id}`,
    }],
  });
  const zeroUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
  };
  try {
    const result = await agent.run(binding, runOptions);
    const endedAt = Date.now();
    const sessionId = agent.store.getState().sessionId;
    const runSettlement = { key: `run:${sessionId}:${executionId}:0`, goalInstanceId: null };
    if (result.outcome === "suspended") {
      agent.store.getState().append({
        type: "execution-suspended",
        executionId,
        suspension: result.suspension,
        runEndedAt: endedAt,
        runUsageDelta: zeroUsage,
        runSettlement,
      });
    } else {
      agent.store.getState().append({
        type: "execution-end",
        executionId,
        terminalStatus: result.status,
        endedAt,
        runEndedAt: endedAt,
        runUsageDelta: zeroUsage,
        runSettlement,
        terminalSettlement: { key: `terminal:${sessionId}:${executionId}`, goalInstanceId: null },
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    }
    return result;
  } catch (error) {
    const endedAt = Date.now();
    const sessionId = agent.store.getState().sessionId;
    agent.store.getState().append({
      type: "execution-end",
      executionId,
      terminalStatus: "failed",
      endedAt,
      runEndedAt: endedAt,
      runUsageDelta: zeroUsage,
      runSettlement: { key: `run:${sessionId}:${executionId}:0`, goalInstanceId: null },
      terminalSettlement: { key: `terminal:${sessionId}:${executionId}`, goalInstanceId: null },
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function providerToolsAt(
  streamFn: ReturnType<typeof setupMockStreamText> | ReturnType<typeof setupToolCallStreamText>,
  callIndex = 0,
): Record<string, unknown> {
  const call = streamFn.mock.calls[callIndex]?.[0] as { tools?: Record<string, unknown> } | undefined;
  return call?.tools ?? {};
}

describe("ConfiguredAgent", () => {
  beforeAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(join(tmpRoot, ".archcode", "runtime", "memory"), { recursive: true });
    await writeFile(join(tmpRoot, ".archcode", "runtime", "memory", "index.md"), "");
    await writeFile(join(tmpRoot, "AGENTS.md"), "# Test Project\n\nMinimal project context.");
    await mkdir(worktreeRoot, { recursive: true });
    await writeFile(join(worktreeRoot, "AGENTS.md"), "# Worktree Instructions\n\nUse the worktree checkout.");
    __setSessionsDirForTest(() => join(tmpRoot, "sessions"));
  });

  afterEach(async () => {
    try {
      await Promise.all(
        [...sessions.values()].map(({ sessionId, workspaceRoot }) =>
          storeManager.flushSession(sessionId, workspaceRoot)
        ),
      );
    } finally {
      sessions.clear();
      storeManager.clearAll();
      setLlmAdapterForTest(undefined);
    }
  });

  afterAll(async () => {
    __setSessionsDirForTest(undefined);
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
    await Promise.all([...registryFixtures, outputAccessFixture].map((fixture) => fixture.dispose()));
  });

  test("classifies slash commands without treating command arguments as model input", () => {
    const agent = createAgent({ definition: leadAgentDefinition });

    expect(agent.classifyCommand("ordinary message")).toBeNull();
    expect(agent.classifyCommand("/compact now")).toBeNull();
    expect(agent.classifyCommand("/compact  ")).toEqual({ name: "compact", args: "" });
    expect(agent.classifyCommand("/unknown value")).toEqual({ name: "unknown", args: "value" });
  });

  test("executes commands before admission and returns continuation as ordinary text", async () => {
    const skillService = new SkillService({
      builtinSkills: {
        "git-master": { entry: [
          "---",
          "name: git-master",
          "description: Git expertise. Use for git work.",
          "---",
          "Full body",
        ].join("\n"), resources: {} },
      },
    });
    const agent = createAgent({ definition: leadAgentDefinition, skillService });
    const command = agent.classifyCommand("/skill use git-master commit changes");

    expect(command).not.toBeNull();
    const result = await agent.executeCommand(command!, makeBinding());

    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.content).toBe("commit changes");
      expect(result.content).not.toContain("skill_read");
      expect(result.executionSkillNames).toEqual(["git-master"]);
    }
    expect(agent.store.getState().messages).toHaveLength(1);
    expect(agent.store.getState().messages[0]!.parts[0]).toMatchObject({
      type: "system-notice",
      notice: expect.stringContaining("git-master"),
    });
  });

  test("validates Skill commands against the Session cwd", async () => {
    const skillName = "worktree-command-skill";
    const canonicalSkillRoot = join(tmpRoot, ".archcode", "skills", skillName);
    const worktreeSkillRoot = join(worktreeRoot, ".archcode", "skills", skillName);
    await mkdir(canonicalSkillRoot, { recursive: true });
    await mkdir(worktreeSkillRoot, { recursive: true });
    await writeFile(join(canonicalSkillRoot, "SKILL.md"), [
      "---",
      `name: ${skillName}`,
      "---",
      "Invalid canonical package.",
    ].join("\n"));
    await writeFile(join(worktreeSkillRoot, "SKILL.md"), [
      "---",
      `name: ${skillName}`,
      "description: Valid only in the Session worktree.",
      "---",
      "Worktree command guidance.",
    ].join("\n"));
    const agent = createAgent({ definition: leadAgentDefinition, projectRoot: tmpRoot, cwd: worktreeRoot });

    try {
      const command = agent.classifyCommand(`/skill use ${skillName} inspect worktree`);
      expect(command).not.toBeNull();
      await expect(agent.executeCommand(command!, makeBinding())).resolves.toEqual({
        kind: "message",
        content: "inspect worktree",
        executionSkillNames: [skillName],
      });
    } finally {
      await rm(canonicalSkillRoot, { recursive: true, force: true });
      await rm(worktreeSkillRoot, { recursive: true, force: true });
    }
  });

  test("does not append a command notice or continuation after Stop wins during the handler", async () => {
    const abortController = new AbortController();
    const skillService = {
      snapshotForAgent: mock(async () => {
        abortController.abort(new Error("Session family cancelled"));
        return { name: "git-master" };
      }),
      projectPromptCatalog: mock(async () => ({
        includedEntries: [],
        omittedCount: 0,
        renderedText: "- none",
        byteLength: 6,
      })),
    } as unknown as SkillService;
    const agent = createAgent({ definition: leadAgentDefinition, skillService });
    const command = agent.classifyCommand("/skill use git-master commit changes");

    expect(command).not.toBeNull();
    await expect(agent.executeCommand(command!, makeBinding(), { abort: abortController.signal }))
      .rejects.toThrow("Session family cancelled");
    expect(agent.store.getState().messages).toEqual([]);
  });

  test("handles unknown commands without admitting a model message", async () => {
    const agent = createAgent({ definition: leadAgentDefinition });
    const command = agent.classifyCommand("/unknown");

    expect(command).not.toBeNull();
    await expect(agent.executeCommand(command!, makeBinding())).resolves.toEqual({ kind: "handled" });
    expect(agent.store.getState().toModelMessages()).toEqual([]);
    expect(agent.store.getState().messages[0]!.parts[0]).toMatchObject({
      type: "system-notice",
      notice: "Unknown command: /unknown",
    });
  });

  test("Lead definition produces all configured lifecycle hooks", async () => {
    const streamFn = setupMockStreamText("root ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = createStore(crypto.randomUUID(), tmpRoot, { agentName: "lead" });
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

    const agent = createAgent({ definition: leadAgentDefinition, store, btm });
    await runAgent(agent, "root run");

    const callArgs = streamFn.mock.calls[0]![0] as { messages: unknown[] };
    expect(JSON.stringify(callArgs.messages)).toContain("remember this");
    expect(agent.store.getState().reminders.some((reminder) => reminder.source.type === "todo_loop_continuation")).toBe(true);
    expect(btm.dispatched).toContain("title-generation");
    expect(btm.drainCalls).toBe(0);
  });

  test("delivers the active Session Goal through messages without copying its state into the system Prompt", async () => {
    const streamFn = setupMockStreamText("continue goal");
    const sessionId = crypto.randomUUID();
    const store = createStore(sessionId, tmpRoot, { agentName: "lead" });
    const sessionGoalService = new SessionGoalService(storeManager);
    const objective = "SENTINEL_OBJECTIVE_FINISH_AUTH_MIGRATION";
    await sessionGoalService.create({
      workspaceRoot: tmpRoot,
      sessionId,
      objective,
      authority: { kind: "user_control" },
    });

    await runAgent(createAgent({ definition: leadAgentDefinition, store, sessionGoalService }), "continue");

    const call = streamFn.mock.calls[0]![0] as { system: string; messages: unknown[] };
    expect(call.system).not.toContain("## Session Goal");
    expect(call.system).not.toContain(objective);
    expect(JSON.stringify(call.messages)).toContain(objective);
    expect(JSON.stringify(call.messages)).toContain("<goal-notice>");
    expect(call.system).toContain("create a fresh direct deep Analyst");
  });

  test("keeps Prompt and trace stable while an in-loop Goal edit appears only as the next notice", async () => {
    const originalObjective = "SENTINEL_ORIGINAL_GOAL_OBJECTIVE";
    const editedObjective = "SENTINEL_EDITED_GOAL_OBJECTIVE";
    const sessionId = crypto.randomUUID();
    const store = createStore(sessionId, tmpRoot, { agentName: "lead" });
    const sessionGoalService = new SessionGoalService(storeManager);
    const created = await sessionGoalService.create({
      workspaceRoot: tmpRoot,
      sessionId,
      objective: originalObjective,
      authority: { kind: "user_control" },
    });
    const toolRegistry = makeToolRegistry();
    toolRegistry.register({
      name: "edit_goal_fixture",
      description: "Edit the current Goal for a model-boundary test.",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: false, destructive: false, concurrencySafe: false },
      outputPolicy: { kind: "inline", previewDirection: "head" },
      execute: async () => {
        await sessionGoalService.edit({
          workspaceRoot: tmpRoot,
          sessionId,
          authority: { kind: "user_control" },
          expectedGeneration: created.generation,
          objective: editedObjective,
        });
        return createTextToolResult("Goal edited");
      },
    });
    const streamFn = setupToolCallStreamText("edit_goal_fixture");
    const definition = {
      ...leadAgentDefinition,
      tools: {
        ...leadAgentDefinition.tools,
        authorized: [...leadAgentDefinition.tools.authorized, "edit_goal_fixture"],
        core: [...leadAgentDefinition.tools.core, "edit_goal_fixture"],
      },
    } satisfies AgentDefinition;

    await runAgent(createAgent({
      definition,
      store,
      sessionGoalService,
      toolRegistry,
    }), "continue across the edit");

    expect(streamFn).toHaveBeenCalledTimes(2);
    const first = streamFn.mock.calls[0]![0] as { system: string; messages: unknown[] };
    const second = streamFn.mock.calls[1]![0] as { system: string; messages: unknown[] };
    const firstMessages = JSON.stringify(first.messages);
    const secondMessages = JSON.stringify(second.messages);
    expect(second.system).toBe(first.system);
    expect(first.system).not.toContain(originalObjective);
    expect(first.system).not.toContain(editedObjective);
    expect(firstMessages).toContain(originalObjective);
    expect(firstMessages).not.toContain(editedObjective);
    expect(secondMessages).toContain(originalObjective);
    expect(secondMessages).toContain(editedObjective);
    expect(secondMessages).toContain("<action>edited</action>");

    const traces = store.getState().promptTraces ?? [];
    expect(traces).toHaveLength(2);
    expect(traces[1]?.hash).toBe(traces[0]?.hash);
    expect(JSON.stringify(traces)).not.toContain(originalObjective);
    expect(JSON.stringify(traces)).not.toContain(editedObjective);
  });

  test("derives the Todo Discussion Prompt and shape-todo lifecycle from formal identity", async () => {
    const streamFn = setupMockStreamText("discussion shaped");
    const sessionId = crypto.randomUUID();
    const projectContextResolver = createTestProjectContextResolver(storeManager);
    const projectContext = await projectContextResolver.resolve(tmpRoot);
    const todo = await projectContext.todos.createTodo({ content: "Shape runtime architecture" });
    const store = createStore(sessionId, tmpRoot, {
      agentName: "discussion",
      source: { kind: "todo", todoId: todo.id, entry: "discussion" },
    });

    await runAgent(createAgent({
      definition: discussionAgentDefinition,
      store,
      projectContextResolver,
    }), "discuss");

    const system = (streamFn.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain(`- Source: todo (entry=discussion, todo=${todo.id})`);
    expect(system).toContain(`- Todo: ${todo.id} (bound)`);
    expect(system).toContain("- Allowed delegate targets: explore, librarian");
    expect(system).toContain("- Remaining delegation depth: 2");
    expect(system).toContain("### shape-todo");
    expect(store.getState().activeSkillNames).toEqual([]);
  });

  test("refreshes the bound Todo snapshot before every Discussion run", async () => {
    const streamFn = setupMockStreamText("discussion refreshed");
    const sessionId = crypto.randomUUID();
    const projectContextResolver = createTestProjectContextResolver(storeManager);
    const projectContext = await projectContextResolver.resolve(tmpRoot);
    const todo = await projectContext.todos.createTodo({
      content: "Original content",
    });
    const store = createStore(sessionId, tmpRoot, {
      agentName: "discussion",
      source: { kind: "todo", todoId: todo.id, entry: "discussion" },
    });
    const agent = createAgent({
      definition: discussionAgentDefinition,
      store,
      projectContextResolver,
    });

    await runAgent(agent, "first discussion");
    const updated = await projectContext.todos.updateTodo(todo.id, {
      expectedRevision: todo.revision,
      content: "Current content",
      status: "ready",
    });
    await mkdir(join(tmpRoot, ".archcode", "plans"), { recursive: true });
    await writeFile(join(tmpRoot, ".archcode", "plans", `${todo.id}.md`), "# Current Plan\n");
    await runAgent(agent, "second discussion");

    const firstSystem = (streamFn.mock.calls[0]![0] as { system: string }).system;
    const secondSystem = (streamFn.mock.calls[1]![0] as { system: string }).system;
    expect(firstSystem).toContain(`todoRevision=${todo.revision}`);
    expect(firstSystem).toContain("todoStatus=idea");
    expect(firstSystem).toContain('todoContent="Original content"');
    expect(firstSystem).toContain(`todoPlanPath="${join(tmpRoot, ".archcode", "plans", `${todo.id}.md`)}"`);
    expect(firstSystem).toContain("todoPlanState=absent");
    expect(secondSystem).toContain(`todoRevision=${updated.revision}`);
    expect(secondSystem).toContain("todoStatus=ready");
    expect(secondSystem).toContain('todoContent="Current content"');
    expect(secondSystem).toContain("todoPlanState=present");
    expect(secondSystem).not.toContain('todoContent="Original content"');
  });

  test("projects current Todo and Plan context into a Todo-bound Lead run", async () => {
    const streamFn = setupMockStreamText("work refreshed");
    const projectContextResolver = createTestProjectContextResolver(storeManager);
    const projectContext = await projectContextResolver.resolve(tmpRoot);
    const todo = await projectContext.todos.createTodo({ content: "Implement the ready change" });
    const ready = await projectContext.todos.updateTodo(todo.id, {
      expectedRevision: todo.revision,
      status: "ready",
    });
    const store = createStore(crypto.randomUUID(), tmpRoot, {
      agentName: "lead",
      source: { kind: "todo", todoId: ready.id, entry: "work" },
    });

    await runAgent(createAgent({
      definition: leadAgentDefinition,
      store,
      projectContextResolver,
    }), "start work");

    const system = (streamFn.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain(`- Source: todo (entry=work, todo=${ready.id})`);
    expect(system).toContain(`- Todo: ${ready.id} (bound)`);
    expect(system).toContain(`todoRevision=${ready.revision}`);
    expect(system).toContain("todoStatus=ready");
    expect(system).toContain('todoContent="Implement the ready change"');
    expect(system).toContain(`todoPlanPath="${join(tmpRoot, ".archcode", "plans", `${ready.id}.md`)}"`);
    expect(system).toContain("todoPlanState=absent");
  });

  test("projects an Automation invocation source without folding it into a Todo automation entry", async () => {
    const streamFn = setupMockStreamText("automation context");
    const projectContextResolver = createTestProjectContextResolver(storeManager);
    const projectContext = await projectContextResolver.resolve(tmpRoot);
    const todo = await projectContext.todos.createTodo({ content: "Run the scheduled verification" });
    const automationId = crypto.randomUUID();
    const invocationId = crypto.randomUUID();
    const store = createStore(crypto.randomUUID(), tmpRoot, {
      agentName: "lead",
      source: { kind: "automation", automationId, invocationId, todoId: todo.id },
    });

    await runAgent(createAgent({
      definition: leadAgentDefinition,
      store,
      projectContextResolver,
    }), "run automation");

    const system = (streamFn.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain(
      `- Source: automation (automation=${automationId}, invocation=${invocationId}, todo=${todo.id})`,
    );
    expect(system).toContain(`- Todo: ${todo.id} (bound)`);
    expect(system).toContain('todoContent="Run the scheduled verification"');
    expect(system).toContain(`todoPlanPath="${join(tmpRoot, ".archcode", "plans", `${todo.id}.md`)}"`);
  });

  test("keeps a direct root free of Todo and Plan context", async () => {
    const streamFn = setupMockStreamText("direct context");

    await runAgent(createAgent({ definition: leadAgentDefinition }), "direct work");

    const system = (streamFn.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain("- Source: direct");
    expect(system).toContain("- Todo: none");
    expect(system).toContain("todoId=none");
    expect(system).toContain("todoPlanPath=none");
    expect(system).toContain("todoPlanState=none");
  });

  test("refreshes Plan presence between model calls in one Todo-bound Execution", async () => {
    const projectContextResolver = createTestProjectContextResolver(storeManager);
    const projectContext = await projectContextResolver.resolve(tmpRoot);
    const todo = await projectContext.todos.createTodo({ content: "Create a live Plan" });
    const planPath = join(tmpRoot, ".archcode", "plans", `${todo.id}.md`);
    const store = createStore(crypto.randomUUID(), tmpRoot, {
      agentName: "lead",
      source: { kind: "todo", todoId: todo.id, entry: "work" },
    });
    const toolRegistry = makeToolRegistry();
    toolRegistry.register({
      name: "create_plan_fixture",
      description: "Create the Todo Plan between model calls.",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: false, destructive: false, concurrencySafe: false },
      outputPolicy: { kind: "inline", previewDirection: "head" },
      execute: async () => {
        await mkdir(join(tmpRoot, ".archcode", "plans"), { recursive: true });
        await writeFile(planPath, "# Live Plan\n");
        return createTextToolResult("Plan created");
      },
    });
    const streamFn = setupToolCallStreamText("create_plan_fixture");
    const definition = {
      ...leadAgentDefinition,
      tools: {
        ...leadAgentDefinition.tools,
        authorized: [...leadAgentDefinition.tools.authorized, "create_plan_fixture"],
        core: [...leadAgentDefinition.tools.core, "create_plan_fixture"],
      },
    } satisfies AgentDefinition;

    await runAgent(createAgent({
      definition,
      store,
      projectContextResolver,
      toolRegistry,
    }), "create the Plan");

    expect(streamFn).toHaveBeenCalledTimes(2);
    const firstSystem = (streamFn.mock.calls[0]![0] as { system: string }).system;
    const secondSystem = (streamFn.mock.calls[1]![0] as { system: string }).system;
    expect(firstSystem).toContain("todoPlanState=absent");
    expect(secondSystem).toContain("todoPlanState=present");
  });

  test("keeps Discussion extraTools within its Definition allowlist", async () => {
    const streamFn = setupMockStreamText("should not run");
    const store = createStore(crypto.randomUUID(), tmpRoot, {
      agentName: "discussion",
      source: { kind: "todo", todoId: crypto.randomUUID(), entry: "discussion" },
    });
    const agent = createAgent({
      definition: discussionAgentDefinition,
      store,
    });

    await expect(runAgent(agent, "expand Discussion tools", {
      extraTools: ["unknown_tool"],
    })).rejects.toThrow(UnknownExtraToolError);
    expect(streamFn).not.toHaveBeenCalled();
  });

  test("dispose does not cancel a provided shared background task manager", () => {
    const btm = new RecordingBackgroundTaskManager();
    const agent = createAgent({ definition: leadAgentDefinition, btm });

    agent.dispose();

    expect(btm.cancelAllCalls).toBe(0);
  });

  test("uses the model binding supplied to this run instead of constructor state", async () => {
    const streamText = setupMockStreamText("explicit model ok");
    const agent = createAgent({ definition: exploreAgentDefinition });
    const modelInfo = makeModelInfo("per-execution");
    const binding = makeBinding(modelInfo, { temperature: 0.6 });
    const id = crypto.randomUUID();
    agent.store.getState().append({
      type: "execution-start",
      executionId: id,
      binding: binding.summary,
      memoryPolicy: testExecutionMemoryPolicy,
      origin: "tool_call",
      maxSteps: 50,
      executionSkills: [],
      toolAuthorizationSnapshot: testExecutionToolAuthorizationSnapshot,
      loadedToolRefs: testExecutionLoadedToolRefs,
    });
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

    await expect(agent.run(binding, {
      executionId: id,
      runOrdinal: 0,
      initialStep: 0,
      memoryPolicy: new MemoryPolicyRuntime().claim(),
      toolAuthorizationSnapshot: testExecutionToolAuthorizationSnapshot,
      loadedToolRefs: testExecutionLoadedToolRefs,
      reconcileExecutionToolLoads: async () => {},
    })).resolves.toEqual({
      outcome: "terminal",
      text: "explicit model ok",
      steps: 1,
      status: "completed",
      finalOutputStepId: expect.any(String),
    });
    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({
      model: modelInfo.model,
      temperature: 0.6,
    }));
    const system = (streamText.mock.calls[0]![0] as { system: string }).system;
    expect(system).not.toContain("Model Overlay");
    expect(system).toContain("- Source: child");
    expect(system).toContain("- Todo: none");
    expect(system).toContain("todoPlanState=none");
  });

  test("passes definition skills and SkillService into tool execution context", async () => {
    const skillService = createTestSkillService();
    let capturedContext: { agentSkills: readonly string[]; skillService: SkillService } | undefined;
    const toolRegistry = createTestRegistry([
      makeTool("file_read"),
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
      definition: definitionWith({ tools: { authorized: ["capture_context"], core: ["capture_context"] }, skills: agentSkills }),
      toolRegistry,
      skillService,
    });

    await runAgent(agent, "capture skill context");
    expect(capturedContext?.agentSkills).toEqual(agentSkills);
    expect(capturedContext?.skillService).toBe(skillService);
  });

  test("uses Session cwd for prompt and tools while resolving project state from the canonical root", async () => {
    const skillName = "worktree-prompt-skill";
    const canonicalSkillRoot = join(tmpRoot, ".archcode", "skills", skillName);
    const worktreeSkillRoot = join(worktreeRoot, ".archcode", "skills", skillName);
    for (const [root, description] of [
      [canonicalSkillRoot, "Canonical prompt metadata."],
      [worktreeSkillRoot, "Session worktree prompt metadata."],
    ] as const) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "SKILL.md"), [
        "---",
        `name: ${skillName}`,
        `description: ${description}`,
        "---",
        description,
      ].join("\n"));
    }
    let capturedContext: { cwd: string; projectRoot: string } | undefined;
    const toolRegistry = createTestRegistry([
      makeTool("file_read"),
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
      definition: definitionWith({ tools: { authorized: ["capture_workspace"], core: ["capture_workspace"] } }),
      toolRegistry,
      projectRoot: tmpRoot,
      cwd: worktreeRoot,
    });

    try {
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
      expect(system).toContain("Session worktree prompt metadata.");
      expect(system).not.toContain("Canonical prompt metadata.");
    } finally {
      await rm(canonicalSkillRoot, { recursive: true, force: true });
      await rm(worktreeSkillRoot, { recursive: true, force: true });
    }
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
    const store = createStore(crypto.randomUUID(), tmpRoot, { agentName: "lead" });
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

  test('titleGeneration "unless-supplied" skips when store title already exists', async () => {
    setupMockStreamText("titled ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = createStore(crypto.randomUUID(), tmpRoot, { agentName: "lead" });
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

    expect(result).toEqual({
      outcome: "terminal",
      text: "",
      steps: 1,
      status: "max_steps",
      error: "Max steps (1) reached",
    });
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(agent.store.getState().executions).toEqual([
      expect.objectContaining({ status: "max_steps", maxSteps: 1 }),
    ]);
  });

  test("Todo continuation advances the same step cursor and stops at the Execution maxSteps", async () => {
    let modelCalls = 0;
    const streamFn = mock(() => {
      modelCalls += 1;
      const isToolRound = modelCalls === 1;
      return {
        fullStream: (async function* () {
          if (isToolRound) {
            yield {
              type: "tool-call",
              toolCallId: `file-read-${modelCalls}`,
              toolName: "file_read",
              input: {},
            };
          }
        })(),
        finishReason: Promise.resolve(isToolRound ? "tool-calls" : "stop"),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve(isToolRound
          ? [{ toolCallId: `file-read-${modelCalls}`, toolName: "file_read", input: {} }]
          : []),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      };
    });
    setLlmAdapterForTest({ streamText: streamFn as unknown as typeof import("ai").streamText });
    const store = createStore(crypto.randomUUID(), tmpRoot, { agentName: "lead" });
    store.setState({ todos: [{ id: "todo-continue", content: "Finish", status: "pending" }] });
    const agent = createAgent({ definition: leadAgentDefinition, store });

    const result = await runAgent(agent, "continue", { maxSteps: 3 });

    expect(result).toMatchObject({ outcome: "terminal", status: "max_steps", steps: 3 });
    expect(streamFn).toHaveBeenCalledTimes(3);
    expect(agent.store.getState().steps.map(({ step }) => step)).toEqual([0, 1, 2]);
    expect(agent.store.getState().steps.every(({ step }) => step < 3)).toBe(true);
    expect(agent.store.getState().executions).toEqual([
      expect.objectContaining({ status: "max_steps", maxSteps: 3 }),
    ]);
  });

  test("non-loop runs keep definition tools unchanged and do not expose profile-only GitHub tools", async () => {
    const streamFn = setupMockStreamText("default tools ok");
    const toolRegistry = createTestRegistry(leadAgentDefinition.tools.authorized.map(makeTool));
    const agent = createAgent({ definition: leadAgentDefinition, toolRegistry });

    await runAgent(agent, "default run");

    const callArgs = streamFn.mock.calls[0]![0] as { system: string; tools: Record<string, unknown> };
    expect(callArgs.system).toContain("- file_read");
    expect(callArgs.system).toContain("- file_write");
    expect(callArgs.system).toContain("- bash");
    expect(callArgs.system).not.toContain("github_get_pull_request");
    expect(callArgs.system).not.toContain("github_create_issue_comment");
  });

  test("exposes exactly one cwd transition to eligible interactive root Sessions", async () => {
    const toolRegistry = createTestRegistry([
      ...leadAgentDefinition.tools.authorized.map(makeTool),
      worktreeEnterTool,
      worktreeExitTool,
    ]);

    const rootStream = setupMockStreamText("root tools");
    await runAgent(createAgent({
      definition: leadAgentDefinition,
      toolRegistry,
      projectRoot: tmpRoot,
      cwd: tmpRoot,
    }), "show root tools");
    const rootSystem = (rootStream.mock.calls[0]![0] as { system: string }).system;
    expect(rootSystem).toContain("- worktree_enter");
    expect(rootSystem).not.toContain("- worktree_exit");

    const worktreeStream = setupMockStreamText("worktree tools");
    await runAgent(createAgent({
      definition: leadAgentDefinition,
      toolRegistry,
      projectRoot: tmpRoot,
      cwd: worktreeRoot,
    }), "show worktree tools");
    const worktreeSystem = (worktreeStream.mock.calls[0]![0] as { system: string }).system;
    expect(worktreeSystem).not.toContain("- worktree_enter");
    expect(worktreeSystem).toContain("- worktree_exit");
  });

  test("extraTools cannot grant cwd transitions to an ineligible Session", async () => {
    const streamFn = setupMockStreamText("should not run");
    const toolRegistry = createTestRegistry([
      ...leadAgentDefinition.tools.authorized.map(makeTool),
      worktreeEnterTool,
      worktreeExitTool,
    ]);
    const parentSessionId = crypto.randomUUID();
    createStore(parentSessionId, tmpRoot, { agentName: "lead" });
    const store = createStore(crypto.randomUUID(), tmpRoot, {
      rootSessionId: parentSessionId,
      parentSessionId,
      agentName: "explore",
    });
    const agent = createAgent({
      definition: exploreAgentDefinition,
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

  test("extraTools enter the searchable catalog without becoming initially visible", async () => {
    const streamFn = setupMockStreamText("extra tools ok");
    const toolRegistry = createTestRegistry([
      ...leadAgentDefinition.tools.authorized.map(makeTool),
      makeTool("github_get_pull_request"),
      makeTool("github_create_issue_comment"),
    ]);
    const agent = createAgent({ definition: leadAgentDefinition, toolRegistry });
    const authorization = {
      extraTools: ["github_get_pull_request", "github_create_issue_comment"],
      toolProjection: null,
    };
    const live = await agent.resolveLiveAuthorizedToolCatalog(authorization);
    expect(live.catalog.entries.find((entry) => entry.registryName === "file_read")?.sourceKind).toBe("builtin");
    expect(live.catalog.entries.find((entry) => entry.registryName === "github_get_pull_request")?.sourceKind).toBe("overlay");

    await runAgent(agent, "extra tools run", {
      toolAuthorizationSnapshot: authorization,
    });

    const callArgs = streamFn.mock.calls[0]![0] as { system: string; tools: Record<string, unknown> };
    expect(callArgs.system).toContain("- file_read");
    expect(callArgs.system).toContain("- file_write");
    expect(callArgs.system).toContain("- bash");
    expect(callArgs.system).toContain("- tool_search");
    expect(callArgs.system).not.toContain("- github_get_pull_request");
    expect(callArgs.system).not.toContain("- github_create_issue_comment");
    expect(callArgs.system).toContain('"name":"github_get_pull_request"');
    expect(callArgs.system).toContain('"name":"github_create_issue_comment"');
    expect(callArgs.system).toContain("select:<exact-name>");
    expect(callArgs.system).not.toContain("github_rerun_workflow_run");
    expect(Object.keys(callArgs.tools)).not.toContain("github_get_pull_request");
    expect(Object.keys(callArgs.tools)).not.toContain("github_create_issue_comment");
  });

  test("does not advertise an unreachable deferred directory when tool_search is projected out", async () => {
    const streamFn = setupMockStreamText("restricted tools ok");
    const toolRegistry = createTestRegistry(leadAgentDefinition.tools.authorized.map(makeTool));
    const agent = createAgent({ definition: leadAgentDefinition, toolRegistry });
    const authorization = {
      extraTools: [],
      toolProjection: [...leadAgentDefinition.tools.core, "compress"],
    };

    await runAgent(agent, "restricted tools run", { toolAuthorizationSnapshot: authorization });

    const callArgs = streamFn.mock.calls[0]![0] as { system: string; tools: Record<string, unknown> };
    expect(callArgs.system).toContain("Deferred tool directory:\n- none");
    expect(callArgs.system).not.toContain('"name":"compress"');
    expect(Object.keys(callArgs.tools)).not.toContain("tool_search");
    expect(Object.keys(callArgs.tools)).not.toContain("compress");
  });

  test("rejects a provider-forged deferred tool from an empty model boundary", async () => {
    const streamFn = setupToolCallStreamText("compress");
    const execute = mock(async () => createTextToolResult("must not run"));
    const compressTool: AnyToolDescriptor = {
      ...makeTool("compress"),
      execute,
    };
    const toolRegistry = createTestRegistry(leadAgentDefinition.tools.authorized.map((name) =>
      name === "compress" ? compressTool : makeTool(name)
    ));
    const agent = createAgent({ definition: leadAgentDefinition, toolRegistry });

    await runAgent(agent, "forge a hidden deferred tool", {
      maxSteps: 2,
      toolAuthorizationSnapshot: {
        extraTools: [],
        toolProjection: ["compress"],
      },
    });

    const firstBoundary = streamFn.mock.calls[0]![0] as { tools?: Record<string, unknown> };
    expect(Object.keys(firstBoundary.tools ?? {})).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    const result = agent.store.getState().events.find((event) =>
      event.payload.type === "tool-result" && event.payload.toolCallId === "tool-call-1"
    );
    expect(result?.payload).toMatchObject({
      type: "tool-result",
      result: { isError: true, details: { error: { code: "TOOL_NOT_ALLOWED" } } },
    });
  });

  test("observes one exact search, loaded reuse, and target execution across the real tool pipeline", async () => {
    const { logger, entries } = createInMemoryLogger();
    const audits: AuditEvent[] = [];
    const execute = mock(async () => createTextToolResult("compressed"));
    const compressTool: AnyToolDescriptor = {
      ...makeTool("compress"),
      execute,
    };
    const fixture = createTestToolRegistryFixture({
      logger,
      descriptors: leadAgentDefinition.tools.authorized.map((name) => {
        if (name === TOOL_TOOL_SEARCH) return toolSearchTool;
        if (name === "compress") return compressTool;
        return makeTool(name);
      }),
    });
    registryFixtures.push(fixture);
    fixture.registry.globalHooks.finalized.push(createAuditHook({
      sink: (event) => { audits.push(event); },
    }));
    const modelBoundaries: Array<Record<string, unknown>> = [];
    let round = 0;
    const streamFn = mock((options: { tools?: Record<string, unknown> }) => {
      modelBoundaries.push(options.tools ?? {});
      round += 1;
      if (round <= 2) {
        const toolName = round === 1 ? TOOL_TOOL_SEARCH : "compress";
        const input = round === 1 ? { query: "select:compress" } : {};
        const toolCallId = `observed-tool-${round}`;
        return {
          fullStream: (async function* () {
            yield { type: "tool-call", toolCallId, toolName, input };
          })(),
          finishReason: Promise.resolve("tool-calls"),
          text: Promise.resolve(""),
          toolCalls: Promise.resolve([{ toolCallId, toolName, input }]),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        };
      }
      return {
        fullStream: (async function* () {
          yield { type: "text-start", id: "output" };
          yield { type: "text-delta", id: "output", text: "done" };
          yield { type: "text-end", id: "output" };
        })(),
        finishReason: Promise.resolve("stop"),
        text: Promise.resolve("done"),
        toolCalls: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      };
    });
    setLlmAdapterForTest({ streamText: streamFn as unknown as typeof import("ai").streamText });
    const agent = createAgent({
      definition: leadAgentDefinition,
      toolRegistry: fixture.registry,
      logger,
    });

    await runAgent(agent, "load and reuse one deferred tool", { maxSteps: 3 });

    expect(Object.keys(modelBoundaries[0]!)).not.toContain("compress");
    expect(Object.keys(modelBoundaries[1]!)).toContain("compress");
    expect(Object.keys(modelBoundaries[2]!)).toContain("compress");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: TOOL_TOOL_SEARCH,
        input: { query: "select:compress", limit: 5 },
        status: "success",
      }),
      expect.objectContaining({ toolName: "compress", input: {}, status: "success" }),
    ]));
    const promptLogs = entries.filter((entry) => entry.event === "prompt.compiled");
    expect(promptLogs).toHaveLength(3);
    expect(promptLogs[0]?.meta?.toolVisibility).toMatchObject({
      catalogDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      state: [],
      loaded: [],
      deferredCount: expect.any(Number),
    });
    expect(promptLogs[1]?.meta?.toolVisibility).toMatchObject({ loaded: ["compress"] });
    expect(promptLogs[2]?.meta?.toolVisibility).toMatchObject({ loaded: ["compress"] });
    const loadedLog = entries.find((entry) => entry.event === "tool.search.loaded");
    expect(loadedLog).toMatchObject({
      meta: {
        catalogDigest: promptLogs[0]?.meta?.toolVisibility
          && (promptLogs[0]!.meta!.toolVisibility as { catalogDigest: string }).catalogDigest,
        loadedToolRefs: [{
          name: "compress",
          descriptorDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        }],
      },
    });
    expect(agent.store.getState().messages.filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.toolName === TOOL_TOOL_SEARCH)).toHaveLength(1);
  });

  test("extraTools effective tools are enforced in tool execution context", async () => {
    setupToolCallStreamText("github_create_issue_comment");
    let capturedAllowedTools: string[] = [];
    const toolRegistry = createTestRegistry([
      ...leadAgentDefinition.tools.authorized.map(makeTool),
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
    const store = createStore(crypto.randomUUID(), tmpRoot, { agentName: "lead" });
    // ProjectContextResolver scans durable Session identities. Mirror the
    // production createSessionFile barrier instead of racing the queued write.
    await storeManager.flushSession(store.getState().sessionId, tmpRoot);
    const agent = createAgent({ definition: leadAgentDefinition, toolRegistry, store });
    const toolAuthorizationSnapshot = {
      extraTools: ["github_create_issue_comment"],
      toolProjection: null,
    };
    const catalog = await agent.resolveLiveAuthorizedToolCatalog(toolAuthorizationSnapshot);
    const loaded = catalog.catalog.entries.find(
      (entry) => entry.registryName === "github_create_issue_comment",
    )!;

    await runAgent(agent, "comment on PR", {
      maxSteps: 1,
      toolAuthorizationSnapshot,
      loadedToolRefs: [{ name: loaded.registryName, descriptorDigest: loaded.descriptorDigest }],
    });

    expect(capturedAllowedTools).toContain("file_read");
    expect(capturedAllowedTools).toContain("file_write");
    expect(capturedAllowedTools).toContain("bash");
    expect(capturedAllowedTools).toContain("github_create_issue_comment");
  });

  test("unknown extraTools fail before model execution", async () => {
    const streamFn = setupMockStreamText("should not run");
    const agent = createAgent({ definition: leadAgentDefinition });

    await expect(runAgent(agent, "unknown extra", { extraTools: ["missing_extra_tool"] })).rejects.toThrow(UnknownExtraToolError);
    expect(streamFn).not.toHaveBeenCalled();
  });

  test("fails closed when a persisted active Skill is deleted between runs", async () => {
    const streamFn = setupMockStreamText("active skill loaded");
    const skillName = "ephemeral-skill";
    const skillDir = join(tmpRoot, ".archcode", "skills", skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), [
      "---",
      `name: ${skillName}`,
      "description: Temporary skill. Use for this test.",
      "---",
      "Temporary instructions.",
    ].join("\n"));

    const store = createStore(crypto.randomUUID(), tmpRoot, {
      agentName: "lead",
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
        { name: skillName, source: resolve(skillDir) },
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
      snapshotForAgent: mock(async () => null),
      projectPromptCatalog: mock(async () => { throw new Error("skill index unreadable"); }),
    } as unknown as SkillService;
    const store = createStore(crypto.randomUUID(), tmpRoot, { agentName: "lead" });
    const agent = createAgent({ definition: leadAgentDefinition, skillService, store });

    await expect(runAgent(agent, "list skills")).rejects.toThrow("skill index unreadable");

    const events = store.getState().events.map((event) => event.payload);
    const traceIndex = events.findIndex((event) => event.type === "prompt-trace");
    const errorIndex = events.findIndex((event) => event.type === "execution-error");
    expect(events[traceIndex]).toMatchObject({ type: "prompt-trace", trace: { status: "error", skills: { status: "error", active: [] } } });
    expect(traceIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThan(traceIndex);
    expect(streamFn).not.toHaveBeenCalled();
  });
  test("injects complete prompt Memory only when enabled without state-activating Memory tools", async () => {
    const preferences = "# Preferences\n\nKeep conclusions concise and evidence-backed.";
    const index = "- [Build Tooling](build_tools) — Bun commands and repository conventions\n";
    const topicBody = "PRIVATE TOPIC BODY MUST REQUIRE memory_read";
    const readPromptManifest = mock(async () => ({
      preferences: { content: preferences, availableForPrompt: true },
      index: { content: index, availableForPrompt: true },
      topics: [{ name: "build_tools", content: topicBody }],
    }));
    const projectContextResolver = await createPromptMemoryResolver(tmpRoot, readPromptManifest);
    const toolRegistry = makeToolRegistry();
    toolRegistry.register(makeTool("memory_read"));
    toolRegistry.register(makeTool("memory_write"));

    const enabledStream = setupMockStreamText("memory enabled");
    await runAgent(createAgent({ definition: leadAgentDefinition, projectContextResolver, toolRegistry }), "with memory", {
      memoryPolicy: new MemoryPolicyRuntime({ useMemory: true, autoLearning: true }).claim(),
    });
    const enabled = enabledStream.mock.calls[0]![0] as { system: string; tools?: Record<string, unknown> };
    expect(enabled.system).toContain(`Preferences:\n${preferences}`);
    expect(enabled.system).toContain(`Index:\n${index}`);
    expect(enabled.system).not.toContain(topicBody);
    expect(Object.keys(enabled.tools ?? {})).not.toContain("memory_read");
    expect(Object.keys(enabled.tools ?? {})).not.toContain("memory_write");

    const disabledStream = setupMockStreamText("memory disabled");
    await runAgent(createAgent({ definition: leadAgentDefinition, projectContextResolver, toolRegistry }), "without memory", {
      memoryPolicy: new MemoryPolicyRuntime({ useMemory: false, autoLearning: true }).claim(),
    });
    const disabled = disabledStream.mock.calls[0]![0] as { system: string; tools?: Record<string, unknown> };
    expect(disabled.system).toContain("Status: absent. Memory is non-authoritative historical context.");
    expect(disabled.system).not.toContain(preferences);
    expect(disabled.system).not.toContain(index);
    expect(Object.keys(disabled.tools ?? {})).not.toContain("memory_read");
    expect(Object.keys(disabled.tools ?? {})).not.toContain("memory_write");
    expect(readPromptManifest).toHaveBeenCalledTimes(1);
  });

  test("omits only an over-cap prompt root and never injects topic bodies", async () => {
    const compliantPreferences = "complete compliant preferences";
    const compliantIndex = "- [Oversized](oversized) — legacy topic remains discoverable\n";
    const oversizedPreferences = "OVERSIZED PERSONAL BODY";
    const oversizedIndex = "OVERSIZED GENERATED INDEX";
    const oversizedTopicBody = "OVERSIZED TOPIC BODY";
    const cases = [
      {
        name: "preferences",
        manifest: {
          preferences: { content: oversizedPreferences, availableForPrompt: false },
          index: { content: compliantIndex, availableForPrompt: true },
        },
        present: compliantIndex,
        notice: "Personal Memory omitted because preferences exceed 8 KiB",
        absent: oversizedPreferences,
      },
      {
        name: "index",
        manifest: {
          preferences: { content: compliantPreferences, availableForPrompt: true },
          index: { content: oversizedIndex, availableForPrompt: false },
        },
        present: compliantPreferences,
        notice: "Project Memory index omitted because the project exceeds 200 topics",
        absent: oversizedIndex,
      },
      {
        name: "single oversized topic",
        manifest: {
          preferences: { content: compliantPreferences, availableForPrompt: true },
          index: { content: compliantIndex, availableForPrompt: true },
          topics: [{ name: "oversized", content: oversizedTopicBody }],
        },
        present: compliantIndex,
        notice: null,
        absent: oversizedTopicBody,
      },
    ] as const;

    for (const scenario of cases) {
      const resolver = await createPromptMemoryResolver(tmpRoot, async () => scenario.manifest);
      const stream = setupMockStreamText(scenario.name);
      await runAgent(createAgent({ definition: leadAgentDefinition, projectContextResolver: resolver }), scenario.name);
      const system = (stream.mock.calls[0]![0] as { system: string }).system;
      expect(system).toContain(scenario.present);
      expect(system).not.toContain(scenario.absent);
      if (scenario.notice === null) {
        expect(system).not.toContain("omitted because");
      } else {
        expect(system).toContain(scenario.notice);
      }
    }
  });

  test("sanitizes Prompt Memory read failures before Prompt, durable trace, and logs", async () => {
    const secret = "sk_test_prompt_memory_secret_1234567890";
    const privatePath = `/private/sensitive/${secret}/index.md`;
    const readFailure = new Error(`EACCES: permission denied, stat '${privatePath}'`, {
      cause: new Error(`underlying storage failure ${secret}`),
    });
    const resolver = await createPromptMemoryResolver(tmpRoot, async () => {
      throw readFailure;
    });
    const { logger, entries } = createInMemoryLogger();
    const store = createStore(crypto.randomUUID(), tmpRoot, { agentName: "lead" });
    const stream = setupMockStreamText("memory unavailable");

    await runAgent(createAgent({
      definition: leadAgentDefinition,
      projectContextResolver: resolver,
      logger,
      store,
    }), "read memory safely");

    const prompt = (stream.mock.calls[0]![0] as { system: string }).system;
    expect(prompt).toContain(
      "Status: unavailable. Continue from current runtime, files, tools, and user instructions.",
    );
    expect(prompt).not.toContain(privatePath);
    expect(prompt).not.toContain(secret);

    const expectedWarning =
      "kind=memory-read code=MEMORY_PROMPT_READ_FAILED Memory could not be read. Continue without Memory.";
    const trace = store.getState().promptTraces?.at(-1);
    expect(trace).toMatchObject({
      status: "compiled",
      memory: "error",
      warnings: [expectedWarning],
    });
    await storeManager.flushSession(store.getState().sessionId, tmpRoot);
    const durableSession = await Bun.file(
      join(tmpRoot, "sessions", store.getState().sessionId, "session.json"),
    ).text();
    expect(durableSession).toContain(expectedWarning);
    expect(durableSession).not.toContain(privatePath);
    expect(durableSession).not.toContain(secret);

    const serializedLogs = JSON.stringify(entries);
    const compiledLog = entries.find((entry) => entry.event === "prompt.compiled");
    expect(compiledLog).toBeDefined();
    expect(compiledLog?.meta?.toolVisibility).toMatchObject({
      catalogDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      core: expect.arrayContaining(["file_read", "grep", "glob"]),
      state: [],
      loaded: [],
      deferredCount: expect.any(Number),
    });
    expect(prompt).toMatch(/toolCatalogDigest=[0-9a-f]{64}/);
    expect(prompt).toMatch(/toolDeferredCount=\d+/);
    expect(trace?.visibleTools).toEqual(expect.arrayContaining(["file_read", "grep", "glob"]));
    expect(serializedLogs).toContain(expectedWarning);
    expect(serializedLogs).not.toContain(privatePath);
    expect(serializedLogs).not.toContain(secret);
  });

  test("reuses one Memory snapshot across multiple model builds in the same run", async () => {
    let manifest = {
      preferences: { content: "initial preferences", availableForPrompt: true },
      index: { content: "initial index", availableForPrompt: true },
    };
    const readPromptManifest = mock(async () => manifest);
    const resolver = await createPromptMemoryResolver(tmpRoot, readPromptManifest);
    const toolRegistry = makeToolRegistry();
    toolRegistry.register({
      ...makeTool("mutate_memory_fixture"),
      execute: () => {
        manifest = {
          preferences: { content: "changed preferences", availableForPrompt: true },
          index: { content: "changed index", availableForPrompt: true },
        };
        return createTextToolResult("memory changed outside the active prompt snapshot");
      },
    });
    const definition = {
      ...leadAgentDefinition,
      tools: {
        ...leadAgentDefinition.tools,
        authorized: [...leadAgentDefinition.tools.authorized, "mutate_memory_fixture"],
      },
    } satisfies AgentDefinition;
    const stream = setupToolCallStreamText("mutate_memory_fixture");

    await runAgent(createAgent({ definition, projectContextResolver: resolver, toolRegistry }), "build twice");

    expect(stream).toHaveBeenCalledTimes(2);
    for (const call of stream.mock.calls) {
      const system = (call[0] as { system: string }).system;
      expect(system).toContain("initial preferences");
      expect(system).toContain("initial index");
      expect(system).not.toContain("changed preferences");
      expect(system).not.toContain("changed index");
    }
    expect(readPromptManifest).toHaveBeenCalledTimes(1);
  });

  test("Lead tool execution context uses Lead attribution at depth zero", async () => {
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
        ...leadAgentDefinition,
        tools: { ...leadAgentDefinition.tools, authorized: ["capture_context"], core: ["capture_context"] },
      },
      toolRegistry,
    }), "root context");

    expect(capturedAgentName).toBe("lead");
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
      definition: { ...exploreAgentDefinition, tools: { authorized: ["capture_context"], core: ["capture_context"] } },
      depth: 1,
      toolRegistry,
    }), "explorer context");

    expect(capturedAgentName).toBe("explore");
    expect(capturedDepth).toBe(1);
  });

  test("production no-state deferred builtins match the locked search corpus", async () => {
    for (const definition of defaultAgentDefinitions) {
      const store = definition.name === "discussion"
        ? createStore(crypto.randomUUID(), tmpRoot, {
            agentName: "discussion",
            source: { kind: "todo", todoId: crypto.randomUUID(), entry: "discussion" },
          })
        : undefined;
      const agent = createAgent({ definition, toolRegistry: productionBuiltinRegistryFixture.registry, store });
      const live = await agent.resolveLiveAuthorizedToolCatalog({
        extraTools: [],
        toolProjection: [...definition.tools.authorized],
      });
      const projected = projectVisibleTools({
        catalog: live.catalog,
        core: definition.tools.core,
        state: [],
        loaded: [],
      });
      expect(
        projected.deferred.map((entry) => entry.registryName).sort(),
        definition.name,
      ).toEqual([...NO_STATE_DEFERRED_BUILTINS[definition.name]].sort());
    }
  });

  test("keeps MCP deferred until its exact descriptor digest is loaded", async () => {
    const remote = makeTool("mcp__docs__lookup");
    const resolveMcpToolSnapshot = () => ({
      tools: new Map([[remote.name, { descriptor: remote, serverName: "docs", source: "user" as const }]]),
      statuses: {
        servers: {
          docs: { state: "ready" as const, toolCount: 1, warningCount: 0, connectedAt: 1 },
        },
      },
    });
    const toolRegistry = createTestRegistry(leadAgentDefinition.tools.authorized.map(makeTool));
    const agent = createAgent({ definition: leadAgentDefinition, toolRegistry, resolveMcpToolSnapshot });
    const live = await agent.resolveLiveAuthorizedToolCatalog({ extraTools: [], toolProjection: null });
    const remoteEntry = live.catalog.entries.find((entry) => entry.registryName === remote.name)!;
    const initial = projectVisibleTools({
      catalog: live.catalog,
      core: leadAgentDefinition.tools.core,
      state: [],
      loaded: [],
    });
    expect(initial.deferred.map((entry) => entry.registryName)).toContain(remote.name);
    expect(initial.visible.map((entry) => entry.registryName)).not.toContain(remote.name);
    expect(initial.visible.map((entry) => entry.registryName)).toContain(TOOL_TOOL_SEARCH);
    expect(buildDeferredToolDirectory(initial.deferred)).toContain(remote.name);

    const loaded = projectVisibleTools({
      catalog: live.catalog,
      core: leadAgentDefinition.tools.core,
      state: [],
      loaded: [{ name: remote.name, descriptorDigest: remoteEntry.descriptorDigest }],
    });
    expect(loaded.visible.map((entry) => entry.registryName)).toContain(remote.name);
    expect(loaded.deferred.map((entry) => entry.registryName)).not.toContain(remote.name);
    expect(buildDeferredToolDirectory(loaded.deferred)).not.toContain(remote.name);
  });

  test("projects only the fixed state activation table", () => {
    const facts: ToolVisibilityFacts = {
      activeRootGoal: true,
      boundRootDiscussionTodo: true,
      currentExecutionHasPdf: true,
      hasRecoverableOutput: true,
      hasDescendant: true,
      hasRunningDirectChild: true,
      hasBackgroundDirectChild: true,
      hasNonterminalDirectChild: true,
      hasNonterminalDescendant: true,
      hasResumableDirectChild: true,
      worktreeTool: "worktree_enter",
    };
    expect(projectStateActivatedTools(facts)).toEqual([
      "get_goal", "update_goal", "project_todo_update", "pdf_read",
      "output_read", "output_search", "list_agents", "send_message",
      "background_output", "wait_for_reminder", "cancel_session",
      "resume_session", "worktree_enter",
    ]);
    expect(projectStateActivatedTools({
      ...facts,
      activeRootGoal: false,
      boundRootDiscussionTodo: false,
      currentExecutionHasPdf: false,
      hasRecoverableOutput: false,
      hasDescendant: false,
      hasRunningDirectChild: false,
      hasBackgroundDirectChild: false,
      hasNonterminalDirectChild: false,
      hasNonterminalDescendant: false,
      hasResumableDirectChild: false,
      worktreeTool: null,
    })).toEqual([]);
  });

  test("activates output recovery only for artifacts owned by the current logical Execution", async () => {
    setupMockStreamText("done");
    const countRecoverableForExecution = mock(async (executionId: string) => (
      executionId === "current-execution" ? 1 : 0
    ));
    const toolOutputAccess: ConfiguredAgentOptions["toolOutputAccess"] = {
      countRecoverable: async () => 7,
      countRecoverableForExecution,
      read: async () => { throw new Error("not used"); },
      search: async () => { throw new Error("not used"); },
    };
    const toolRegistry = createTestRegistry(leadAgentDefinition.tools.authorized.map(makeTool));
    const agent = createAgent({ definition: leadAgentDefinition, toolRegistry, toolOutputAccess });

    await runAgent(agent, "old family artifacts only", { executionId: "new-execution" });
    expect(agent.store.getState().promptTraces.at(-1)?.visibleTools).not.toContain("output_read");
    expect(agent.store.getState().promptTraces.at(-1)?.visibleTools).not.toContain("output_search");

    await runAgent(agent, "current artifact", { executionId: "current-execution" });
    expect(agent.store.getState().promptTraces.at(-1)?.visibleTools).toEqual(
      expect.arrayContaining(["output_read", "output_search"]),
    );
    expect(countRecoverableForExecution.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(["new-execution", "current-execution"]),
    );
  });

  test("does not take a family-tree snapshot when direct live links already determine visibility", async () => {
    const stream = setupMockStreamText("direct child facts are sufficient");
    const store = createStore(crypto.randomUUID(), tmpRoot, { agentName: "lead" });
    store.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: store.getState().sessionId,
        parentToolCallId: "delegate-live-child",
        toolName: "delegate",
        childSessionId: crypto.randomUUID(),
        childExecutionId: crypto.randomUUID(),
        childAgentName: "analyst",
        childProfile: "deep",
        childSkillNames: [],
        title: "Live child",
        depth: 1,
        background: true,
        status: "running",
        createdAt: 1,
        startedAt: 1,
      },
    });
    const getAgentTreeProjection = mock(async () => {
      throw new Error("family tree should not be resolved for a known live direct child");
    });

    await runAgent(createAgent({
      definition: leadAgentDefinition,
      store,
      getAgentTreeProjection,
    }), "continue while the child is running");

    expect(getAgentTreeProjection).not.toHaveBeenCalled();
    const system = (stream.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain("- list_agents");
    expect(system).toContain("- send_message");
    expect(system).toContain("- background_output");
    expect(system).toContain("- wait_for_reminder");
    expect(system).toContain("- cancel_session");
  });

  test("toolProjection cannot grant a registered tool and depth-filtered delegation cannot be restored", async () => {
    const toolRegistry = createTestRegistry([
      ...leadAgentDefinition.tools.authorized.map(makeTool),
      makeTool("registered_but_unauthorized"),
    ]);
    const agent = createAgent({ definition: leadAgentDefinition, toolRegistry, depth: 3 });
    await expect(agent.resolveLiveAuthorizedToolCatalog({
      extraTools: [],
      toolProjection: ["registered_but_unauthorized"],
    })).rejects.toThrow(UnknownExtraToolError);
    await expect(agent.resolveLiveAuthorizedToolCatalog({
      extraTools: ["delegate"],
      toolProjection: null,
    })).rejects.toThrow(UnknownExtraToolError);
  });

  test("projects each Agent's minimal legal runtime identity at the provider boundary", async () => {
    // The pure projection coverage above retains the no-State Discussion evidence.
    // A real Discussion root must remain Todo-bound, so its legal provider
    // surface includes the identity-required project_todo_update activation.
    const remote = makeTool("mcp__ac02__lookup");
    const resolveMcpToolSnapshot = () => ({
      tools: new Map([[remote.name, { descriptor: remote, serverName: "ac02", source: "user" as const }]]),
      statuses: {
        servers: {
          ac02: { state: "ready" as const, toolCount: 1, warningCount: 0, connectedAt: 1 },
        },
      },
    });
    const discussionResolver = createTestProjectContextResolver(storeManager);
    const discussionContext = await discussionResolver.resolve(tmpRoot);
    const discussionTodo = await discussionContext.todos.createTodo({ content: "AC-02 Discussion identity fixture" });

    for (const definition of defaultAgentDefinitions) {
      const streamFn = setupMockStreamText(`${definition.name} no state`);
      const toolRegistry = createTestRegistry(definition.tools.authorized.map(makeTool));
      const store = definition.name === "discussion"
        ? createStore(crypto.randomUUID(), tmpRoot, {
            agentName: "discussion",
            source: { kind: "todo", todoId: discussionTodo.id, entry: "discussion" },
          })
        : undefined;
      const authorization = {
        extraTools: [],
        toolProjection: null,
      };
      const agent = createAgent({
        definition,
        toolRegistry,
        resolveMcpToolSnapshot,
        store,
        ...(definition.name === "discussion" ? { projectContextResolver: discussionResolver } : {}),
      });
      const expectedVisible = definition.name === "discussion"
        ? [...definition.tools.core, "project_todo_update", TOOL_TOOL_SEARCH]
        : [...definition.tools.core, TOOL_TOOL_SEARCH];
      const live = await agent.resolveLiveAuthorizedToolCatalog(authorization);
      const deferredNames = live.catalog.entries
        .filter((entry) => !expectedVisible.includes(entry.registryName))
        .map((entry) => entry.registryName);

      expect(deferredNames.length, definition.name).toBeGreaterThan(0);
      expect(deferredNames, definition.name).toContain(remote.name);

      await runAgent(agent, `${definition.name} no-state boundary`, { toolAuthorizationSnapshot: authorization });

      const tools = providerToolsAt(streamFn);
      expect(Object.keys(tools).sort(), definition.name).toEqual(expectedVisible.sort());
      for (const deferredName of deferredNames) {
        expect(tools[deferredName], `${definition.name} leaked deferred schema ${deferredName}`).toBeUndefined();
      }
      expect(JSON.stringify(tools), definition.name).not.toContain(remote.name);
    }
  });

  test("removes Goal State activation at the next real model boundary", async () => {
    const goalStream = setupMockStreamText("goal state");
    const goalSessionId = crypto.randomUUID();
    const goalStore = createStore(goalSessionId, tmpRoot, { agentName: "lead" });
    const goalService = new SessionGoalService(storeManager);
    const goal = await goalService.create({
      workspaceRoot: tmpRoot,
      sessionId: goalSessionId,
      authority: { kind: "user_control" },
      objective: "AC-02 Goal state fixture",
    });
    const goalAgent = createAgent({
      definition: leadAgentDefinition,
      store: goalStore,
      sessionGoalService: goalService,
      toolRegistry: createTestRegistry(leadAgentDefinition.tools.authorized.map(makeTool)),
    });

    await runAgent(goalAgent, "Goal active", { executionId: "ac02-goal-active" });
    expect(Object.keys(providerToolsAt(goalStream, 0))).toEqual(expect.arrayContaining(["get_goal", "update_goal"]));

    await goalService.complete({
      workspaceRoot: tmpRoot,
      sessionId: goalSessionId,
      authority: { kind: "agent" },
      reason: "AC-02 state transition",
      expectedInstanceId: goal.instanceId,
      expectedGeneration: goal.generation,
    });
    await runAgent(goalAgent, "Goal completed", { executionId: "ac02-goal-complete" });
    expect(Object.keys(providerToolsAt(goalStream, 1))).not.toContain("get_goal");
    expect(Object.keys(providerToolsAt(goalStream, 1))).not.toContain("update_goal");
  });

  test("removes PDF State activation when the next Execution has no PDF attachment", async () => {
    const streamFn = setupMockStreamText("pdf state");
    const toolRegistry = createTestRegistry(leadAgentDefinition.tools.authorized.map(makeTool));
    const agent = createAgent({ definition: leadAgentDefinition, toolRegistry });
    const pdfAttachment: UserSessionPart = {
      type: "attachment",
      id: "ac02-pdf-part",
      attachment: {
        id: "ac02-pdf",
        name: "ac02.pdf",
        mediaType: "application/pdf",
        sizeBytes: 1,
        kind: "file",
      },
      createdAt: 1,
      completedAt: 1,
    };

    await runAgent(agent, "PDF attached", {
      executionId: "ac02-pdf-present",
      userMessageParts: [pdfAttachment],
    });
    expect(Object.keys(providerToolsAt(streamFn, 0))).toContain("pdf_read");

    await runAgent(agent, "No PDF attached", { executionId: "ac02-pdf-absent" });
    expect(Object.keys(providerToolsAt(streamFn, 1))).not.toContain("pdf_read");
  });

  test("keeps an Execution loaded ref after its State activation disappears", async () => {
    let outputAvailable = true;
    const toolOutputAccess: ConfiguredAgentOptions["toolOutputAccess"] = {
      countRecoverable: async () => outputAvailable ? 1 : 0,
      countRecoverableForExecution: async () => outputAvailable ? 1 : 0,
      read: async () => { throw new Error("not used"); },
      search: async () => { throw new Error("not used"); },
    };
    const clearOutputToolName = "ac02_clear_output_state";
    const definition = {
      ...leadAgentDefinition,
      tools: {
        ...leadAgentDefinition.tools,
        authorized: [...leadAgentDefinition.tools.authorized, clearOutputToolName],
        core: [...leadAgentDefinition.tools.core, clearOutputToolName],
      },
    } satisfies AgentDefinition;
    const clearOutputTool: AnyToolDescriptor = {
      ...makeTool(clearOutputToolName),
      execute: async () => {
        outputAvailable = false;
        return createTextToolResult("output state cleared");
      },
    };
    const toolRegistry = createTestRegistry(definition.tools.authorized.map((name) =>
      name === clearOutputToolName ? clearOutputTool : makeTool(name)
    ));
    const agent = createAgent({ definition, toolRegistry, toolOutputAccess });
    const live = await agent.resolveLiveAuthorizedToolCatalog({ extraTools: [], toolProjection: null });
    const outputRead = live.catalog.entries.find((entry) => entry.registryName === "output_read");
    if (outputRead === undefined) throw new Error("AC-02 fixture could not resolve output_read");

    const streamFn = setupToolCallStreamText(clearOutputToolName);
    await runAgent(agent, "clear output state", {
      executionId: "ac02-output-state",
      maxSteps: 2,
      loadedToolRefs: [{ name: outputRead.registryName, descriptorDigest: outputRead.descriptorDigest }],
    });

    const firstTools = providerToolsAt(streamFn, 0);
    const secondTools = providerToolsAt(streamFn, 1);
    expect(firstTools).toHaveProperty("output_read");
    expect(firstTools).toHaveProperty("output_search");
    expect(secondTools).toHaveProperty("output_read");
    expect(secondTools).not.toHaveProperty("output_search");
    expect(agent.store.getState().executions.find((execution) => execution.id === "ac02-output-state")?.loadedToolRefs)
      .toEqual([{ name: outputRead.registryName, descriptorDigest: outputRead.descriptorDigest }]);
  });

  test("removes every child State activation at the next model boundary", async () => {
    const childCases = [
      {
        name: "descendant",
        status: "completed" as const,
        background: false,
        expected: ["list_agents", "resume_session"],
      },
      {
        name: "running-direct-child",
        status: "running" as const,
        background: false,
        expected: ["list_agents", "send_message", "wait_for_reminder", "cancel_session"],
      },
      {
        name: "background-direct-child",
        status: "completed" as const,
        background: true,
        expected: ["list_agents", "background_output", "resume_session"],
      },
      {
        name: "nonterminal-direct-child",
        status: "waiting_for_human" as const,
        background: false,
        expected: ["list_agents", "wait_for_reminder", "cancel_session"],
      },
      {
        name: "nonterminal-descendant",
        status: "completed" as const,
        background: false,
        expected: ["list_agents", "cancel_session", "resume_session"],
        deeper: true,
      },
      {
        name: "resumable-direct-child",
        status: "failed" as const,
        background: false,
        expected: ["list_agents", "resume_session"],
      },
    ] as const;
    const childTools = [
      "list_agents",
      "send_message",
      "background_output",
      "wait_for_reminder",
      "cancel_session",
      "resume_session",
    ];

    for (const scenario of childCases) {
      const streamFn = setupMockStreamText(`${scenario.name} state`);
      const store = createStore(crypto.randomUUID(), tmpRoot, { agentName: "lead" });
      const rootSessionId = store.getState().rootSessionId;
      const childSessionId = `ac02-${scenario.name}-child`;
      const childExecutionId = `ac02-${scenario.name}-execution`;
      const link = {
        parentSessionId: rootSessionId,
        parentToolCallId: `ac02-${scenario.name}-call`,
        toolName: "delegate",
        childSessionId,
        childExecutionId,
        childAgentName: "analyst",
        childProfile: "deep" as const,
        childSkillNames: [],
        title: `AC-02 ${scenario.name}`,
        depth: 1,
        background: scenario.background,
        status: scenario.status,
        createdAt: 1,
        startedAt: 1,
      } satisfies ToolChildSessionLink;
      store.getState().append({ type: "tool-child-session-link", link });

      let getAgentTreeProjection: ConfiguredAgentOptions["getAgentTreeProjection"];
      if ("deeper" in scenario && scenario.deeper) {
        const summary = (
          sessionId: string,
          agentName: "lead" | "analyst" | "explore",
          profile: "principal" | "deep" | "fast",
          parentSessionId?: string,
        ): AgentTreeNode["session"] => ({
          sessionId,
          cwd: tmpRoot,
          rootSessionId,
          ...(parentSessionId === undefined ? {} : { parentSessionId }),
          agentName,
          profile,
          activeSkillNames: [],
          modelSelection: { revision: 0 },
          title: null,
          createdAt: 1,
          updatedAt: 1,
        });
        const grandchild: AgentTreeNode = {
          session: summary("ac02-grandchild", "explore", "fast", childSessionId),
          depth: 2,
          latestExecutionStatus: "running",
          activeExecutionId: "ac02-grandchild-execution",
          linkStatus: "running",
          children: [],
        };
        getAgentTreeProjection = async (): Promise<AgentTreeProjection> => ({
          root: {
            session: summary(rootSessionId, "lead", "principal"),
            depth: 0,
            latestExecutionStatus: "completed",
            activeExecutionId: null,
            linkStatus: null,
            children: [{
              session: summary(childSessionId, "analyst", "deep", rootSessionId),
              depth: 1,
              latestExecutionStatus: "completed",
              activeExecutionId: null,
              linkStatus: "completed",
              children: [grandchild],
            }],
          },
          diagnostics: [],
        });
      }

      const agent = createAgent({
        definition: leadAgentDefinition,
        store,
        getAgentTreeProjection,
        toolRegistry: createTestRegistry(leadAgentDefinition.tools.authorized.map(makeTool)),
      });
      await runAgent(agent, `${scenario.name} active`, { executionId: `ac02-${scenario.name}-active` });
      const activeTools = providerToolsAt(streamFn, 0);
      for (const expected of scenario.expected) expect(activeTools).toHaveProperty(expected);

      store.setState({ childSessionLinks: [] });
      await runAgent(agent, `${scenario.name} cleared`, { executionId: `ac02-${scenario.name}-cleared` });
      const clearedTools = providerToolsAt(streamFn, 1);
      for (const childTool of childTools) expect(clearedTools).not.toHaveProperty(childTool);
    }
  });

  test("recomputes provider worktree tools when the root Session changes cwd", async () => {
    const toolRegistry = createTestRegistry([
      ...leadAgentDefinition.tools.authorized.map(makeTool),
      worktreeEnterTool,
      worktreeExitTool,
    ]);
    const store = createStore(crypto.randomUUID(), tmpRoot, { agentName: "lead", cwd: tmpRoot });
    const rootStream = setupMockStreamText("canonical cwd");
    const rootAgent = createAgent({
      definition: leadAgentDefinition,
      store,
      toolRegistry,
      projectRoot: tmpRoot,
      cwd: tmpRoot,
    });

    await runAgent(rootAgent, "canonical checkout", { executionId: "ac02-canonical-cwd" });
    expect(providerToolsAt(rootStream, 0)).toHaveProperty("worktree_enter");
    expect(providerToolsAt(rootStream, 0)).not.toHaveProperty("worktree_exit");

    store.setState({ cwd: worktreeRoot });
    const worktreeStream = setupMockStreamText("worktree cwd");
    const worktreeAgent = createAgent({
      definition: leadAgentDefinition,
      store,
      toolRegistry,
      projectRoot: tmpRoot,
      cwd: worktreeRoot,
    });
    await runAgent(worktreeAgent, "worktree checkout", { executionId: "ac02-worktree-cwd" });
    expect(providerToolsAt(worktreeStream, 0)).not.toHaveProperty("worktree_enter");
    expect(providerToolsAt(worktreeStream, 0)).toHaveProperty("worktree_exit");
    store.setState({ cwd: tmpRoot });
  });
});
