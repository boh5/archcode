import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";
import { z } from "zod";
import type { SpecraConfig } from "../config/schema";
import { ModelInfo } from "../provider/model";
import type { Registry as ProviderRegistry } from "../provider/index";
import { SkillService } from "../skills";
import { SessionStoreManager } from "../store/session-store-manager";
import { __setSessionsDirForTest } from "../store/sessions-dir";
import { createRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import type { SessionStoreState } from "../store/types";
import { DELEGATION_TOOLS, EXPLORER_READ_ONLY_TOOLS } from "./constants";
import {
  agentDefinitions,
  builderAgentDefinition,
  foremanAgentDefinition,
  productAgentDefinition,
  exploreAgentDefinition,
  orchestratorAgentDefinition,
  reviewerAgentDefinition,
} from "./definitions";
import { workflowRoleToolPermissions } from "./workflow/permissions";
import {
  ConcurrentLimitError,
  DelegateTargetNotAllowedError,
  DelegationToolNotAllowedError,
  DepthLimitError,
  SkillNotAllowedError,
  SubAgentError,
} from "./errors";
import { UnknownAgentDefinitionError, createAgentFactory } from "./factory";
import type { AgentDefinition } from "./factory-types";
import { __setStreamTextForTest } from "./query/loop";
import type { Agent, AgentResult } from "./types";
import { silentLogger } from "../logger";

const tmpRoot = join(import.meta.dir, "__test_tmp__", "factory-delegation");
const testStoreManager = new SessionStoreManager({ logger: silentLogger });

function createTestSkillService(): SkillService {
  return new SkillService({ builtinSkills: {} });
}

function createSkillServiceWithBuiltins(): SkillService {
  return new SkillService({
    builtinSkills: {
      "git-master": "---\nname: git-master\ndescription: Git helper\nwhen_to_use: Use for git operations.\n---\nUse git carefully.",
      codemap: "---\nname: codemap\ndescription: Code map helper\nwhen_to_use: Use before implementation.\n---\nMap code first.",
      "research-docs": "---\nname: research-docs\ndescription: Research docs helper\nwhen_to_use: Use when uncertain about libraries.\n---\nRead docs carefully.",
    },
  });
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
  const model = new ModelInfo({
    model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
    config: {
      name: "Test Model",
      limit: { context: 128_000, output: 8_192 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "test",
    modelId: "model",
  });

  return {
    sdkRegistry: {} as ProviderRegistry["sdkRegistry"],
    models: new Map([[model.qualifiedId, model]]),
    modelIds: [model.qualifiedId],
    getModel: () => model,
  } as ProviderRegistry;
}

const FACTORY_TEST_TOOL_NAMES = [
  "unknown_tool",
  "file_write",
  "file_edit",
  "bash",
  "todo_write",
  "view_tool_output",
  "memory_read",
  "memory_write",
  "workflow_create",
  "workflow_read",
  "workflow_update_stage",
  "artifact_read",
  "artifact_write",
  "workflow_task_check",
  ...EXPLORER_READ_ONLY_TOOLS,
  ...DELEGATION_TOOLS,
] as const;

function makeToolRegistry(toolNames: readonly string[] = FACTORY_TEST_TOOL_NAMES) {
  return createRegistry(toolNames.map(makeTool));
}

function parentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { ...orchestratorAgentDefinition, ...overrides, tools: {
    ...orchestratorAgentDefinition.tools,
    ...overrides.tools,
  },
  hooks: {
    ...orchestratorAgentDefinition.hooks,
    ...overrides.hooks,
  },
  childPolicy: {
    ...orchestratorAgentDefinition.childPolicy,
    timeoutMs: 100,
    ...overrides.childPolicy,
  }, };
}

function targetDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { ...exploreAgentDefinition, ...overrides, tools: {
    ...exploreAgentDefinition.tools,
    ...overrides.tools,
  },
  hooks: {
    ...exploreAgentDefinition.hooks,
    titleGeneration: "disabled",
    ...overrides.hooks,
  }, };
}

function makeFactory(definitions: readonly AgentDefinition[] | undefined = undefined, skillService = createTestSkillService()) {
  const agentDefinitionsForFactory = definitions ?? [parentDefinition(), targetDefinition()];
  const providerRegistry = makeProviderRegistry();
  return createAgentFactory({ definitions: agentDefinitionsForFactory,
  providerRegistry,
  toolRegistry: makeToolRegistry(),
  skillService,
  storeManager: testStoreManager,
  workspaceRoot: tmpRoot,
    config: configForDefinitions(providerRegistry, agentDefinitionsForFactory), logger: silentLogger });
}

function makeFactoryWithBackgroundTaskManager(
  backgroundTaskManager: RecordingBackgroundTaskManager,
  definitions: readonly AgentDefinition[] = [parentDefinition(), targetDefinition()],
) {
  const providerRegistry = makeProviderRegistry();
  return createAgentFactory({ definitions,
  providerRegistry,
  toolRegistry: makeToolRegistry(),
  skillService: createTestSkillService(),
  storeManager: testStoreManager,
  workspaceRoot: tmpRoot,
  config: configForDefinitions(providerRegistry, definitions),
    backgroundTaskManager: backgroundTaskManager as never, logger: silentLogger });
}

function configForDefinitions(providerRegistry: ProviderRegistry, definitions: readonly AgentDefinition[]): SpecraConfig {
  return {
    provider: {},
    agents: Object.fromEntries(
      definitions.map((definition) => [definition.name, { model: providerRegistry.modelIds[0]! }]),
    ),
  } as SpecraConfig;
}

function setupResolvingStreamText(text = "child result") {
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

class RecordingBackgroundTaskManager {
  readonly dispatched: string[] = [];
  drainCalls = 0;

  dispatch(name: string): void {
    this.dispatched.push(name);
  }

  async drain(): Promise<void> {
    this.drainCalls += 1;
  }
}

function setupHangingStreamText() {
  let capturedAbort: AbortSignal | undefined;
  const fn = mock((opts: Record<string, unknown>) => {
    capturedAbort = opts.abortSignal as AbortSignal | undefined;
    return {
      fullStream: (async function* () {
        await new Promise(() => {});
      })(),
      finishReason: new Promise(() => {}),
      text: new Promise(() => {}),
      toolCalls: new Promise(() => {}),
      usage: new Promise(() => {}),
    };
  });

  __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);
  return { fn, getAbortSignal: () => capturedAbort };
}

async function expectResultRejects(promise: Promise<AgentResult>, message: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
  }
}

