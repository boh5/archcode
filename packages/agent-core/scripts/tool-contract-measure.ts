import { jsonSchema } from "ai";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { z } from "zod/v4";
import type { BuiltinMcpServerName } from "@archcode/protocol";
import { agentDefinitions } from "../src/agents/definitions";
import type { AgentDefinition, DelegationCapabilitySnapshot } from "../src/agents/factory-types";
import type { AgentMcpToolSnapshot } from "../src/agents/factory-types";
import { ConfiguredAgent } from "../src/agents/configured-agent";
import { AGENT_NAMES, type AgentName } from "../src/agents/names";
import { resolveDefinitionAllowedTools } from "../src/agents/tool-filter";
import {
  buildDeferredToolDirectory,
  projectVisibleTools,
  type ToolCatalog,
  type ToolCatalogEntry,
} from "../src/agents/tool-visibility";
import { createTestProjectContextResolver } from "../src/agents/test-project-context-resolver";
import {
  EMPTY_ATTACHMENT_MODEL_PROJECTOR,
  resolveEmptyAttachmentReadPaths,
} from "../src/attachments/test-helpers";
import { registerBuiltinTools } from "../src/core/register-tools";
import { silentLogger } from "../src/logger";
import { toMcpToolRegistryName } from "../src/mcp/naming";
import { SkillService } from "../src/skills";
import { SessionStoreManager } from "../src/store/session-store-manager";
import { createTestToolRegistryFixture, type TestToolRegistryFixture } from "../src/tools/test-registry";
import { ResolvedToolSet } from "../src/tools/registry";
import type { AnyToolDescriptor } from "../src/tools/types";

const LEAD_AUTHORIZED_BASELINE_TOKENS = 11_845;
const LOADED_FIXTURE_LIMIT = 5;
const MCP_TOOLS_PER_SERVER = 2;
const USER_MCP_SERVER_ID = "measure-user";

const STATE_ACTIVATION_NAMES = [
  "get_goal", "update_goal", "project_todo_update", "pdf_read", "output_read",
  "output_search", "list_agents", "send_message", "background_output",
  "wait_for_reminder", "cancel_session", "resume_session", "worktree_enter",
  "worktree_exit",
] as const;

type OpenAICompatibleTool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
};

interface TokenMetrics {
  readonly count: number;
  readonly tokens: {
    readonly full: number;
    readonly names: number;
    readonly descriptions: number;
    readonly parameters: number;
    readonly skeleton: number;
  };
}

interface DirectoryMetrics {
  readonly toolCount: number;
  readonly characters: number;
  readonly utf8Bytes: number;
  readonly tokens: number;
}

const tokenizer = new Tiktoken(o200kBase);

