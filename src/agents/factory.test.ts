import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ModelInfo } from "../provider/model";
import type { Registry as ProviderRegistry } from "../provider/index";
import { createSessionStore } from "../store/store";
import { createRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { DELEGATION_TOOLS, EXPLORER_READ_ONLY_TOOLS } from "./constants";
import {
  DuplicateAgentDefinitionError,
  UnknownAgentDefinitionError,
  createAgentFactory,
} from "./factory";
import type { AgentDefinition } from "./factory-types";

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
      limit: { context: 1000, output: 100 },
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

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "orchestrator",
    promptAgentId: "default",
    tools: { tools: ["unknown_tool", ...explorerTools], delegateTargets: ["explore"] },
    hooks: {
      autoCompact: true,
      autoInjectReminder: true,
      todoContinuation: true,
      transcriptSave: true,
      memoryExtraction: true,
      memoryConsolidation: true,
      titleGeneration: "enabled",
    },
    includeMemoryInPrompt: true,
    ...overrides,
  };
}

function makeFactory(definitions: readonly AgentDefinition[] = [definition()]) {
  return createAgentFactory({
    definitions,
    providerRegistry: makeProviderRegistry(),
    toolRegistry: createRegistry([
      makeTool("unknown_tool"),
      ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
      ...DELEGATION_TOOLS.map(makeTool),
    ]),
    workspaceRoot: import.meta.dir,
    config: { provider: {} },
  });
}

const explorerTools = [...EXPLORER_READ_ONLY_TOOLS, ...DELEGATION_TOOLS] as const;
const nonDelegatingExplorerTools = EXPLORER_READ_ONLY_TOOLS;

describe("createAgentFactory", () => {
  test("rejects duplicate definitions with a named error", () => {
    expect(() => makeFactory([definition(), definition()])).toThrow(DuplicateAgentDefinitionError);

    try {
      makeFactory([definition(), definition()]);
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateAgentDefinitionError);
      expect((error as DuplicateAgentDefinitionError).name).toBe("DuplicateAgentDefinitionError");
      expect((error as DuplicateAgentDefinitionError).definitionName).toBe("orchestrator");
    }
  });

  test("rejects unknown agent names with a named error", () => {
    const factory = makeFactory();

    expect(() => factory.getDefinition("missing")).toThrow(UnknownAgentDefinitionError);
    expect(() => factory.createAgent("missing")).toThrow(UnknownAgentDefinitionError);
  });

  test("creates root agents through the factory API with a supplied store", () => {
    const factory = makeFactory();
    const store = createSessionStore(`factory-root-${crypto.randomUUID()}`);

    const agent = factory.createRootAgent("orchestrator", { store });

    expect(agent.store).toBe(store);
    expect(agent.store.getState().sessionId).toBe(store.getState().sessionId);
    expect(typeof agent.run).toBe("function");
  });

  test("assigns title to root and child stores", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", promptAgentId: "explorer", tools: { tools: nonDelegatingExplorerTools } }),
    ]);

    const root = factory.createRootAgent("orchestrator", { title: "Root Title" });
    const child = factory.createAgent("explore", { title: "Child Title" });

    expect(root.store.getState().title).toBe("Root Title");
    expect(child.store.getState().title).toBe("Child Title");
  });

  test("assigns parent session id to child stores", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", promptAgentId: "explorer", tools: { tools: nonDelegatingExplorerTools } }),
    ]);

    const child = factory.createAgent("explore", { parentSessionId: "parent-session" });

    expect(child.store.getState().parentSessionId).toBe("parent-session");
  });

  test("resolves explicit tool lists and strips delegation tools at depth two", () => {
    const factory = makeFactory();
    const customDefinition = definition({ tools: { tools: ["grep", "missing", "delegate"] } });
    const delegatingDefinition = definition({
      name: "orchestrator",
      tools: { tools: ["unknown_tool", ...explorerTools] },
    });

    expect(factory.resolveAllowedTools(definition(), 0)).toEqual([
      "unknown_tool",
      ...EXPLORER_READ_ONLY_TOOLS,
      ...DELEGATION_TOOLS,
    ]);
    expect(factory.resolveAllowedTools(customDefinition, 0)).toEqual(["grep", "delegate"]);
    expect(factory.resolveAllowedTools(customDefinition, 2)).toEqual(["grep"]);
    expect(factory.resolveAllowedTools(delegatingDefinition, 1)).toEqual([
      "unknown_tool",
      ...EXPLORER_READ_ONLY_TOOLS,
      ...DELEGATION_TOOLS,
    ]);
    expect(factory.resolveAllowedTools(delegatingDefinition, 2)).toEqual(["unknown_tool", ...EXPLORER_READ_ONLY_TOOLS]);
  });

  test("resolves delegate targets only when depth allows delegation", () => {
    const factory = makeFactory();
    const depthFilteredDefinition = definition({
      name: "explore",
      tools: { tools: explorerTools, delegateTargets: ["explore", "custom"] },
    });
    const explicitWithoutDelegate = definition({
      name: "custom",
      tools: { tools: ["grep"], delegateTargets: ["explore"] },
    });

    expect(factory.getDelegateTargetsFor(depthFilteredDefinition, 1)).toEqual(["explore", "custom"]);
    expect(factory.getDelegateTargetsFor(depthFilteredDefinition, 2)).toEqual([]);
    expect(factory.getDelegateTargetsFor(explicitWithoutDelegate, 0)).toEqual([]);
  });
});