class RejectingAgent implements Agent {
  constructor(readonly store: StoreApi<SessionStoreState>) {}

  async run(): Promise<AgentResult> {
    throw new Error("boom");
  }

  dispose(): void {}
}

describe("AgentFactory.delegate", () => {
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

  test("creates child sessions and returns a run handle", async () => {
    setupResolvingStreamText();
    const factory = makeFactory();
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    const handle = await factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
      description: "Inspect files",
    });

    expect(handle.sessionId).toBeString();
    expect(handle.result).toBeInstanceOf(Promise);
    expect(handle.abort).toBeFunction();
    expect(testStoreManager.get(handle.sessionId, tmpRoot)?.getState().sessionId).toBe(handle.sessionId);
    await expect(handle.result).resolves.toEqual({ text: "child result", steps: 0 });
  });

  test("root agents do not use factory shared background task manager", async () => {
    setupResolvingStreamText();
    const btm = new RecordingBackgroundTaskManager();
    const factory = makeFactoryWithBackgroundTaskManager(btm);

    const rootAgent = factory.createRootAgent("orchestrator", {
      store: testStoreManager.create(`factory-root-${crypto.randomUUID()}`),
    });
    await rootAgent.run("root run");

    expect(btm.dispatched).toEqual([]);
    expect(btm.drainCalls).toBe(0);
  });

  test("propagates rootSessionId through delegation", async () => {
    setupResolvingStreamText();
    const factory = makeFactory();
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    const handle = await factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
    });

    const childStore = testStoreManager.get(handle.sessionId, tmpRoot);
    expect(childStore?.getState().parentSessionId).toBe(parentStore.getState().sessionId);
    expect(childStore?.getState().rootSessionId).toBe(parentStore.getState().rootSessionId);
    await handle.result;
  });

  test("propagates rootSessionId through nested delegation (grandchild)", async () => {
    setupResolvingStreamText();

    const middleDef: AgentDefinition = {
      name: "middle",
      promptAgentId: "explorer",
      rolePrompt: "Middleware agent that can delegate further.",
      tools: {
        tools: [...EXPLORER_READ_ONLY_TOOLS, "delegate", "todo_write"],
        delegateTargets: ["explore"],
      },
      hooks: {
        autoCompact: true,
        autoInjectReminder: true,
        todoContinuation: true,
        transcriptSave: true,
        memoryExtraction: false,
        memoryConsolidation: false,
        titleGeneration: "disabled",
      },
      childPolicy: {
        maxDepth: 3,
        maxConcurrent: 5,
        timeoutMs: 0,
        abortCascade: false,
        terminalReminders: false,
      },
      includeMemoryInPrompt: false,
      skills: [],
    };

    const factory = makeFactory([parentDefinition({ tools: { ...orchestratorAgentDefinition.tools, delegateTargets: [...orchestratorAgentDefinition.tools.delegateTargets, "middle"] } }), middleDef, targetDefinition()]);
    const rootStore = testStoreManager.create(`factory-root-${crypto.randomUUID()}`);

    const childHandle = await factory.delegate({
      parentStore: rootStore,
      parentAgentName: "orchestrator",
      targetAgentName: "middle",
      prompt: "first level",
      skills: [],
    });

    const childStore = testStoreManager.get(childHandle.sessionId, tmpRoot)!;
    expect(childStore.getState().rootSessionId).toBe(rootStore.getState().rootSessionId);

    const grandchildHandle = await factory.delegate({
      parentStore: childStore,
      parentAgentName: "middle",
      targetAgentName: "explore",
      prompt: "second level",
      skills: [],
      currentDepth: 1,
    });

    const grandchildStore = testStoreManager.get(grandchildHandle.sessionId, tmpRoot)!;
    expect(grandchildStore.getState().rootSessionId).toBe(rootStore.getState().rootSessionId);
    expect(grandchildStore.getState().rootSessionId).not.toBe(childStore.getState().sessionId);

    await Promise.all([childHandle.result, grandchildHandle.result]);
  });

  test("propagates delegated title or description into the child store title", async () => {
    setupResolvingStreamText();
    const factory = makeFactory();
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    const titled = await factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect title",
      skills: [],
      title: "Delegated Title",
      description: "Description fallback",
    });
    const described = await factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect description",
      skills: [],
      description: "Description Title",
    });

    expect(testStoreManager.get(titled.sessionId, tmpRoot)?.getState().title).toBe("Delegated Title");
    expect(testStoreManager.get(described.sessionId, tmpRoot)?.getState().title).toBe("Description Title");
    await Promise.all([titled.result, described.result]);
  });

  test("delegated child title suppresses child title generation", async () => {
    setupResolvingStreamText();
    const btm = new RecordingBackgroundTaskManager();
    const providerRegistry = makeProviderRegistry();
    const definitions = [parentDefinition(), targetDefinition({ hooks: { ...exploreAgentDefinition.hooks, titleGeneration: "unless-supplied" } })];
    const factory = createAgentFactory({ definitions,
    providerRegistry,
    toolRegistry: makeToolRegistry(),
    skillService: createTestSkillService(),
    storeManager: testStoreManager,
    workspaceRoot: tmpRoot,
    config: configForDefinitions(providerRegistry, definitions),
      backgroundTaskManager: btm as never, logger: silentLogger });
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    const handle = await factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect titled child",
      skills: [],
      title: "Delegated Title",
    });

    await handle.result;

    expect(testStoreManager.get(handle.sessionId, tmpRoot)?.getState().title).toBe("Delegated Title");
    expect(btm.dispatched).not.toContain("title-generation");
  });

  test("throws DepthLimitError when current depth reaches the parent child policy", async () => {
    setupResolvingStreamText();
    const factory = makeFactory([parentDefinition({ childPolicy: { ...orchestratorAgentDefinition.childPolicy, maxDepth: 1 } }), targetDefinition()]);
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    await expect(factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "too deep",
      skills: [],
      currentDepth: 1,
    })).rejects.toThrow(DepthLimitError);
  });

  test("allows Builder at depth 2 to delegate to Explore when maxDepth is 3", async () => {
    setupResolvingStreamText();
    const factory = makeFactory([
      parentDefinition({ childPolicy: { ...orchestratorAgentDefinition.childPolicy, maxDepth: 3 } }),
      targetDefinition(),
    ]);
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    const handle = await factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "builder delegates to explore",
      skills: [],
      currentDepth: 2,
    });

    await expect(handle.result).resolves.toEqual({ text: "child result", steps: 0 });
  });

  test("throws error at depth 3 when maxDepth is 3 (delegate tool unavailable)", async () => {
    const factory = makeFactory([
      parentDefinition({ childPolicy: { ...orchestratorAgentDefinition.childPolicy, maxDepth: 3 } }),
      targetDefinition(),
    ]);
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    // At depth 3, resolveAllowedTools strips "delegate" first (depth >= MAX_SUB_AGENT_DEPTH),
    // so DelegationToolNotAllowedError fires before DepthLimitError.
    await expect(factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "too deep",
      skills: [],
      currentDepth: 3,
    })).rejects.toThrow(DelegationToolNotAllowedError);
  });

  test("throws ConcurrentLimitError when active children reach the parent child policy", async () => {
    setupHangingStreamText();
    const factory = makeFactory([parentDefinition({ childPolicy: { ...orchestratorAgentDefinition.childPolicy, maxConcurrent: 1, timeoutMs: 0 } }), targetDefinition()]);
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);
    const first = await factory.delegate({ parentStore, parentAgentName: "orchestrator", targetAgentName: "explore", prompt: "hang", skills: [] });
    first.result.catch(() => {});

    try {
      await factory.delegate({ parentStore, parentAgentName: "orchestrator", targetAgentName: "explore", prompt: "blocked", skills: [] });
      throw new Error("expected concurrency limit");
    } catch (error) {
      expect(error).toBeInstanceOf(ConcurrentLimitError);
      expect((error as ConcurrentLimitError).activeCount).toBe(1);
    }

    first.abort();
  });

  test("cleans active child tracking after completion", async () => {
    setupResolvingStreamText();
    const factory = makeFactory([parentDefinition({ childPolicy: { ...orchestratorAgentDefinition.childPolicy, maxConcurrent: 1 } }), targetDefinition()]);
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    const first = await factory.delegate({ parentStore, parentAgentName: "orchestrator", targetAgentName: "explore", prompt: "first", skills: [] });
    await first.result;

    const second = await factory.delegate({ parentStore, parentAgentName: "orchestrator", targetAgentName: "explore", prompt: "second", skills: [] });
    await expect(second.result).resolves.toEqual({ text: "child result", steps: 0 });
  });

  test("times out children and emits timed_out reminders", async () => {
    setupHangingStreamText();
    const factory = makeFactory([parentDefinition({ childPolicy: { ...orchestratorAgentDefinition.childPolicy, timeoutMs: 10 } }), targetDefinition()]);
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    const handle = await factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "timeout",
      skills: [],
      background: true,
    });

    await expectResultRejects(handle.result, "Sub-agent timed out");
    const reminder = parentStore.getState().reminders.at(-1);
    expect(reminder?.source).toEqual({ type: "subagent_timed_out", sessionId: handle.sessionId });
    expect(reminder?.delivery).toBe("on_demand");
    expect(reminder?.terminalState).toBe("timed_out");
    expect(reminder?.content).toContain(`background_output(session_id="${handle.sessionId}")`);
    expect(reminder?.targetSessionId).toBe(parentStore.getState().sessionId);
  });

  test("cascades parent abort to the child", async () => {
    setupHangingStreamText();
    const factory = makeFactory([parentDefinition({ childPolicy: { ...orchestratorAgentDefinition.childPolicy, timeoutMs: 0 } }), targetDefinition()]);
    let childAbort: AbortSignal | undefined;
    const originalCreateAgent = factory.createAgent.bind(factory);
    factory.createAgent = (name, options = {}) => {
      if (name !== "explore") return originalCreateAgent(name, options);
      childAbort = options.abortSignal;
      return {
        store: options.store ?? testStoreManager.create(`abort-${crypto.randomUUID()}`),
        run: async () => new Promise<AgentResult>(() => {}),
        dispose: () => undefined,
      };
    };
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);
    const parentAbort = new AbortController();

    const handle = await factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "abort",
      skills: [],
      parentAbort: parentAbort.signal,
    });

    parentAbort.abort(new Error("parent stopped"));
    await expectResultRejects(handle.result, "parent stopped");
    expect(childAbort?.aborted).toBe(true);
  });

  test("emits background completion and failure reminders", async () => {
    setupResolvingStreamText();
    const successFactory = makeFactory();
    const successParent = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);
    const success = await successFactory.delegate({
      parentStore: successParent,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "ok",
      skills: [],
      background: true,
    });

    await success.result;
    expect(successParent.getState().reminders.at(-1)?.source).toEqual({ type: "subagent_completed", sessionId: success.sessionId });
    expect(successParent.getState().reminders.at(-1)?.terminalState).toBe("completed");
    expect(successParent.getState().reminders.at(-1)?.content).toContain(`background_output(session_id="${success.sessionId}")`);

    const failureFactory = makeFactory();
    const originalCreateAgent = failureFactory.createAgent.bind(failureFactory);
    failureFactory.createAgent = (name, options = {}) => {
      if (name === "explore") return new RejectingAgent(options.store ?? testStoreManager.create(`reject-${crypto.randomUUID()}`));
      return originalCreateAgent(name, options);
    };
    const failureParent = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);
    const failure = await failureFactory.delegate({
      parentStore: failureParent,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "fail",
      skills: [],
      background: true,
    });

    await expectResultRejects(failure.result, "boom");
    expect(failureParent.getState().reminders.at(-1)?.source).toEqual({ type: "subagent_failed", sessionId: failure.sessionId });
    expect(failureParent.getState().reminders.at(-1)?.terminalState).toBe("failed");
    expect(failureParent.getState().reminders.at(-1)?.content).toContain(`background_output(session_id="${failure.sessionId}")`);
    await expect(failure.result).rejects.toThrow(SubAgentError);
  });

  test("rejects delegation when caller resolved tools do not include delegate", async () => {
    setupResolvingStreamText();
    const factory = makeFactory([parentDefinition({ tools: { tools: ["grep"], delegateTargets: ["explore"] } }), targetDefinition()]);
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    await expect(factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
    })).rejects.toThrow(DelegationToolNotAllowedError);
  });

  test("rejects delegation when target is not in caller delegate targets", async () => {
    setupResolvingStreamText();
    const factory = makeFactory([parentDefinition({ tools: { tools: orchestratorAgentDefinition.tools.tools, delegateTargets: [] } }), targetDefinition()]);
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    await expect(factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
    })).rejects.toThrow(DelegateTargetNotAllowedError);
  });

  test("rejects delegation when target definition is missing", async () => {
    setupResolvingStreamText();
    const factory = makeFactory([parentDefinition({ tools: { tools: orchestratorAgentDefinition.tools.tools, delegateTargets: ["missing"] } })]);
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    await expect(factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "missing",
      prompt: "inspect",
      skills: [],
    })).rejects.toThrow(UnknownAgentDefinitionError);
  });

  test("passes no active skills when skills is empty", async () => {
    setupResolvingStreamText();
    const factory = makeFactory(undefined, createSkillServiceWithBuiltins());
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);
    let activeSkills: readonly unknown[] | undefined;
    const originalCreateAgent = factory.createAgent.bind(factory);
    factory.createAgent = (name, options = {}) => {
      activeSkills = options.activeSkills;
      return originalCreateAgent(name, options);
    };

    const handle = await factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
    });

    expect(activeSkills).toEqual([]);
    await handle.result;
  });

  test("validates requested skills against the child allow-list, not the parent", async () => {
    setupResolvingStreamText();
    const factory = makeFactory([foremanAgentDefinition, builderAgentDefinition], createSkillServiceWithBuiltins());
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);
    let activeSkills: readonly unknown[] | undefined;
    const originalCreateAgent = factory.createAgent.bind(factory);
    factory.createAgent = (name, options = {}) => {
      activeSkills = options.activeSkills;
      return originalCreateAgent(name, options);
    };

    const handle = await factory.delegate({
      parentStore,
      parentAgentName: "foreman",
      targetAgentName: "builder",
      prompt: "build with git",
      skills: ["git-master"],
    });

    expect(activeSkills?.map((skill) => (skill as { metadata: { name: string } }).metadata.name)).toEqual(["git-master"]);
    await handle.result;
  });

  test("rejects skills absent from the child allow-list even when the parent allows them", async () => {
    setupResolvingStreamText();
    const factory = makeFactory(undefined, createSkillServiceWithBuiltins());
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);

    await expect(factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect with git",
      skills: ["git-master"],
    })).rejects.toThrow(SkillNotAllowedError);
  });

  test("passes requested active skill bodies to the child agent", async () => {
    setupResolvingStreamText();
    const factory = makeFactory([foremanAgentDefinition, builderAgentDefinition], createSkillServiceWithBuiltins());
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);
    let activeSkills: readonly unknown[] | undefined;
    const originalCreateAgent = factory.createAgent.bind(factory);
    factory.createAgent = (name, options = {}) => {
      activeSkills = options.activeSkills;
      return originalCreateAgent(name, options);
    };

    const handle = await factory.delegate({
      parentStore,
      parentAgentName: "foreman",
      targetAgentName: "builder",
      prompt: "build with skill",
      skills: ["git-master"],
    });

    expect(activeSkills?.[0]).toMatchObject({
      metadata: { name: "git-master", description: "Git helper", when_to_use: "Use for git operations." },
      body: "Use git carefully.",
      source: "builtin",
    });
    await handle.result;
  });

  test("does not leak active skills between later children", async () => {
    setupResolvingStreamText();
    const factory = makeFactory([foremanAgentDefinition, builderAgentDefinition], createSkillServiceWithBuiltins());
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);
    const captured: Array<readonly unknown[]> = [];
    const originalCreateAgent = factory.createAgent.bind(factory);
    factory.createAgent = (name, options = {}) => {
      captured.push([...(options.activeSkills ?? [])]);
      return originalCreateAgent(name, options);
    };

    const first = await factory.delegate({
      parentStore,
      parentAgentName: "foreman",
      targetAgentName: "builder",
      prompt: "first",
      skills: ["git-master"],
    });
    await first.result;
    const second = await factory.delegate({
      parentStore,
      parentAgentName: "foreman",
      targetAgentName: "builder",
      prompt: "second",
      skills: [],
    });
    await second.result;

    expect(captured.map((skills) => skills.map((skill) => (skill as { metadata: { name: string } }).metadata.name))).toEqual([
      ["git-master"],
      [],
    ]);
  });

  test("de-duplicates duplicate skill names in first-seen order", async () => {
    setupResolvingStreamText();
    const factory = makeFactory([foremanAgentDefinition, builderAgentDefinition], createSkillServiceWithBuiltins());
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);
    let activeSkills: readonly unknown[] | undefined;
    const originalCreateAgent = factory.createAgent.bind(factory);
    factory.createAgent = (name, options = {}) => {
      activeSkills = options.activeSkills;
      return originalCreateAgent(name, options);
    };

    const handle = await factory.delegate({
      parentStore,
      parentAgentName: "foreman",
      targetAgentName: "builder",
      prompt: "dedupe skills",
      skills: ["codemap", "git-master", "codemap", "git-master"],
    });

    expect(activeSkills?.map((skill) => (skill as { metadata: { name: string } }).metadata.name)).toEqual(["codemap", "git-master"]);
    await handle.result;
  });

  test("rejects duplicate agent definitions", () => {
    const providerRegistry = makeProviderRegistry();

    expect(() => createAgentFactory({ definitions: [productAgentDefinition, productAgentDefinition],
    providerRegistry,
    toolRegistry: makeToolRegistry(),
    skillService: createTestSkillService(),
    storeManager: testStoreManager,
    workspaceRoot: tmpRoot,
      config: configForDefinitions(providerRegistry, [productAgentDefinition]), logger: silentLogger })).toThrow("Duplicate agent definition: product");
  });

  test("lists all registered workflow agent names", () => {
    const providerRegistry = makeProviderRegistry();
    const factory = createAgentFactory({ definitions: agentDefinitions,
    providerRegistry,
    toolRegistry: makeToolRegistry(),
    skillService: createTestSkillService(),
    storeManager: testStoreManager,
    workspaceRoot: tmpRoot,
      config: configForDefinitions(providerRegistry, agentDefinitions), logger: silentLogger });

    expect(factory.listAgentNames()).toEqual([
      "orchestrator",
      "explore",
      "product",
      "spec",
      "critic",
      "foreman",
      "builder",
      "reviewer",
      "librarian",
    ]);
  });

  test("product resolves workflow artifact tools without source write tools", () => {
    const providerRegistry = makeProviderRegistry();
    const factory = createAgentFactory({ definitions: agentDefinitions,
    providerRegistry,
    toolRegistry: makeToolRegistry(),
    skillService: createTestSkillService(),
    storeManager: testStoreManager,
    workspaceRoot: tmpRoot,
      config: configForDefinitions(providerRegistry, agentDefinitions), logger: silentLogger });

    const tools = factory.resolveAllowedTools(productAgentDefinition, 0);

    expect(tools).toContain("artifact_write");
    expect(tools).not.toContain("file_write");
    expect(tools).not.toContain("file_edit");
  });

  test("foreman resolves task and delegation tools without workflow stage updates", () => {
    const providerRegistry = makeProviderRegistry();
    const factory = createAgentFactory({ definitions: agentDefinitions,
    providerRegistry,
    toolRegistry: makeToolRegistry(),
    skillService: createTestSkillService(),
    storeManager: testStoreManager,
    workspaceRoot: tmpRoot,
      config: configForDefinitions(providerRegistry, agentDefinitions), logger: silentLogger });

    const tools = factory.resolveAllowedTools(foremanAgentDefinition, 0);

    expect(tools).toContain("workflow_task_check");
    expect(tools).toContain("delegate");
    expect(tools).toContain("background_output");
    expect(tools).toContain("todo_write");
    expect(tools).not.toContain("workflow_update_stage");
  });

  test("builder resolves source edit, delegation, and evidence tools without progress tools", () => {
    const providerRegistry = makeProviderRegistry();
    const factory = createAgentFactory({ definitions: agentDefinitions,
    providerRegistry,
    toolRegistry: makeToolRegistry(),
    skillService: createTestSkillService(),
    storeManager: testStoreManager,
    workspaceRoot: tmpRoot,
      config: configForDefinitions(providerRegistry, agentDefinitions), logger: silentLogger });

    const tools = factory.resolveAllowedTools(builderAgentDefinition, 0);

    expect(tools).toContain("file_write");
    expect(tools).toContain("file_edit");
    expect(tools).toContain("bash");
    expect(tools).toContain("delegate");
    expect(tools).toContain("artifact_write");
    expect(tools).not.toContain("workflow_task_check");
    expect(tools).not.toContain("workflow_update_stage");
  });

  test("reviewer resolves evidence and memory read tools without source, delegation, or progress tools", () => {
    const providerRegistry = makeProviderRegistry();
    const factory = createAgentFactory({ definitions: agentDefinitions,
    providerRegistry,
    toolRegistry: makeToolRegistry(),
    skillService: createTestSkillService(),
    storeManager: testStoreManager,
    workspaceRoot: tmpRoot,
      config: configForDefinitions(providerRegistry, agentDefinitions), logger: silentLogger });

    const tools = factory.resolveAllowedTools(reviewerAgentDefinition, 0);

    expect(tools).toContain("artifact_write");
    expect(tools).toContain("memory_read");
    expect(tools).not.toContain("delegate");
    expect(tools).not.toContain("file_write");
    expect(tools).not.toContain("file_edit");
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("workflow_task_check");
    expect(tools).not.toContain("workflow_update_stage");
  });

  test("definitions derive workflow tools from the shared permission policy", () => {
    expect(productAgentDefinition.tools.tools).toBe(workflowRoleToolPermissions.product);
    expect(foremanAgentDefinition.tools.tools).toBe(workflowRoleToolPermissions.foreman);
    expect(builderAgentDefinition.tools.tools).toBe(workflowRoleToolPermissions.builder);
    expect(reviewerAgentDefinition.tools.tools).toBe(workflowRoleToolPermissions.reviewer);
  });

  test("delegate targets allow only declared workflow relationships", async () => {
    const providerRegistry = makeProviderRegistry();
    const factory = createAgentFactory({ definitions: agentDefinitions,
    providerRegistry,
    toolRegistry: makeToolRegistry(),
    skillService: createTestSkillService(),
    storeManager: testStoreManager,
    workspaceRoot: tmpRoot,
      config: configForDefinitions(providerRegistry, agentDefinitions), logger: silentLogger });
    const parentStore = testStoreManager.create(`factory-parent-${crypto.randomUUID()}`);
    setupResolvingStreamText();

    const handle = await factory.delegate({
      parentStore,
      parentAgentName: "foreman",
      targetAgentName: "builder",
      prompt: "build task",
      skills: [],
    });

    await expect(factory.delegate({
      parentStore,
      parentAgentName: "foreman",
      targetAgentName: "librarian",
      prompt: "not allowed",
      skills: [],
    })).rejects.toThrow(DelegateTargetNotAllowedError);
    expect(factory.getDelegateTargetsFor(foremanAgentDefinition, 0)).toEqual(["builder", "reviewer"]);
    await expect(handle.result).resolves.toEqual({ text: "child result", steps: 0 });
  });

});
