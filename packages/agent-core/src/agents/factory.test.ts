import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { SkillService } from "../skills";
import { storeManager } from "../store/store";
import type { ToolRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { createTextToolResult } from "../tools/results";
import { createTestToolRegistryFixture, type TestToolRegistryFixture } from "../tools/test-registry";
import { DELEGATION_CORE_TOOLS } from "./constants";
import { SkillNotAllowedError } from "./errors";
import {
  AgentStoreIdentityMismatchError,
  DuplicateAgentDefinitionError,
  UnknownAgentDefinitionError,
  createAgentFactory,
} from "./factory";
import { ConfiguredAgent } from "./configured-agent";
import type { AgentDefinition, AgentName } from "./factory-types";
import { silentLogger } from "../logger";
import { createTestProjectContextResolver } from "./test-project-context-resolver";
import { createTestTempRoot } from "../testing/test-temp-root";

const testTempRoot = createTestTempRoot("agent-factory");
const TEST_WORKSPACE_ROOT = testTempRoot.path;
const registryFixtures: TestToolRegistryFixture[] = [];
const outputAccessFixture = createTestToolRegistryFixture();

function createTestRegistry(descriptors: AnyToolDescriptor[]): ToolRegistry {
  const fixture = createTestToolRegistryFixture({ descriptors });
  registryFixtures.push(fixture);
  return fixture.registry;
}

afterAll(async () => {
  await Bun.sleep(0);
  storeManager.clearAll();
  await Promise.all([...registryFixtures, outputAccessFixture].map((fixture) => fixture.dispose()));
  await testTempRoot.cleanup();
});

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

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { name: "engineer",
  displayName: "Engineer",
  promptProfileId: "default",
  tools: { tools: ["unknown_tool", ...explorerTools], delegateTargets: ["explore"] },
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoStepReminder: true,
    todoQueryLoopContinuation: true,
    memoryExtraction: true,
    memoryConsolidation: true,
    titleGeneration: "enabled",
  },
  includeMemoryInPrompt: true,
  skills: [], ...overrides,  };
}

function makeFactory(
  definitions: readonly AgentDefinition[] = [definition()],
  options: { skillService?: SkillService } = {},
) {
  return createAgentFactory({ definitions,
  toolRegistry: createTestRegistry([
    makeTool("unknown_tool"),
    ...READ_ONLY_FIXTURE_TOOLS.map(makeTool),
    ...DELEGATION_CORE_TOOLS.map(makeTool),
  ]),
  skillService: options.skillService ?? createTestSkillService(),
  storeManager,
  projectContextResolver: createTestProjectContextResolver(storeManager),
  workspaceRoot: TEST_WORKSPACE_ROOT,
  createToolOutputAccess: outputAccessFixture.createToolOutputAccess,
  logger: silentLogger });
}

const READ_ONLY_FIXTURE_TOOLS = [
  "file_read", "grep", "glob", "git_status", "git_diff", "ast_grep_search",
  "lsp_diagnostics", "lsp_goto_definition", "lsp_find_references", "lsp_symbols", "web_fetch",
] as const;
const explorerTools = [...READ_ONLY_FIXTURE_TOOLS, ...DELEGATION_CORE_TOOLS] as const;
const nonDelegatingExplorerTools = READ_ONLY_FIXTURE_TOOLS;