async function measureAllAgents(): Promise<unknown> {
  const fixture = createTestToolRegistryFixture({ logger: silentLogger });
  const storeManager = new SessionStoreManager({ logger: silentLogger });
  try {
    registerBuiltinTools(fixture.registry, silentLogger, { github: { enabled: false } });
    const definitions = new Map(agentDefinitions.map((definition) => [definition.name, definition]));
    const agents = [];

    for (const agentName of AGENT_NAMES) {
      const definition = requireDefinition(definitions, agentName);
      const runtimeDepth = agentName === "lead" || agentName === "discussion" ? 0 : 1;
      const agent = createMeasurementAgent({
        definition,
        definitions,
        runtimeDepth,
        registry: fixture.registry,
        storeManager,
        createToolOutputAccess: fixture.createToolOutputAccess,
      });
      const live = await agent.resolveLiveAuthorizedToolCatalog({ extraTools: [], toolProjection: null });
      const localCatalog = localOnlyCatalog(live.catalog);
      const base = projectVisibleTools({ catalog: live.catalog, core: definition.tools.core, state: [], loaded: [] });
      const localBase = projectVisibleTools({ catalog: localCatalog, core: definition.tools.core, state: [], loaded: [] });
      const stateNames = STATE_ACTIVATION_NAMES.filter((name) =>
        localCatalog.entries.some((entry) => entry.registryName === name)
      );
      const state = projectVisibleTools({
        catalog: live.catalog,
        core: definition.tools.core,
        state: stateNames,
        loaded: [],
      });
      const loadedEntries = localBase.deferred.slice(0, LOADED_FIXTURE_LIMIT);
      const loaded = projectVisibleTools({
        catalog: live.catalog,
        core: definition.tools.core,
        state: [],
        loaded: loadedEntries.map((entry) => ({
          name: entry.registryName,
          descriptorDigest: entry.descriptorDigest,
        })),
      });

      const authorizedMetrics = measureEntries(localCatalog.entries);
      const initialMetrics = measureEntries(base.visible);
      const localInitialMetrics = measureEntries(localBase.visible);
      const stateMetrics = measureEntries(state.visible);
      const loadedMetrics = measureEntries(loaded.visible);
      const mcpInitialMetrics = measureEntries(base.visible);
      const initialDirectoryMetrics = measureDirectory(base.deferred);
      const localDirectoryMetrics = measureDirectory(localBase.deferred);
      const mcpEntries = live.catalog.entries.filter((entry) => entry.sourceKind === "mcp");
      agents.push({
        agent: agentName,
        authorized: authorizedMetrics,
        core: measureEntries(entriesByNames(localCatalog, definition.tools.core)),
        initial: {
          ...initialMetrics,
          names: base.visible.map((entry) => entry.registryName),
          deferredCount: base.deferred.length,
          deferredDirectory: initialDirectoryMetrics,
        },
        stateFixture: {
          activatedNames: stateNames,
          visible: stateMetrics,
          delta: metricDelta(initialMetrics, stateMetrics),
          deferredDirectory: measureDirectory(state.deferred),
        },
        loadedFixture: {
          loadedNames: loadedEntries.map((entry) => entry.registryName),
          visible: loadedMetrics,
          delta: metricDelta(initialMetrics, loadedMetrics),
          deferredDirectory: measureDirectory(loaded.deferred),
        },
        mcpDeferredFixture: {
          builtinServerIds: definition.builtinMcpServers,
          userServerId: USER_MCP_SERVER_ID,
          toolsPerServer: MCP_TOOLS_PER_SERVER,
          addedAuthorizedCount: mcpEntries.length,
          deferredCountBefore: localBase.deferred.length,
          deferredCountAfter: base.deferred.length,
          deferredDelta: base.deferred.length - localBase.deferred.length,
          initialCountDelta: mcpInitialMetrics.count - localInitialMetrics.count,
          initialFullTokenDelta: mcpInitialMetrics.tokens.full - localInitialMetrics.tokens.full,
          deferredDirectoryTokenDelta: initialDirectoryMetrics.tokens - localDirectoryMetrics.tokens,
        },
        ...(agentName === "lead" ? {
          leadBaseline: {
            authorizedFullTokensBefore: LEAD_AUTHORIZED_BASELINE_TOKENS,
            initialFullTokensAfter: initialMetrics.tokens.full,
            reductionPercent: round(
              (LEAD_AUTHORIZED_BASELINE_TOKENS - initialMetrics.tokens.full)
                / LEAD_AUTHORIZED_BASELINE_TOKENS * 100,
            ),
            initialToolAndDirectoryTokensAfter: initialMetrics.tokens.full + initialDirectoryMetrics.tokens,
            reductionIncludingDirectoryPercent: round(
              (LEAD_AUTHORIZED_BASELINE_TOKENS - initialMetrics.tokens.full - initialDirectoryMetrics.tokens)
                / LEAD_AUTHORIZED_BASELINE_TOKENS * 100,
            ),
          },
        } : {}),
      });
      agent.dispose();
    }

    return {
      tokenizer: "js-tiktoken@1.0.21/o200k_base",
      measurement: "ConfiguredAgent live Authorized Catalog -> production visibility projection -> OpenAI-compatible function wire plus compact deferred Prompt directory",
      fixtures: {
        state: "all currently authorized fixed state-activation tools",
        loaded: `up to the first ${LOADED_FIXTURE_LIMIT} stable deferred catalog entries`,
        mcp: "credential-free synthetic descriptors; builtin server ids follow each Agent matrix and one user server is global",
      },
      agents,
    };
  } finally {
    storeManager.clearAll();
    await fixture.dispose();
  }
}

