import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import type { SpecraConfig } from "../config/schema";
import { ModelInfo } from "../provider/model";
import { UnknownQualifiedIdError, type Registry as ProviderRegistry } from "../provider/index";
import { SkillService } from "../skills";
import { storeManager } from "../store/store";
import { createRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { DELEGATION_TOOLS, EXPLORER_READ_ONLY_TOOLS } from "./constants";
import { MissingAgentModelConfigError, NoModelsConfiguredError } from "./errors";
import {
  DuplicateAgentDefinitionError,
  UnknownAgentDefinitionError,
  createAgentFactory,
} from "./factory";
import { ConfiguredAgent } from "./configured-agent";
import type { AgentDefinition } from "./factory-types";
import type { ResolvedSkill } from "../skills/types";
import { silentLogger } from "../logger";

function makeTool(name: string): AnyToolDescriptor {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).strict(),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: () => `${name} result`,
  };
}

function createTestSkillService(): SkillService {
  return new SkillService({ builtinSkills: {} });
}

function createSkillServiceWithBuiltins(): SkillService {
  return new SkillService({
    builtinSkills: {
      "git-master": "---\nname: git-master\ndescription: Git helper\nwhen_to_use: Use for git operations.\n---\nUse git carefully.",
      codemap: "---\nname: codemap\ndescription: Code map helper\nwhen_to_use: Use before implementation.\n---\nMap code first.",
    },
  });
}

