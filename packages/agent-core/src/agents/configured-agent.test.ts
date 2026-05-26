import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ModelInfo } from "../provider/model";
import type { Registry as ProviderRegistry } from "../provider/index";
import { SkillService } from "../skills";
import type { ResolvedSkill } from "../skills/types";
import { storeManager } from "../store/store";
import { __setSessionsDirForTest } from "../store/sessions-dir";
import { createRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { DELEGATION_TOOLS, EXPLORER_READ_ONLY_TOOLS, MAX_SUB_AGENT_DEPTH } from "./constants";
import { ConfiguredAgent } from "./configured-agent";
import { exploreAgentDefinition, orchestratorAgentDefinition } from "./definitions";
import type { AgentDefinition } from "./factory-types";
import { __setStreamTextForTest } from "./query/loop";
import { MissingProjectContextError } from "./errors";
import type { MemoryExtractionConfig } from "../config";

const tmpRoot = join(import.meta.dir, "__test_tmp__", "configured-agent");

function createTestSkillService(): SkillService {
  return new SkillService({ builtinSkills: {} });
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
    execute: () => `${name} result`,
  };
}

function makeProviderRegistry(): ProviderRegistry {
  const fallbackModel = new ModelInfo({
    model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
    config: {
      name: "Fallback Model",
      limit: { context: 128_000, output: 8_192 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "test",
    modelId: "fallback",
  });

  const configuredModel = new ModelInfo({
    model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
    config: {
      name: "Configured Model",
      limit: { context: 64_000, output: 4_096 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "test",
    modelId: "configured",
  });

  return {
    sdkRegistry: {} as ProviderRegistry["sdkRegistry"],
    models: new Map([
      [fallbackModel.qualifiedId, fallbackModel],
      [configuredModel.qualifiedId, configuredModel],
    ]),
    modelIds: [fallbackModel.qualifiedId, configuredModel.qualifiedId],
    getModel: (qualifiedId: string) => {
      if (qualifiedId === fallbackModel.qualifiedId) return fallbackModel;
      if (qualifiedId === configuredModel.qualifiedId) return configuredModel;
      throw new Error(`unexpected model lookup: ${qualifiedId}`);
    },
  } as ProviderRegistry;
}

function makeModelInfo(): ModelInfo {
  return makeProviderRegistry().getModel("test:configured");
}

function makeToolRegistry() {
  return createRegistry([
    makeTool("unknown_tool"),
    ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
    ...DELEGATION_TOOLS.map(makeTool),
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

  __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);
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

  __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);
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
  quotaEnforcer?: (directory: string) => Promise<void>;
  workspaceRoot?: string;
  depth?: number;
  toolRegistry?: ReturnType<typeof makeToolRegistry>;
  providerRegistry?: ProviderRegistry;
  modelInfo?: ModelInfo;
  memoryConfig?: MemoryExtractionConfig;
  skillService?: SkillService;
  activeSkills?: readonly ResolvedSkill[];
}) {
  const toolRegistry = options.toolRegistry ?? makeToolRegistry();
  const providerRegistry = options.providerRegistry ?? makeProviderRegistry();
  return new ConfiguredAgent({
    definition: options.definition,
    providerRegistry,
    modelInfo: options.modelInfo ?? providerRegistry.getModel("test:configured"),
    modelOptions: { temperature: 0.3 },
    toolRegistry,
    skillService: options.skillService ?? createTestSkillService(),
    activeSkills: options.activeSkills,
    store: options.store,
    workspaceRoot: options.workspaceRoot ?? tmpRoot,
    depth: options.depth,
    backgroundTaskManager: options.btm as never,
    memoryConfig: options.memoryConfig,
    quotaEnforcer: options.quotaEnforcer,
      resolveAllowedTools: (definition, depth) => {
        const resolved = toolRegistry.resolveForAgent(definition.tools.tools).descriptors.map((tool) => tool.name);
        if (depth >= MAX_SUB_AGENT_DEPTH) {
          return resolved.filter((name) => !(DELEGATION_TOOLS as readonly string[]).includes(name));
        }
      return resolved;
    },
  });
}

describe("ConfiguredAgent", () => {
  beforeAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(join(tmpRoot, ".specra", "memory"), { recursive: true });
    await writeFile(join(tmpRoot, ".specra", "memory", "index.md"), "");
    await writeFile(join(tmpRoot, "AGENTS.md"), "# Test Project\n\nMinimal project context.");
    __setSessionsDirForTest(() => join(tmpRoot, "sessions"));
  });

  afterEach(() => {
    __setStreamTextForTest(
      (() => {
        throw new Error("streamText not mocked");
      }) as unknown as typeof import("ai").streamText,
    );
  });

  afterAll(async () => {
    __setSessionsDirForTest(undefined);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("orchestrator definition produces all configured lifecycle hooks", async () => {
    const streamFn = setupMockStreamText("root ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(`configured-root-${crypto.randomUUID()}`);
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

    const agent = createAgent({ definition: orchestratorAgentDefinition, store, btm });
    await agent.run("root run");

    const callArgs = streamFn.mock.calls[0]![0] as { messages: unknown[] };
    expect(JSON.stringify(callArgs.messages)).toContain("remember this");
    expect(agent.store.getState().reminders.some((reminder) => reminder.source.type === "todo_loop_continuation")).toBe(true);
    expect(btm.dispatched).toContain("title-generation");
    expect(btm.drainCalls).toBe(1);
  });

  test("throws MissingProjectContextError when workspaceRoot is not provided", () => {
    const providerRegistry = makeProviderRegistry();

    expect(() => new ConfiguredAgent({
      definition: exploreAgentDefinition,
      providerRegistry,
      modelInfo: providerRegistry.getModel("test:configured"),
      toolRegistry: makeToolRegistry(),
      skillService: createTestSkillService(),
      resolveAllowedTools: () => [],
    })).toThrow(MissingProjectContextError);

    expect(new MissingProjectContextError("missing context").name).toBe("MissingProjectContextError");
  });

  test("dispose does not cancel a provided shared background task manager", () => {
    const btm = new RecordingBackgroundTaskManager();
    const agent = createAgent({ definition: orchestratorAgentDefinition, btm });

    agent.dispose();

    expect(btm.cancelAllCalls).toBe(0);
  });

  test("constructs without relying on provider registry model order when modelInfo is supplied", async () => {
    setupMockStreamText("explicit model ok");
    const providerRegistry = {
      sdkRegistry: {} as ProviderRegistry["sdkRegistry"],
      models: new Map(),
      modelIds: [],
      getModel: () => {
        throw new Error("unexpected fallback lookup");
      },
    } as ProviderRegistry;

    const agent = createAgent({
      definition: exploreAgentDefinition,
      providerRegistry,
      modelInfo: makeModelInfo(),
    });

    await expect(agent.run("explicit model"))
      .resolves.toEqual({ text: "explicit model ok", steps: 0 });
  });

  test("passes definition skills and SkillService into tool execution context", async () => {
    const skillService = createTestSkillService();
    let capturedContext: { agentSkills: readonly string[]; skillService: SkillService } | undefined;
    const toolRegistry = createRegistry([
      {
        name: "capture_context",
        description: "Capture context",
        inputSchema: z.object({ agentSkills: z.array(z.string()).optional() }).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: false },
        execute: (_input, ctx) => {
          if (!ctx.agentSkills || !ctx.skillService) throw new Error("missing skill context");
          capturedContext = { agentSkills: ctx.agentSkills, skillService: ctx.skillService };
          return "captured";
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

    await agent.run("capture skill context");

    expect(capturedContext?.agentSkills).toEqual(agentSkills);
    expect(capturedContext?.skillService).toBe(skillService);
  });

  test("explorer definition produces auto-compact, auto-inject, and todo-continuation hooks", async () => {
    const streamFn = setupMockStreamText("explore ok");
    const store = storeManager.create(`configured-explore-${crypto.randomUUID()}`);
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
    await agent.run("explore run");

    const callArgs = streamFn.mock.calls[0]![0] as { messages: unknown[] };
    expect(JSON.stringify(callArgs.messages)).toContain("explorer reminder");
    expect(agent.store.getState().reminders.some((reminder) => reminder.source.type === "todo_loop_continuation")).toBe(true);
  });

  test("orchestrator definition dispatches memory background hooks", async () => {
    setupMockStreamText("orchestrator memory ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(`configured-orchestrator-background-${crypto.randomUUID()}`);
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
    await writeFile(join(tmpRoot, ".specra", "memory", "index.md"), `${Array.from({ length: 251 }, (_, index) => `topic-${index}`).join("\n")}\n`);

    const agent = createAgent({ definition: orchestratorAgentDefinition, store, btm });
    await agent.run("root run");

    expect(btm.dispatched).toContain("memory-extraction");
    expect(btm.dispatched).toContain("memory-consolidation");
  });

  test("memory config disabled skips memory background hooks", async () => {
    setupMockStreamText("memory disabled ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(`configured-memory-disabled-${crypto.randomUUID()}`);
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
    await writeFile(join(tmpRoot, ".specra", "memory", "index.md"), `${Array.from({ length: 251 }, (_, index) => `topic-${index}`).join("\n")}\n`);

    const agent = createAgent({
      definition: orchestratorAgentDefinition,
      store,
      btm,
      memoryConfig: { enabled: false, minMessages: 1, minContentLength: 100, cooldownMs: 0 },
    });
    await agent.run("root run");

    expect(btm.dispatched).not.toContain("memory-extraction");
    expect(btm.dispatched).not.toContain("memory-consolidation");
  });

  test("memory config custom thresholds are used by extraction hook", async () => {
    setupMockStreamText("memory custom ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(`configured-memory-custom-${crypto.randomUUID()}`);
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
      definition: orchestratorAgentDefinition,
      store,
      btm,
      memoryConfig: { enabled: true, minMessages: 1, minContentLength: 100, cooldownMs: 0 },
    });
    await agent.run("root run");

    expect(btm.dispatched).toContain("memory-extraction");
  });

  test("memory config absent uses default extraction thresholds", async () => {
    setupMockStreamText("memory defaults ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(`configured-memory-defaults-${crypto.randomUUID()}`);
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

    const agent = createAgent({ definition: orchestratorAgentDefinition, store, btm });
    await agent.run("root run");

    expect(btm.dispatched).not.toContain("memory-extraction");
  });

  test('titleGeneration "unless-supplied" skips when store title already exists', async () => {
    setupMockStreamText("titled ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = storeManager.create(`configured-titled-${crypto.randomUUID()}`);
    store.setState({ title: "Supplied Title" });

    const agent = createAgent({ definition: exploreAgentDefinition, store, btm });
    await agent.run("explore run");

    expect(btm.dispatched).not.toContain("title-generation");
  });

  test('titleGeneration "unless-supplied" dispatches when store title is null', async () => {
    setupMockStreamText("untitled ok");
    const btm = new RecordingBackgroundTaskManager();

    const agent = createAgent({ definition: exploreAgentDefinition, btm });
    await agent.run("explore run");

    expect(btm.dispatched).toContain("title-generation");
  });

  test("enforceToolOutputQuota controls quota enforcement", async () => {
    setupMockStreamText("quota ok");
    const quotaEnforcer = mock(async (_directory: string) => {});

    await createAgent({ definition: orchestratorAgentDefinition, quotaEnforcer }).run("root run");
    expect(quotaEnforcer).toHaveBeenCalledTimes(1);

    await createAgent({ definition: exploreAgentDefinition, quotaEnforcer }).run("explore run");
    expect(quotaEnforcer).toHaveBeenCalledTimes(1);

    await createAgent({ definition: definitionWith({ enforceToolOutputQuota: false }), quotaEnforcer }).run("no quota");
    expect(quotaEnforcer).toHaveBeenCalledTimes(1);
  });

  test("includeMemoryInPrompt controls memory roots in prompt context", async () => {
    const withMemoryStreamFn = setupMockStreamText("memory ok");
    await createAgent({ definition: exploreAgentDefinition }).run("with memory");
    const withMemory = withMemoryStreamFn.mock.calls[0]![0] as { system: string };
    expect(withMemory.system).toContain("<specra-memory-context>");

    const withoutMemoryStreamFn = setupMockStreamText("memory off ok");
    await createAgent({ definition: definitionWith({ includeMemoryInPrompt: false }) }).run("without memory");
    const withoutMemory = withoutMemoryStreamFn.mock.calls[0]![0] as { system: string };
    expect(withoutMemory.system).not.toContain("<specra-memory-context>");
  });

  test("orchestrator tool execution context uses Orchestrator attribution at depth zero", async () => {
    setupToolCallStreamText("capture_context");
    let capturedAgentName: string | undefined;
    let capturedDepth: number | undefined;
    const toolRegistry = makeToolRegistry();
    toolRegistry.register({
      name: "capture_context",
      description: "Capture execution context",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: true, destructive: false, concurrencySafe: false },
      execute: (_input, ctx) => {
        capturedAgentName = ctx.agentName;
        capturedDepth = ctx.currentDepth;
        return "captured";
      },
    });

    await createAgent({
      definition: { ...orchestratorAgentDefinition, name: "Orchestrator", tools: { tools: ["capture_context"] } },
      toolRegistry,
    }).run("root context");

    expect(capturedAgentName).toBe("Orchestrator");
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
      execute: (_input, ctx) => {
        capturedAgentName = ctx.agentName;
        capturedDepth = ctx.currentDepth;
        return "captured";
      },
    });

    await createAgent({
      definition: { ...exploreAgentDefinition, name: "Explorer", tools: { tools: ["capture_context"] } },
      depth: 1,
      toolRegistry,
    }).run("explorer context");

    expect(capturedAgentName).toBe("Explorer");
    expect(capturedDepth).toBe(1);
  });
});
