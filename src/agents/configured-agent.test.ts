import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ModelInfo } from "../provider/model";
import type { Registry as ProviderRegistry } from "../provider/index";
import { createSessionStore } from "../store/store";
import { __setSessionsDirForTest } from "../store/sessions-dir";
import { createRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { DELEGATION_TOOLS, EXPLORER_READ_ONLY_TOOLS } from "./constants";
import { ConfiguredAgent } from "./configured-agent";
import { exploreAgentDefinition, orchestratorAgentDefinition } from "./definitions";
import type { AgentDefinition } from "./factory-types";
import { __setStreamTextForTest } from "./query/loop";

const tmpRoot = join(import.meta.dir, "__test_tmp__", "configured-agent");

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
  store?: ReturnType<typeof createSessionStore>;
  btm?: RecordingBackgroundTaskManager;
  quotaEnforcer?: (directory: string) => Promise<void>;
  workspaceRoot?: string;
}) {
  const toolRegistry = makeToolRegistry();
  return new ConfiguredAgent({
    definition: options.definition,
    providerRegistry: makeProviderRegistry(),
    toolRegistry,
    store: options.store,
    workspaceRoot: options.workspaceRoot ?? tmpRoot,
    backgroundTaskManager: options.btm as never,
    quotaEnforcer: options.quotaEnforcer,
    resolveAllowedTools: (definition, depth) => {
      const resolved = toolRegistry.resolveForAgent(definition.tools.tools).descriptors.map((tool) => tool.name);
      if (depth >= 2) {
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

  test("orchestrator definition produces all configured lifecycle hooks", async () => {
    const streamFn = setupMockStreamText("root ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = createSessionStore(`configured-root-${crypto.randomUUID()}`);
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

  test("explorer definition produces auto-compact, auto-inject, and todo-continuation hooks", async () => {
    const streamFn = setupMockStreamText("explore ok");
    const store = createSessionStore(`configured-explore-${crypto.randomUUID()}`);
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

  test("explorer definition dispatches transcript and memory background hooks", async () => {
    setupMockStreamText("explore memory ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = createSessionStore(`configured-explore-background-${crypto.randomUUID()}`);
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
      ],
    });
    await writeFile(join(tmpRoot, ".specra", "memory", "index.md"), `${Array.from({ length: 251 }, (_, index) => `topic-${index}`).join("\n")}\n`);

    const agent = createAgent({ definition: exploreAgentDefinition, store, btm });
    await agent.run("explore run");

    expect(btm.dispatched).toContain("transcript-save");
    expect(btm.dispatched).toContain("memory-extraction");
    expect(btm.dispatched).toContain("memory-consolidation");
  });

  test('titleGeneration "unless-supplied" skips when store title already exists', async () => {
    setupMockStreamText("titled ok");
    const btm = new RecordingBackgroundTaskManager();
    const store = createSessionStore(`configured-titled-${crypto.randomUUID()}`);
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
});