function delegationCapabilities(
  definition: AgentDefinition,
  definitions: ReadonlyMap<AgentName, AgentDefinition>,
  runtimeDepth: number,
): DelegationCapabilitySnapshot {
  return {
    parentAgentName: definition.name,
    depth: runtimeDepth,
    targets: (definition.tools.delegateTargets ?? []).map((targetName) => {
      const target = requireDefinition(definitions, targetName);
      return { agentName: target.name, profiles: target.profiles, builtinSkillNames: target.skills };
    }),
  };
}

function createMeasurementAgent(input: {
  readonly definition: AgentDefinition;
  readonly definitions: ReadonlyMap<AgentName, AgentDefinition>;
  readonly runtimeDepth: number;
  readonly registry: TestToolRegistryFixture["registry"];
  readonly storeManager: SessionStoreManager;
  readonly createToolOutputAccess: TestToolRegistryFixture["createToolOutputAccess"];
}): ConfiguredAgent {
  const workspaceRoot = process.cwd();
  const sessionId = crypto.randomUUID();
  let store;
  if (input.definition.name === "lead") {
    store = input.storeManager.create(sessionId, workspaceRoot, {
      agentName: "lead",
      cwd: workspaceRoot,
      source: { kind: "direct" },
    });
  } else if (input.definition.name === "discussion") {
    store = input.storeManager.create(sessionId, workspaceRoot, {
      agentName: "discussion",
      cwd: workspaceRoot,
      source: { kind: "todo", todoId: crypto.randomUUID(), entry: "discussion" },
    });
  } else {
    const rootSessionId = crypto.randomUUID();
    input.storeManager.create(rootSessionId, workspaceRoot, {
      agentName: "lead",
      cwd: workspaceRoot,
      source: { kind: "direct" },
    });
    store = input.storeManager.create(sessionId, workspaceRoot, {
      agentName: input.definition.name,
      cwd: workspaceRoot,
      rootSessionId,
      parentSessionId: rootSessionId,
      delegationRequest: {
        agent_type: input.definition.name,
        profile: input.definition.profiles[0]!,
        title: "Tool contract measurement",
        objective: "Measure the production model-visible tool contract.",
        skills: [],
        background: false,
      },
    });
  }

  return new ConfiguredAgent({
    definition: input.definition,
    toolRegistry: input.registry,
    skillService: new SkillService(),
    storeManager: input.storeManager,
    store,
    toolOutputAccess: input.createToolOutputAccess(workspaceRoot, store.getState().rootSessionId),
    attachmentProjector: EMPTY_ATTACHMENT_MODEL_PROJECTOR,
    resolveAttachmentReadPaths: resolveEmptyAttachmentReadPaths,
    projectRoot: workspaceRoot,
    cwd: workspaceRoot,
    depth: input.runtimeDepth,
    projectContextResolver: createTestProjectContextResolver(input.storeManager),
    resolveVersionControl: async () => "git",
    resolveAllowedTools: (definition, depth) => resolveDefinitionAllowedTools(input.registry, definition, depth),
    delegationCapabilities: delegationCapabilities(input.definition, input.definitions, input.runtimeDepth),
    resolveMcpToolSnapshot: createMcpFixtureSnapshot,
    logger: silentLogger,
  });
}

function createMcpFixtureSnapshot(builtinServerNames: readonly BuiltinMcpServerName[]): AgentMcpToolSnapshot {
  const serverIds = [...builtinServerNames, USER_MCP_SERVER_ID];
  const tools = new Map<string, AgentMcpToolSnapshot["tools"] extends ReadonlyMap<string, infer Entry> ? Entry : never>();
  for (const serverId of serverIds) {
    for (let index = 0; index < MCP_TOOLS_PER_SERVER; index += 1) {
      const toolName = `measure_${index}`;
      const registryName = toMcpToolRegistryName(serverId, toolName);
      tools.set(registryName, {
        descriptor: mcpFixtureDescriptor(registryName, serverId, index),
        serverName: serverId,
        source: serverId === USER_MCP_SERVER_ID ? "user" : "builtin",
      });
    }
  }
  return {
    tools,
    statuses: {
      servers: Object.fromEntries(serverIds.map((serverId) => [
        serverId,
        { state: "ready" as const, toolCount: MCP_TOOLS_PER_SERVER, warningCount: 0, connectedAt: 1 },
      ])),
    },
  };
}

