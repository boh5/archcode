import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SpecraConfig } from "../config/schema";
import { ModelInfo } from "../provider/model";
import type { Registry as ProviderRegistry } from "../provider/index";
import { createSessionStore, getSessionStore } from "../store/store";
import { __setSessionsDirForTest } from "../store/sessions-dir";
import { createRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { DELEGATION_TOOLS, EXPLORER_READ_ONLY_TOOLS } from "./constants";
import { exploreAgentDefinition, orchestratorAgentDefinition } from "./definitions";
import {
  ConcurrentLimitError,
  DelegateTargetNotAllowedError,
  DelegationToolNotAllowedError,
  DepthLimitError,
  SubAgentError,
} from "./errors";
import { UnknownAgentDefinitionError, createAgentFactory } from "./factory";
import type { AgentDefinition } from "./factory-types";
import { __setStreamTextForTest } from "./query/loop";
import type { Agent, AgentResult } from "./types";

const tmpRoot = join(import.meta.dir, "__test_tmp__", "factory-delegation");

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

function makeToolRegistry(toolNames = ["unknown_tool", ...EXPLORER_READ_ONLY_TOOLS, ...DELEGATION_TOOLS]) {
  return createRegistry(toolNames.map(makeTool));
}

function parentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    ...orchestratorAgentDefinition,
    ...overrides,
    tools: {
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
    },
  };
}

function targetDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    ...exploreAgentDefinition,
    ...overrides,
    tools: {
      ...exploreAgentDefinition.tools,
      ...overrides.tools,
    },
    hooks: {
      ...exploreAgentDefinition.hooks,
      titleGeneration: "disabled",
      ...overrides.hooks,
    },
  };
}

function makeFactory(definitions: readonly AgentDefinition[] = [parentDefinition(), targetDefinition()]) {
  const providerRegistry = makeProviderRegistry();
  return createAgentFactory({
    definitions,
    providerRegistry,
    toolRegistry: makeToolRegistry(),
    workspaceRoot: tmpRoot,
    config: configForDefinitions(providerRegistry, definitions),
  });
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
  constructor(readonly store: ReturnType<typeof createSessionStore>) {}

  async run(): Promise<AgentResult> {
    throw new Error("boom");
  }
}