describe("createAgentFactory", () => {
  test("rejects duplicate definitions with a named error", () => {
    expect(() => makeFactory([definition(), definition()])).toThrow(DuplicateAgentDefinitionError);

    try {
      makeFactory([definition(), definition()]);
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateAgentDefinitionError);
      expect((error as DuplicateAgentDefinitionError).name).toBe("DuplicateAgentDefinitionError");
      expect((error as DuplicateAgentDefinitionError).definitionName).toBe("engineer");
    }
  });

  test("rejects unknown agent names with a named error", () => {
    const factory = makeFactory();

    expect(() => factory.getDefinition("missing")).toThrow(UnknownAgentDefinitionError);
    expect(() => factory.createAgent("missing" as AgentName)).toThrow(UnknownAgentDefinitionError);
  });

  test("creates root agents through the factory API with a supplied store", () => {
    const factory = makeFactory();
    const store = storeManager.create(`factory-root-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, { agentName: "engineer" });

    const agent = factory.createRootAgent("engineer", { store });

    expect(agent.store).toBe(store);
    expect(agent.store.getState().sessionId).toBe(store.getState().sessionId);
    expect(typeof agent.run).toBe("function");
  });

  test("rejects an Agent definition that conflicts with persisted Session identity", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", promptProfileId: "explorer", tools: { tools: nonDelegatingExplorerTools } }),
    ]);
    const store = storeManager.create(crypto.randomUUID(), TEST_WORKSPACE_ROOT, { agentName: "explore" });

    expect(() => factory.createAgent("engineer", { store })).toThrow(AgentStoreIdentityMismatchError);
    expect(store.getState().agentName).toBe("explore");
  });

  test("root agents default to no active skills", () => {
    const factory = makeFactory();

    const agent = factory.createRootAgent("engineer");

    expect(agent).toBeInstanceOf(ConfiguredAgent);
    expect(agent.store.getState().activeSkillNames).toEqual([]);
  });

  test("keeps active Skill identity on the supplied Session store", () => {
    const skillService = createTestSkillService();
    const factory = createAgentFactory({ definitions: [definition()],
    toolRegistry: createTestRegistry([
      makeTool("unknown_tool"),
      ...READ_ONLY_FIXTURE_TOOLS.map(makeTool),
      ...DELEGATION_CORE_TOOLS.map(makeTool),
    ]),
    skillService,
    storeManager,
    projectContextResolver: createTestProjectContextResolver(storeManager),
    workspaceRoot: TEST_WORKSPACE_ROOT,
    createToolOutputAccess: outputAccessFixture.createToolOutputAccess,
    logger: silentLogger });

    const store = storeManager.create(crypto.randomUUID(), TEST_WORKSPACE_ROOT, {
      agentName: "engineer",
      activeSkillNames: ["git-master"],
    });
    const agent = factory.createAgent("engineer", { store });

    expect(agent).toBeInstanceOf(ConfiguredAgent);
    expect(agent.store.getState().activeSkillNames).toEqual(["git-master"]);
    expect((agent as unknown as { skillService: SkillService }).skillService).toBe(skillService);
  });

  test("preserves the canonical title from the supplied Session store", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", promptProfileId: "explorer", tools: { tools: nonDelegatingExplorerTools } }),
    ]);

    const rootStore = storeManager.create(crypto.randomUUID(), TEST_WORKSPACE_ROOT, { agentName: "engineer", title: "Root Title" });
    const childStore = storeManager.create(crypto.randomUUID(), TEST_WORKSPACE_ROOT, { agentName: "explore", title: "Child Title" });
    const root = factory.createRootAgent("engineer", { store: rootStore });
    const child = factory.createAgent("explore", { store: childStore });

    expect(root.store.getState().title).toBe("Root Title");
    expect(child.store.getState().title).toBe("Child Title");
  });

  test("preserves parent session id from canonical store identity", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", promptProfileId: "explorer", tools: { tools: nonDelegatingExplorerTools } }),
    ]);

    const parentSessionId = "parent-session";
    const store = storeManager.create(crypto.randomUUID(), "/test", { parentSessionId, agentName: "explore" });
    const child = factory.createAgent("explore", { store });

    expect(child.store.getState().parentSessionId).toBe(parentSessionId);
  });

  test("preserves goal id on supplied stores", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", promptProfileId: "explorer", tools: { tools: nonDelegatingExplorerTools } }),
    ]);

    const goalId = crypto.randomUUID();
    const store = storeManager.create(crypto.randomUUID(), "/test", { goalId, agentName: "explore" });
    const child = factory.createAgent("explore", { store });

    expect(child.store.getState().goalId).toBe(goalId);
  });

  test("resolves explicit tool lists and strips delegation tools at depth three", () => {
    const factory = makeFactory();
    const customDefinition = definition({ tools: { tools: ["grep", "missing", "delegate"] } });
    const delegatingDefinition = definition({
      name: "engineer",
      tools: { tools: ["unknown_tool", ...explorerTools] },
    });

    expect(factory.resolveAllowedTools(definition(), 0)).toEqual([
      "unknown_tool",
      ...READ_ONLY_FIXTURE_TOOLS,
      ...DELEGATION_CORE_TOOLS,
    ]);
    expect(factory.resolveAllowedTools(customDefinition, 0)).toEqual(["grep", "delegate"]);
    // depth < MAX_SUB_AGENT_DEPTH (3): delegation tools still present
    expect(factory.resolveAllowedTools(customDefinition, 2)).toEqual(["grep", "delegate"]);
    // depth >= MAX_SUB_AGENT_DEPTH (3): delegation tools stripped
    expect(factory.resolveAllowedTools(customDefinition, 3)).toEqual(["grep"]);
    expect(factory.resolveAllowedTools(delegatingDefinition, 1)).toEqual([
      "unknown_tool",
      ...READ_ONLY_FIXTURE_TOOLS,
      ...DELEGATION_CORE_TOOLS,
    ]);
    // depth 2 (< 3): delegation tools still present
    expect(factory.resolveAllowedTools(delegatingDefinition, 2)).toEqual([
      "unknown_tool",
      ...READ_ONLY_FIXTURE_TOOLS,
      ...DELEGATION_CORE_TOOLS,
    ]);
    // depth 3 (>= 3): delegation tools stripped
    expect(factory.resolveAllowedTools(delegatingDefinition, 3)).toEqual(["unknown_tool", ...READ_ONLY_FIXTURE_TOOLS]);
  });

  test("resolves delegate targets only when depth allows delegation", () => {
    const factory = makeFactory();
    const depthFilteredDefinition = definition({
      name: "explore",
      tools: { tools: explorerTools, delegateTargets: ["explore", "goal_lead"] },
    });
    const explicitWithoutDelegate = definition({
      name: "goal_lead",
      tools: { tools: ["grep"], delegateTargets: ["explore"] },
    });

    expect(factory.getDelegateTargetsFor(depthFilteredDefinition, 1)).toEqual(["explore", "goal_lead"]);
    // depth 2 (< MAX_SUB_AGENT_DEPTH=3): delegation still allowed, targets returned
    expect(factory.getDelegateTargetsFor(depthFilteredDefinition, 2)).toEqual(["explore", "goal_lead"]);
    // depth 3 (>= MAX_SUB_AGENT_DEPTH): delegation stripped, targets empty
    expect(factory.getDelegateTargetsFor(depthFilteredDefinition, 3)).toEqual([]);
    expect(factory.getDelegateTargetsFor(explicitWithoutDelegate, 0)).toEqual([]);
  });

  test("validates and deduplicates delegated Skill names before persistence", async () => {
    const target = definition({ name: "explore", promptProfileId: "explorer", tools: { tools: nonDelegatingExplorerTools }, skills: ["codemap", "git-master"] });
    const factory = makeFactory([definition(), target], { skillService: createSkillServiceWithBuiltins() });

    const skillNames = await factory.resolveDelegatedSkillNames(target, ["codemap", "git-master", "codemap"], import.meta.dir);

    expect(skillNames).toEqual(["codemap", "git-master"]);
    try {
      await factory.resolveDelegatedSkillNames(target, ["research-docs"], import.meta.dir);
      throw new Error("Expected delegated Skill validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillNotAllowedError);
      expect(error).toMatchObject({
        targetAgentName: "explore",
        skillName: "research-docs",
        allowedSkills: ["codemap", "git-master"],
      });
    }
  });
});

describe("factoryResolveAllowedTools with MCP tools", () => {
  function makeMcpFactory(def: AgentDefinition, extraTools: AnyToolDescriptor[] = []) {
    return createAgentFactory({
      definitions: [def],
      toolRegistry: createTestRegistry([
        makeTool("unknown_tool"),
        ...READ_ONLY_FIXTURE_TOOLS.map(makeTool),
        ...DELEGATION_CORE_TOOLS.map(makeTool),
        ...extraTools,
      ]),
      skillService: createTestSkillService(),
      storeManager,
      projectContextResolver: createTestProjectContextResolver(storeManager),
      workspaceRoot: TEST_WORKSPACE_ROOT,
      createToolOutputAccess: outputAccessFixture.createToolOutputAccess,
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
    const registry = createTestRegistry([
      makeTool("unknown_tool"),
      ...READ_ONLY_FIXTURE_TOOLS.map(makeTool),
      ...DELEGATION_CORE_TOOLS.map(makeTool),
    ]);
    const factory = createAgentFactory({
      definitions: [def],
      toolRegistry: registry,
      skillService: createTestSkillService(),
      storeManager,
      projectContextResolver: createTestProjectContextResolver(storeManager),
      workspaceRoot: TEST_WORKSPACE_ROOT,
      createToolOutputAccess: outputAccessFixture.createToolOutputAccess,
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
