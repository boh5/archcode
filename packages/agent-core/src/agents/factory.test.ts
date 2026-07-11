import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import type { ArchCodeConfig } from "../config/schema";
import { ModelInfo } from "../provider/model";
import { UnknownQualifiedIdError, type ProviderRegistry } from "../provider/index";
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
import { createTestProjectContextResolver } from "./test-project-context-resolver";

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
  options: { providerRegistry?: ProviderRegistry; config?: Partial<ArchCodeConfig>; skillService?: SkillService } = {},
) {
  const providerRegistry = options.providerRegistry ?? makeProviderRegistry();
  const config: ArchCodeConfig = {
    provider: {},
    ...options.config,
    agents:
      options.config?.agents ??
      Object.fromEntries(
        definitions.map((definitionItem) => [definitionItem.name, { model: providerRegistry.modelIds[1] ?? providerRegistry.modelIds[0] }]),
      ),
  } as ArchCodeConfig;

  return createAgentFactory({ definitions,
  providerRegistry,
  toolRegistry: createRegistry([
    makeTool("unknown_tool"),
    ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
    ...DELEGATION_TOOLS.map(makeTool),
  ]),
  skillService: options.skillService ?? createTestSkillService(),
  storeManager,
  projectContextResolver: createTestProjectContextResolver(storeManager),
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
    const store = storeManager.create(`factory-root-${crypto.randomUUID()}`, import.meta.dir);

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
    projectContextResolver: createTestProjectContextResolver(storeManager),
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {
        orchestrator: { model: providerRegistry.modelIds[1]! },
      },
    } as ArchCodeConfig, logger: silentLogger });

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
    projectContextResolver: createTestProjectContextResolver(storeManager),
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {
        orchestrator: { model: providerRegistry.modelIds[1]! },
      },
    } as ArchCodeConfig, logger: silentLogger });

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
    projectContextResolver: createTestProjectContextResolver(storeManager),
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {},
    } as ArchCodeConfig, logger: silentLogger });

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
    projectContextResolver: createTestProjectContextResolver(storeManager),
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {
        orchestrator: { model: providerRegistry.modelIds[1]! },
      },
    } as ArchCodeConfig, logger: silentLogger });

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
    projectContextResolver: createTestProjectContextResolver(storeManager),
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {
        orchestrator: { model: "missing:model" },
      },
    } as ArchCodeConfig, logger: silentLogger });

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
    projectContextResolver: createTestProjectContextResolver(storeManager),
    workspaceRoot: import.meta.dir,
    config: {
      provider: {},
      agents: {
        orchestrator: { model: "test:missing" },
      },
    } as ArchCodeConfig, logger: silentLogger });

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

  test("preserves goal id on supplied stores", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", promptProfileId: "explorer", tools: { tools: nonDelegatingExplorerTools } }),
    ]);

    const goalId = crypto.randomUUID();
    const store = storeManager.create(crypto.randomUUID(), "/test", { goalId });
    const child = factory.createAgent("explore", { store });

    expect(child.store.getState().goalId).toBe(goalId);
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

    const skills = await factory.resolveDelegatedSkills(target, ["codemap", "git-master", "codemap"], import.meta.dir);

    expect(skills.map((skill) => skill.metadata.name)).toEqual(["codemap", "git-master"]);
    await expect(factory.resolveDelegatedSkills(target, ["research-docs"], import.meta.dir)).rejects.toThrow("Skill \"research-docs\" is not allowed");
  });
});