describe("AgentFactory.delegate", () => {
  beforeAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(join(tmpRoot, ".specra", "memory"), { recursive: true });
    await writeFile(join(tmpRoot, ".specra", "memory", "index.md"), "");
    await writeFile(join(tmpRoot, "AGENTS.md"), "# Test Project\n\nMinimal project context.");
    __setSessionsDirForTest(join(tmpRoot, "sessions"));
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
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);

    const handle = factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect",
      description: "Inspect files",
    });

    expect(handle.sessionId).toBeString();
    expect(handle.result).toBeInstanceOf(Promise);
    expect(handle.abort).toBeFunction();
    expect(getSessionStore(handle.sessionId)?.getState().sessionId).toBe(handle.sessionId);
    await expect(handle.result).resolves.toEqual({ text: "child result", steps: 0 });
  });

  test("links parent and child metadata", async () => {
    setupResolvingStreamText();
    const factory = makeFactory();
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);

    const handle = factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect",
      description: "Inspect docs",
    });

    const childStore = getSessionStore(handle.sessionId);
    expect(childStore?.getState().parentSessionId).toBe(parentStore.getState().sessionId);
    expect(parentStore.getState().childSessionIds.has(handle.sessionId)).toBe(true);
    expect(parentStore.getState().subAgentDescriptions.get(handle.sessionId)).toBe("Inspect docs");
    await handle.result;
  });

  test("propagates delegated title or description into the child store title", async () => {
    setupResolvingStreamText();
    const factory = makeFactory();
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);

    const titled = factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect title",
      title: "Delegated Title",
      description: "Description fallback",
    });
    const described = factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect description",
      description: "Description Title",
    });

    expect(getSessionStore(titled.sessionId)?.getState().title).toBe("Delegated Title");
    expect(getSessionStore(described.sessionId)?.getState().title).toBe("Description Title");
    await Promise.all([titled.result, described.result]);
  });

  test("delegated child title suppresses child title generation", async () => {
    setupResolvingStreamText();
    const btm = new RecordingBackgroundTaskManager();
    const providerRegistry = makeProviderRegistry();
    const definitions = [parentDefinition(), targetDefinition({ hooks: { ...exploreAgentDefinition.hooks, titleGeneration: "unless-supplied" } })];
    const factory = createAgentFactory({
      definitions,
      providerRegistry,
      toolRegistry: makeToolRegistry(),
      workspaceRoot: tmpRoot,
      config: configForDefinitions(providerRegistry, definitions),
      backgroundTaskManager: btm as never,
    });
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);

    const handle = factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect titled child",
      title: "Delegated Title",
    });

    await handle.result;

    expect(getSessionStore(handle.sessionId)?.getState().title).toBe("Delegated Title");
    expect(btm.dispatched).not.toContain("title-generation");
  });

  test("throws DepthLimitError when current depth reaches the parent child policy", () => {
    setupResolvingStreamText();
    const factory = makeFactory([parentDefinition({ childPolicy: { ...orchestratorAgentDefinition.childPolicy, maxDepth: 1 } }), targetDefinition()]);
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);

    expect(() => factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "too deep",
      currentDepth: 1,
    })).toThrow(DepthLimitError);
  });

  test("throws ConcurrentLimitError when active children reach the parent child policy", () => {
    setupHangingStreamText();
    const factory = makeFactory([parentDefinition({ childPolicy: { ...orchestratorAgentDefinition.childPolicy, maxConcurrent: 1, timeoutMs: 0 } }), targetDefinition()]);
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);
    const first = factory.delegate({ parentStore, parentAgentName: "orchestrator", targetAgentName: "explore", prompt: "hang" });
    first.result.catch(() => {});

    try {
      factory.delegate({ parentStore, parentAgentName: "orchestrator", targetAgentName: "explore", prompt: "blocked" });
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
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);

    const first = factory.delegate({ parentStore, parentAgentName: "orchestrator", targetAgentName: "explore", prompt: "first" });
    await first.result;

    const second = factory.delegate({ parentStore, parentAgentName: "orchestrator", targetAgentName: "explore", prompt: "second" });
    await expect(second.result).resolves.toEqual({ text: "child result", steps: 0 });
  });

  test("times out children and emits timed_out reminders", async () => {
    setupHangingStreamText();
    const factory = makeFactory([parentDefinition({ childPolicy: { ...orchestratorAgentDefinition.childPolicy, timeoutMs: 10 } }), targetDefinition()]);
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);

    const handle = factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "timeout",
      background: true,
    });

    await expectResultRejects(handle.result, "Sub-agent timed out");
    const reminder = parentStore.getState().reminders.at(-1);
    expect(reminder?.source).toEqual({ type: "subagent_timed_out", sessionId: handle.sessionId });
    expect(reminder?.delivery).toBe("on_demand");
    expect(reminder?.terminalState).toBe("timed_out");
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
        store: options.store ?? createSessionStore(`abort-${crypto.randomUUID()}`),
        run: async () => new Promise<AgentResult>(() => {}),
      };
    };
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);
    const parentAbort = new AbortController();

    const handle = factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "abort",
      parentAbort: parentAbort.signal,
    });

    parentAbort.abort(new Error("parent stopped"));
    await expectResultRejects(handle.result, "parent stopped");
    expect(childAbort?.aborted).toBe(true);
  });

  test("emits background completion and failure reminders", async () => {
    setupResolvingStreamText();
    const successFactory = makeFactory();
    const successParent = createSessionStore(`factory-parent-${crypto.randomUUID()}`);
    const success = successFactory.delegate({
      parentStore: successParent,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "ok",
      background: true,
    });

    await success.result;
    expect(successParent.getState().reminders.at(-1)?.source).toEqual({ type: "subagent_completed", sessionId: success.sessionId });
    expect(successParent.getState().reminders.at(-1)?.terminalState).toBe("completed");

    const failureFactory = makeFactory();
    const originalCreateAgent = failureFactory.createAgent.bind(failureFactory);
    failureFactory.createAgent = (name, options = {}) => {
      if (name === "explore") return new RejectingAgent(options.store ?? createSessionStore(`reject-${crypto.randomUUID()}`));
      return originalCreateAgent(name, options);
    };
    const failureParent = createSessionStore(`factory-parent-${crypto.randomUUID()}`);
    const failure = failureFactory.delegate({
      parentStore: failureParent,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "fail",
      background: true,
    });

    await expectResultRejects(failure.result, "boom");
    expect(failureParent.getState().reminders.at(-1)?.source).toEqual({ type: "subagent_failed", sessionId: failure.sessionId });
    expect(failureParent.getState().reminders.at(-1)?.terminalState).toBe("failed");
    await expect(failure.result).rejects.toThrow(SubAgentError);
  });

  test("rejects delegation when caller resolved tools do not include delegate", () => {
    setupResolvingStreamText();
    const factory = makeFactory([parentDefinition({ tools: { tools: ["grep"], delegateTargets: ["explore"] } }), targetDefinition()]);
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);

    expect(() => factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect",
    })).toThrow(DelegationToolNotAllowedError);
  });

  test("rejects delegation when target is not in caller delegate targets", () => {
    setupResolvingStreamText();
    const factory = makeFactory([parentDefinition({ tools: { tools: orchestratorAgentDefinition.tools.tools, delegateTargets: [] } }), targetDefinition()]);
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);

    expect(() => factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "explore",
      prompt: "inspect",
    })).toThrow(DelegateTargetNotAllowedError);
  });

  test("rejects delegation when target definition is missing", () => {
    setupResolvingStreamText();
    const factory = makeFactory([parentDefinition({ tools: { tools: orchestratorAgentDefinition.tools.tools, delegateTargets: ["missing"] } })]);
    const parentStore = createSessionStore(`factory-parent-${crypto.randomUUID()}`);

    expect(() => factory.delegate({
      parentStore,
      parentAgentName: "orchestrator",
      targetAgentName: "missing",
      prompt: "inspect",
    })).toThrow(UnknownAgentDefinitionError);
  });

});
