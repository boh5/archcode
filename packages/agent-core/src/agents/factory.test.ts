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
import { leadRoleContract } from "./definitions/role-contracts";
import { discussionAgentDefinition } from "./definitions";
import { silentLogger } from "../logger";
import { createTestProjectContextResolver } from "./test-project-context-resolver";
import { createTestTempRoot } from "../testing/test-temp-root";
import {
  EMPTY_ATTACHMENT_MODEL_PROJECTOR,
  resolveEmptyAttachmentReadPaths,
} from "../attachments/test-helpers";

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
  await Promise.resolve();
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
      "git-master": { entry: "---\nname: git-master\ndescription: Git helper. Use for git operations.\n---\nUse git carefully.", resources: {} },
      codemap: { entry: "---\nname: codemap\ndescription: Code map helper. Use before implementation.\n---\nMap code first.", resources: {} },
    },
  });
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { name: "lead",
  displayName: "Lead Lead",
  profiles: ["principal"],
  roleContract: leadRoleContract,
  tools: { tools: ["unknown_tool", ...explorerTools], delegateTargets: ["explore"] },
  builtinMcpServers: [],
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
  attachmentProjector: EMPTY_ATTACHMENT_MODEL_PROJECTOR,
  resolveAttachmentReadPaths: resolveEmptyAttachmentReadPaths,
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
      expect((error as DuplicateAgentDefinitionError).definitionName).toBe("lead");
    }
  });

  test("rejects unknown agent names with a named error", () => {
    const factory = makeFactory();

    expect(() => factory.getDefinition("missing")).toThrow(UnknownAgentDefinitionError);
    expect(() => factory.createAgent("missing" as AgentName)).toThrow(UnknownAgentDefinitionError);
  });

  test("creates root agents through the factory API with a supplied store", () => {
    const factory = makeFactory();
    const store = storeManager.create(`factory-root-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, { source: { kind: "direct" }, agentName: "lead" });

    const agent = factory.createRootAgent("lead", { store });

    expect(agent.store).toBe(store);
    expect(agent.store.getState().sessionId).toBe(store.getState().sessionId);
    expect(typeof agent.run).toBe("function");
  });

  test("creates a store-less root Lead with direct source identity", () => {
    const agent = makeFactory().createRootAgent("lead");
    expect(agent.store.getState().source).toEqual({ kind: "direct" });
  });

  test("creates Discussion only from a Todo-bound root store", () => {
    const factory = makeFactory([definition(), discussionAgentDefinition]);
    const store = storeManager.create(`factory-discussion-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, {
      agentName: "discussion",
      source: { kind: "todo", todoId: crypto.randomUUID(), entry: "discussion" },
    });

    expect(factory.createRootAgent("discussion", { store }).store).toBe(store);
    expect(() => storeManager.create(`factory-discussion-invalid-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, {
      agentName: "discussion",
      source: { kind: "direct" },
    })).toThrow(
      "Discussion Sessions require a Discussion Project Todo source",
    );
  });

  test("rejects an Agent definition that conflicts with persisted Session identity", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", tools: { tools: nonDelegatingExplorerTools } }),
    ]);
    const parentSessionId = crypto.randomUUID();
    storeManager.create(parentSessionId, TEST_WORKSPACE_ROOT, { source: { kind: "direct" }, agentName: "lead" });
    const store = storeManager.create(crypto.randomUUID(), TEST_WORKSPACE_ROOT, {
      agentName: "explore",
      parentSessionId,
      rootSessionId: parentSessionId,
    });

    expect(() => factory.createAgent("lead", { store })).toThrow(AgentStoreIdentityMismatchError);
    expect(store.getState().agentName).toBe("explore");
  });

  test("root agents default to no active skills", () => {
    const factory = makeFactory();
    const store = storeManager.create(crypto.randomUUID(), TEST_WORKSPACE_ROOT, {
      agentName: "lead",
      source: { kind: "direct" },
    });

    const agent = factory.createRootAgent("lead", { store });

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
    attachmentProjector: EMPTY_ATTACHMENT_MODEL_PROJECTOR,
    resolveAttachmentReadPaths: resolveEmptyAttachmentReadPaths,
    logger: silentLogger });

    const store = storeManager.create(crypto.randomUUID(), TEST_WORKSPACE_ROOT, {
      agentName: "lead",
      source: { kind: "direct" },
      activeSkillNames: ["git-master"],
    });
    const agent = factory.createAgent("lead", { store });

    expect(agent).toBeInstanceOf(ConfiguredAgent);
    expect(agent.store.getState().activeSkillNames).toEqual(["git-master"]);
    expect((agent as unknown as { skillService: SkillService }).skillService).toBe(skillService);
  });

  test("preserves the canonical title from the supplied Session store", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", tools: { tools: nonDelegatingExplorerTools } }),
    ]);

    const rootStore = storeManager.create(crypto.randomUUID(), TEST_WORKSPACE_ROOT, { source: { kind: "direct" }, agentName: "lead", title: "Root Title" });
    const childStore = storeManager.create(crypto.randomUUID(), TEST_WORKSPACE_ROOT, {
      agentName: "explore",
      title: "Child Title",
      parentSessionId: rootStore.getState().sessionId,
      rootSessionId: rootStore.getState().sessionId,
    });
    const root = factory.createRootAgent("lead", { store: rootStore });
    const child = factory.createAgent("explore", { store: childStore });

    expect(root.store.getState().title).toBe("Root Title");
    expect(child.store.getState().title).toBe("Child Title");
  });

  test("preserves parent session id from canonical store identity", () => {
    const factory = makeFactory([
      definition(),
      definition({ name: "explore", tools: { tools: nonDelegatingExplorerTools } }),
    ]);

    const parentSessionId = "parent-session";
    const store = storeManager.create(crypto.randomUUID(), "/test", {
      parentSessionId,
      rootSessionId: parentSessionId,
      agentName: "explore",
    });
    const child = factory.createAgent("explore", { store });

    expect(child.store.getState().parentSessionId).toBe(parentSessionId);
  });

  test("resolves explicit tool lists and strips delegation tools at depth three", () => {
    const factory = makeFactory();
    const customDefinition = definition({ tools: { tools: ["grep", "missing", "delegate"] } });
    const delegatingDefinition = definition({
      name: "lead",
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
      tools: { tools: explorerTools, delegateTargets: ["explore", "analyst"] },
    });
    const explicitWithoutDelegate = definition({
      name: "analyst",
      tools: { tools: ["grep"], delegateTargets: ["explore"] },
    });

    expect(factory.getDelegateTargetsFor(depthFilteredDefinition, 1)).toEqual(["explore", "analyst"]);
    // depth 2 (< MAX_SUB_AGENT_DEPTH=3): delegation still allowed, targets returned
    expect(factory.getDelegateTargetsFor(depthFilteredDefinition, 2)).toEqual(["explore", "analyst"]);
    // depth 3 (>= MAX_SUB_AGENT_DEPTH): delegation stripped, targets empty
    expect(factory.getDelegateTargetsFor(depthFilteredDefinition, 3)).toEqual([]);
    expect(factory.getDelegateTargetsFor(explicitWithoutDelegate, 0)).toEqual([]);
  });

  test("validates and deduplicates delegated Skill names before persistence", async () => {
    const target = definition({ name: "explore", tools: { tools: nonDelegatingExplorerTools }, skills: ["codemap", "git-master"] });
    const factory = makeFactory([definition(), target], { skillService: createSkillServiceWithBuiltins() });

    const skillNames = await factory.resolveDelegatedSkillNames(target, ["codemap", "git-master", "codemap"], import.meta.dir);

    expect(skillNames).toEqual(["codemap", "git-master"]);
    try {
      await factory.resolveDelegatedSkillNames(target, ["run-goal"], import.meta.dir);
      throw new Error("Expected delegated Skill validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillNotAllowedError);
      expect(error).toMatchObject({
        targetAgentName: "explore",
        skillName: "run-goal",
        allowedSkills: ["codemap", "git-master"],
      });
    }
  });
});

describe("factoryResolveAllowedTools static base-tool projection", () => {
  function makeStaticFactory(def: AgentDefinition, extraTools: AnyToolDescriptor[] = []) {
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
      attachmentProjector: EMPTY_ATTACHMENT_MODEL_PROJECTOR,
      resolveAttachmentReadPaths: resolveEmptyAttachmentReadPaths,
      logger: silentLogger,
    });
  }

  test("resolves only the definition's static base tools", () => {
    const def = definition({ builtinMcpServers: ["context7"], tools: { tools: ["grep", "missing"] } });
    const factory = makeStaticFactory(def, [makeTool("mcp__context7__search")]);

    expect(factory.resolveAllowedTools(def, 0)).toEqual(["grep"]);
  });

  test("does not change the static projection when MCP descriptors load later", () => {
    const def = definition({ builtinMcpServers: ["context7"], tools: { tools: ["grep"] } });
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
      attachmentProjector: EMPTY_ATTACHMENT_MODEL_PROJECTOR,
      resolveAttachmentReadPaths: resolveEmptyAttachmentReadPaths,
      logger: silentLogger,
    });

    const first = factory.resolveAllowedTools(def, 0);
    expect(first).toEqual(["grep"]);

    registry.register(makeTool("mcp__context7__search"));

    const second = factory.resolveAllowedTools(def, 0);
    expect(second).toEqual(["grep"]);
  });
});