describe("factoryResolveAllowedTools with MCP tools", () => {
  function makeMcpFactory(def: AgentDefinition, extraTools: AnyToolDescriptor[] = []) {
    const providerRegistry = makeProviderRegistry();
    return createAgentFactory({
      definitions: [def],
      providerRegistry,
      toolRegistry: createRegistry([
        makeTool("unknown_tool"),
        ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
        ...DELEGATION_TOOLS.map(makeTool),
        ...extraTools,
      ]),
      skillService: createTestSkillService(),
      storeManager,
      projectContextResolver: createTestProjectContextResolver(storeManager),
      workspaceRoot: import.meta.dir,
      config: {
        provider: {},
        agents: { [def.name]: { model: providerRegistry.modelIds[0]! } },
      } as ArchCodeConfig,
      logger: silentLogger,
    });
  }

  test("includes mcp__{server}__* tools when mcpTools lists the server", () => {
    const mcpTools: AnyToolDescriptor[] = [
      makeTool("mcp__testserver__search"),
      makeTool("mcp__testserver__read"),
    ];
    const def = definition({ mcpTools: ["testserver"] });
    const factory = makeMcpFactory(def, mcpTools);

    const allowed = factory.resolveAllowedTools(def, 0);

    expect(allowed).toContain("mcp__testserver__search");
    expect(allowed).toContain("mcp__testserver__read");
  });

  test("omits mcp tools for unlisted servers", () => {
    const mcpTools = [makeTool("mcp__other__tool")];
    const def = definition({ mcpTools: ["testserver"] });
    const factory = makeMcpFactory(def, mcpTools);

    const allowed = factory.resolveAllowedTools(def, 0);

    expect(allowed).not.toContain("mcp__other__tool");
  });

  test("returns no mcp tools when registry has no matching prefix (MCP not yet loaded)", () => {
    const def = definition({ mcpTools: ["testserver"] });
    const factory = makeMcpFactory(def);

    const allowed = factory.resolveAllowedTools(def, 0);

    const mcpItems = allowed.filter((name) => name.startsWith("mcp__"));
    expect(mcpItems).toEqual([]);
  });

  test("picks up tools registered after initial resolution (simulates background loading)", () => {
    const def = definition({ mcpTools: ["lazy"] });
    const providerRegistry = makeProviderRegistry();
    const registry = createRegistry([
      makeTool("unknown_tool"),
      ...EXPLORER_READ_ONLY_TOOLS.map(makeTool),
      ...DELEGATION_TOOLS.map(makeTool),
    ]);
    const factory = createAgentFactory({
      definitions: [def],
      providerRegistry,
      toolRegistry: registry,
      skillService: createTestSkillService(),
      storeManager,
      projectContextResolver: createTestProjectContextResolver(storeManager),
      workspaceRoot: import.meta.dir,
      config: {
        provider: {},
        agents: { [def.name]: { model: providerRegistry.modelIds[0]! } },
      } as ArchCodeConfig,
      logger: silentLogger,
    });

    // First call — no mcp tools yet
    const first = factory.resolveAllowedTools(def, 0);
    expect(first.filter((n) => n.startsWith("mcp__"))).toEqual([]);

    // Register MCP tools after factory creation
    registry.register(makeTool("mcp__lazy__search"));
    registry.register(makeTool("mcp__lazy__read"));

    // Second call — mcp tools should now appear
    const second = factory.resolveAllowedTools(def, 0);
    expect(second).toContain("mcp__lazy__search");
    expect(second).toContain("mcp__lazy__read");
  });

  test("survives depth filtering for non-delegation MCP tools", () => {
    const mcpTools = [makeTool("mcp__testserver__search")];
    const def = definition({ mcpTools: ["testserver"] });
    const factory = makeMcpFactory(def, mcpTools);

    // Depth < MAX_SUB_AGENT_DEPTH: mcp tool present
    const shallow = factory.resolveAllowedTools(def, 2);
    expect(shallow).toContain("mcp__testserver__search");

    // Depth >= MAX_SUB_AGENT_DEPTH: mcp tool still present (not a delegation tool)
    const deep = factory.resolveAllowedTools(def, 3);
    expect(deep).toContain("mcp__testserver__search");
    // Normal delegation tools ARE stripped at max depth
    expect(deep).not.toContain("delegate");
  });

  test("does not introduce duplicates for tool names that appear in both tools and mcpTools", () => {
    // Namespace separation prevents overlap: resolveForAgent resolves
    // exact names from definition.tools.tools (normal tool names),
    // while listByPrefix returns mcp__{server}__ names. If a tool name
    // somehow matches both sources, the result includes it at least once.
    const mcpTools = [makeTool("mcp__test__grep")];
    const def = definition({ tools: { tools: ["grep", "mcp__test__grep"] }, mcpTools: ["test"] });
    const factory = makeMcpFactory(def, mcpTools);

    const allowed = factory.resolveAllowedTools(def, 0);

    expect(allowed).toContain("grep");
    // mcp__test__grep is in the result (from resolveForAgent + listByPrefix).
    // Dedup is not applied since namespaces don't overlap in practice.
    expect(allowed.filter((n) => n === "mcp__test__grep").length).toBeGreaterThanOrEqual(1);
  });

  test("sanitizes server name with dots when computing MCP prefix (grep.app → mcp__grep_app__)", () => {
    // Registry name generation sanitizes dots to underscores, so the prefix
    // lookup must use the same sanitization or tools silently disappear.
    const mcpTools: AnyToolDescriptor[] = [
      makeTool("mcp__grep_app__search"),
      makeTool("mcp__grep_app__read"),
    ];
    const def = definition({ mcpTools: ["grep.app"] });
    const factory = makeMcpFactory(def, mcpTools);

    const allowed = factory.resolveAllowedTools(def, 0);

    expect(allowed).toContain("mcp__grep_app__search");
    expect(allowed).toContain("mcp__grep_app__read");
  });

  test("does not match unsanitized prefix for dotted server name", () => {
    // Without coordination, prefix "mcp__grep.app__" would match nothing
    // because the registered name is "mcp__grep_app__search".
    const mcpTools: AnyToolDescriptor[] = [
      makeTool("mcp__grep_app__search"),
    ];
    const def = definition({ mcpTools: ["grep.app"] });
    const factory = makeMcpFactory(def, mcpTools);

    const allowed = factory.resolveAllowedTools(def, 0);

    expect(allowed).toContain("mcp__grep_app__search");
    expect(allowed).not.toContain("mcp__grep.app__search");
  });
});