function makeProviderRegistry(): ProviderRegistry {
  const fallbackModel = new ModelInfo({
    model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
    config: {
      name: "Fallback Model",
      limit: { context: 1000, output: 100 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "test",
    modelId: "fallback",
  });

  const configuredModel = new ModelInfo({
    model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
    config: {
      name: "Configured Model",
      limit: { context: 2000, output: 200 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "test",
    modelId: "configured",
  });

  const getModel = mock((qualifiedId: string) => {
    if (qualifiedId === fallbackModel.qualifiedId) return fallbackModel;
    if (qualifiedId === configuredModel.qualifiedId) return configuredModel;
    throw new UnknownQualifiedIdError(qualifiedId, [fallbackModel.qualifiedId, configuredModel.qualifiedId]);
  });

  return {
    sdkRegistry: {} as ProviderRegistry["sdkRegistry"],
    models: new Map([
      [fallbackModel.qualifiedId, fallbackModel],
      [configuredModel.qualifiedId, configuredModel],
    ]),
    modelIds: [fallbackModel.qualifiedId, configuredModel.qualifiedId],
    getModel,
  } as ProviderRegistry;
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { name: "orchestrator",
  promptProfileId: "default",
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
  skills: [], ...overrides,  };
}

function makeFactory(
  definitions: readonly AgentDefinition[] = [definition()],
  options: { providerRegistry?: ProviderRegistry; config?: Partial<SpecraConfig>; skillService?: SkillService } = {},
) {
  const providerRegistry = options.providerRegistry ?? makeProviderRegistry();
  const config: SpecraConfig = {
    provider: {},
    ...options.config,
    agents:
      options.config?.agents ??
      Object.fromEntries(
        definitions.map((definitionItem) => [definitionItem.name, { model: providerRegistry.modelIds[1] ?? providerRegistry.modelIds[0] }]),
      ),
  } as SpecraConfig;

  return createAgentFactory({ definitions,
  providerRegistry,
  toolRegistry: createRegistry([
    makeTool("unknown_tool"),
    ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
    ...DELEGATION_TOOLS.map(makeTool),
  ]),
  skillService: options.skillService ?? createTestSkillService(),
  storeManager,
  workspaceRoot: import.meta.dir,
  config, logger: silentLogger });
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
    const store = storeManager.create(`factory-root-${crypto.randomUUID()}`);

    const agent = factory.createRootAgent("orchestrator", { store });

    expect(agent.store).toBe(store);
    expect(agent.store.getState().sessionId).toBe(store.getState().sessionId);
    expect(typeof agent.run).toBe("function");
  });

  test("root agents default to no active skills", () => {
    const factory = makeFactory();

    const agent = factory.createRootAgent("orchestrator");

    expect(agent).toBeInstanceOf(ConfiguredAgent);
    expect((agent as ConfiguredAgent).activeSkills).toEqual([]);
  });

  test("threads SkillService and explicit active skills through factory creation", () => {
    const skillService = createTestSkillService();
    const providerRegistry = makeProviderRegistry();
    const activeSkills: readonly ResolvedSkill[] = [
      {
        metadata: { name: "git-master", description: "Git helper", when_to_use: "Use for git operations." },
        body: "Use git carefully.",
        source: "builtin",
      },
    ];
    const factory = createAgentFactory({ definitions: [definition()],
    providerRegistry,
    toolRegistry: createRegistry([
      makeTool("unknown_tool"),
      ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
      ...DELEGATION_TOOLS.map(makeTool),
    ]),
    skillService,
    storeManager,
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {
        orchestrator: { model: providerRegistry.modelIds[1]! },
      },
    } as SpecraConfig, logger: silentLogger });

    const agent = factory.createAgent("orchestrator", { activeSkills });

    expect(agent).toBeInstanceOf(ConfiguredAgent);
    expect((agent as ConfiguredAgent).activeSkills).toBe(activeSkills);
    expect((agent as unknown as { skillService: SkillService }).skillService).toBe(skillService);
  });

  test("resolves the configured model instead of the first registry entry", () => {
    const providerRegistry = makeProviderRegistry();
    const factory = createAgentFactory({ definitions: [definition()],
    providerRegistry,
    toolRegistry: createRegistry([
      makeTool("unknown_tool"),
      ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
      ...DELEGATION_TOOLS.map(makeTool),
    ]),
    skillService: createTestSkillService(),
    storeManager,
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {
        orchestrator: { model: providerRegistry.modelIds[1]! },
      },
    } as SpecraConfig, logger: silentLogger });

    factory.createRootAgent("orchestrator");

    expect(providerRegistry.getModel).toHaveBeenCalledWith(providerRegistry.modelIds[1]);
    expect(providerRegistry.getModel).not.toHaveBeenCalledWith(providerRegistry.modelIds[0]);
  });

  test("fails fast when orchestrator model config is missing", () => {
    const providerRegistry = makeProviderRegistry();
    const factory = createAgentFactory({ definitions: [definition()],
    providerRegistry,
    toolRegistry: createRegistry([
      makeTool("unknown_tool"),
      ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
      ...DELEGATION_TOOLS.map(makeTool),
    ]),
    skillService: createTestSkillService(),
    storeManager,
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {},
    } as SpecraConfig, logger: silentLogger });

    expect(() => factory.createRootAgent("orchestrator")).toThrow(MissingAgentModelConfigError);

    try {
      factory.createRootAgent("orchestrator");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingAgentModelConfigError);
      expect((error as MissingAgentModelConfigError).name).toBe("MissingAgentModelConfigError");
      expect((error as MissingAgentModelConfigError).agentName).toBe("orchestrator");
      expect((error as MissingAgentModelConfigError).availableAgents).toEqual([]);
    }
  });

  test("fails fast when explore model config is missing", () => {
    const providerRegistry = makeProviderRegistry();
    const factory = createAgentFactory({ definitions: [
      definition(),
      definition({ name: "explore", promptProfileId: "explorer", tools: { tools: nonDelegatingExplorerTools } }),
    ],
    providerRegistry,
    toolRegistry: createRegistry([
      makeTool("unknown_tool"),
      ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
      ...DELEGATION_TOOLS.map(makeTool),
    ]),
    skillService: createTestSkillService(),
    storeManager,
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {
        orchestrator: { model: providerRegistry.modelIds[1]! },
      },
    } as SpecraConfig, logger: silentLogger });

    expect(() => factory.createAgent("explore")).toThrow(MissingAgentModelConfigError);

    try {
      factory.createAgent("explore");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingAgentModelConfigError);
      expect((error as MissingAgentModelConfigError).name).toBe("MissingAgentModelConfigError");
      expect((error as MissingAgentModelConfigError).agentName).toBe("explore");
      expect((error as MissingAgentModelConfigError).availableAgents).toEqual(["orchestrator"]);
    }
  });

  test("preserves NoModelsConfiguredError when the provider registry is empty", () => {
    const emptyProviderRegistry = {
      sdkRegistry: {} as ProviderRegistry["sdkRegistry"],
      models: new Map(),
      modelIds: [],
      getModel: () => {
        throw new Error("unexpected model lookup");
      },
    } as ProviderRegistry;

    const factory = createAgentFactory({ definitions: [definition()],
    providerRegistry: emptyProviderRegistry,
    toolRegistry: createRegistry([
      makeTool("unknown_tool"),
      ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
      ...DELEGATION_TOOLS.map(makeTool),
    ]),
    skillService: createTestSkillService(),
    storeManager,
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {
        orchestrator: { model: "missing:model" },
      },
    } as SpecraConfig, logger: silentLogger });

    expect(() => factory.createRootAgent("orchestrator")).toThrow(NoModelsConfiguredError);
  });

  test("fails fast with named unknown model error from provider registry", () => {
    const providerRegistry = makeProviderRegistry();
    const factory = createAgentFactory({ definitions: [definition()],
    providerRegistry,
    toolRegistry: createRegistry([
      makeTool("unknown_tool"),
      ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
      ...DELEGATION_TOOLS.map(makeTool),
    ]),
    skillService: createTestSkillService(),
    storeManager,
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {
        orchestrator: { model: "test:missing" },
      },
    } as SpecraConfig, logger: silentLogger });

    try {
      factory.createRootAgent("orchestrator");
      throw new Error("Expected createRootAgent to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownQualifiedIdError);
      const typedError = error as UnknownQualifiedIdError;
      expect(typedError.name).toBe("UnknownQualifiedIdError");
      expect(typedError.qualifiedId).toBe("test:missing");
      expect(typedError.availableIds).toEqual(["test:fallback", "test:configured"]);
    }
  });

  test("assigns title to root and child stores", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", promptProfileId: "explorer", tools: { tools: nonDelegatingExplorerTools } }),
    ]);

    const root = factory.createRootAgent("orchestrator", { title: "Root Title" });
    const child = factory.createAgent("explore", { title: "Child Title" });

    expect(root.store.getState().title).toBe("Root Title");
    expect(child.store.getState().title).toBe("Child Title");
  });

  test("assigns parent session id via CreateSessionOptions at store creation time", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", promptProfileId: "explorer", tools: { tools: nonDelegatingExplorerTools } }),
    ]);

    const parentSessionId = "parent-session";
    const store = storeManager.create(crypto.randomUUID(), "/test", { parentSessionId });
    const child = factory.createAgent("explore", { store });

    expect(child.store.getState().parentSessionId).toBe(parentSessionId);
  });

  test("resolves explicit tool lists and strips delegation tools at depth three", () => {
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
    // depth < MAX_SUB_AGENT_DEPTH (3): delegation tools still present
    expect(factory.resolveAllowedTools(customDefinition, 2)).toEqual(["grep", "delegate"]);
    // depth >= MAX_SUB_AGENT_DEPTH (3): delegation tools stripped
    expect(factory.resolveAllowedTools(customDefinition, 3)).toEqual(["grep"]);
    expect(factory.resolveAllowedTools(delegatingDefinition, 1)).toEqual([
      "unknown_tool",
      ...EXPLORER_READ_ONLY_TOOLS,
      ...DELEGATION_TOOLS,
    ]);
    // depth 2 (< 3): delegation tools still present
    expect(factory.resolveAllowedTools(delegatingDefinition, 2)).toEqual([
      "unknown_tool",
      ...EXPLORER_READ_ONLY_TOOLS,
      ...DELEGATION_TOOLS,
    ]);
    // depth 3 (>= 3): delegation tools stripped
    expect(factory.resolveAllowedTools(delegatingDefinition, 3)).toEqual(["unknown_tool", ...EXPLORER_READ_ONLY_TOOLS]);
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
    // depth 2 (< MAX_SUB_AGENT_DEPTH=3): delegation still allowed, targets returned
    expect(factory.getDelegateTargetsFor(depthFilteredDefinition, 2)).toEqual(["explore", "custom"]);
    // depth 3 (>= MAX_SUB_AGENT_DEPTH): delegation stripped, targets empty
    expect(factory.getDelegateTargetsFor(depthFilteredDefinition, 3)).toEqual([]);
    expect(factory.getDelegateTargetsFor(explicitWithoutDelegate, 0)).toEqual([]);
  });

  test("resolves delegated skills with target allow-list validation and dedupe", async () => {
    const target = definition({ name: "explore", promptProfileId: "explorer", tools: { tools: nonDelegatingExplorerTools }, skills: ["codemap", "git-master"] });
    const factory = makeFactory([definition(), target], { skillService: createSkillServiceWithBuiltins() });

    const skills = await factory.resolveDelegatedSkills(target, ["codemap", "git-master", "codemap"]);

    expect(skills.map((skill) => skill.metadata.name)).toEqual(["codemap", "git-master"]);
    await expect(factory.resolveDelegatedSkills(target, ["research-docs"])).rejects.toThrow("Skill \"research-docs\" is not allowed");
  });
});