function mcpFixtureDescriptor(name: string, serverId: string, index: number): AnyToolDescriptor {
  return {
    name,
    description: `Credential-free measurement tool ${index + 1} from MCP server ${serverId}.`,
    inputSchema: z.object({}).catchall(z.unknown()),
    aiInputSchema: jsonSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Natural-language fixture query." },
        mode: {
          type: "string",
          enum: ["brief", "detailed"],
          description: "Fixture response detail.",
        },
      },
      required: ["query"],
    }),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    execute: () => ({ isError: false, draft: { kind: "text", text: "measurement fixture" } }),
  };
}

function localOnlyCatalog(catalog: ToolCatalog): ToolCatalog {
  return {
    digest: catalog.digest,
    entries: catalog.entries.filter((entry) => entry.sourceKind !== "mcp"),
  };
}

function entriesByNames(catalog: ToolCatalog, names: readonly string[]): readonly ToolCatalogEntry[] {
  const wanted = new Set(names);
  return catalog.entries.filter((entry) => wanted.has(entry.registryName));
}

function measureEntries(entries: readonly ToolCatalogEntry[]): TokenMetrics {
  const aiTools = new ResolvedToolSet(entries.map((entry) => entry.descriptor)).toAITools();
  const wire = entries.map((entry): OpenAICompatibleTool => {
    const tool = aiTools[entry.registryName];
    if (tool === undefined) throw new Error(`Production tool wire omitted ${entry.registryName}`);
    const parameters = toJsonSchema(tool.inputSchema);
    if (JSON.stringify(parameters) !== JSON.stringify(entry.aiJsonSchema)) {
      throw new Error(`Production tool wire schema diverged from catalog digest input for ${entry.registryName}`);
    }
    return {
      type: "function",
      function: { name: entry.registryName, description: tool.description, parameters },
    };
  });
  const skeleton = wire.map(() => ({
    type: "function" as const,
    function: { name: "", description: "", parameters: {} },
  }));
  return {
    count: wire.length,
    tokens: {
      full: countTokens(wire),
      names: countTokens(wire.map((tool) => tool.function.name)),
      descriptions: countTokens(wire.map((tool) => tool.function.description)),
      parameters: countTokens(wire.map((tool) => tool.function.parameters)),
      skeleton: countTokens(skeleton),
    },
  };
}

function measureDirectory(entries: readonly ToolCatalogEntry[]): DirectoryMetrics {
  const rendered = buildDeferredToolDirectory(entries) ?? "";
  return {
    toolCount: entries.length,
    characters: [...rendered].length,
    utf8Bytes: new TextEncoder().encode(rendered).byteLength,
    tokens: tokenizer.encode(rendered).length,
  };
}

function toJsonSchema(schema: unknown): unknown {
  if (typeof schema === "object" && schema !== null && "jsonSchema" in schema) {
    return (schema as { readonly jsonSchema: unknown }).jsonSchema;
  }
  return z.toJSONSchema(schema as z.ZodType);
}

function metricDelta(before: TokenMetrics, after: TokenMetrics): TokenMetrics {
  return {
    count: after.count - before.count,
    tokens: {
      full: after.tokens.full - before.tokens.full,
      names: after.tokens.names - before.tokens.names,
      descriptions: after.tokens.descriptions - before.tokens.descriptions,
      parameters: after.tokens.parameters - before.tokens.parameters,
      skeleton: after.tokens.skeleton - before.tokens.skeleton,
    },
  };
}

function requireDefinition(
  definitions: ReadonlyMap<AgentName, AgentDefinition>,
  name: AgentName,
): AgentDefinition {
  const definition = definitions.get(name);
  if (definition === undefined) throw new Error(`Missing Agent definition: ${name}`);
  return definition;
}

function countTokens(value: unknown): number {
  return tokenizer.encode(JSON.stringify(value)).length;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

console.log(JSON.stringify(await measureAllAgents(), null, 2));
