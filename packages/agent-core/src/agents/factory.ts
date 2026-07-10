import type { BackgroundTaskManager } from "../background/manager";
import { BackgroundTaskManager as DefaultBackgroundTaskManager } from "../background/manager";
import type { ArchCodeConfig } from "../config/schema";
import type { ProjectContextResolver } from "../projects/context-resolver";
import type { ProviderRegistry } from "../provider/index";
import type { ModelInfo } from "../provider/model";
import type { SessionModelInfo } from "@archcode/protocol";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import type { Logger } from "../logger";
import { SkillNotFoundError, type SkillService } from "../skills";
import { assertSkillName } from "../skills/schema";
import type { ResolvedSkill } from "../skills/types";
import type { ToolRegistry } from "../tools/index";
import { sanitizeMcpServerNameForRegistry } from "../mcp/naming";
import { ConfiguredAgent } from "./configured-agent";
import {
  NoModelsConfiguredError,
  SkillNotAllowedError,
} from "./errors";
import type { StoreApi } from "zustand";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";
import type { AgentDefinition, AgentName } from "./factory-types";
import { DELEGATION_TOOLS, MAX_SUB_AGENT_DEPTH } from "./constants";
import type { Agent } from "./types";
import { resolveAgentModel } from "./model-resolver";

export type { ChildExecutionHandle, ChildExecutionRequest } from "./factory-types";

export interface AgentFactoryConfig {
  readonly definitions: readonly AgentDefinition[];
  readonly providerRegistry: ProviderRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly skillService: SkillService;
  readonly storeManager: SessionStoreManager;
  readonly workspaceRoot: string;
  readonly config?: ArchCodeConfig;
  readonly backgroundTaskManager?: BackgroundTaskManager;
  readonly projectContextResolver?: ProjectContextResolver;
  readonly startChildExecution?: (request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  readonly cancelChildSession?: (workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean;
  readonly resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  readonly abortSessionExecutionAndWait?: (workspaceRoot: string, sessionId: string) => Promise<void>;
  readonly acquireSessionCwdTransition?: (workspaceRoot: string, sessionId: string) => () => void;
  readonly logger: Logger;
}

export interface CreateAgentOptions {
  readonly store?: StoreApi<SessionStoreState>;
  readonly cwd?: string;
  readonly depth?: number;
  readonly parentSessionId?: string;
  readonly title?: string;
  readonly abortSignal?: AbortSignal;
  readonly activeSkills?: readonly ResolvedSkill[];
}

export interface AgentFactory {
  createRootAgent(name: AgentName, options?: CreateAgentOptions): Agent;
  createAgent(name: AgentName, options?: CreateAgentOptions): Agent;
  getDefinition(name: string): AgentDefinition;
  listAgentNames(): string[];
  resolveAllowedTools(definition: AgentDefinition, depth: number): string[];
  getDelegateTargetsFor(definition: AgentDefinition, depth: number): string[];
  resolveDelegatedSkills(targetDefinition: AgentDefinition, requestedSkills: readonly string[], cwd?: string): Promise<readonly ResolvedSkill[]>;
}

export class DuplicateAgentDefinitionError extends Error {
  constructor(public readonly definitionName: string) {
    super(`Duplicate agent definition: ${definitionName}`);
    this.name = "DuplicateAgentDefinitionError";
  }
}

export class UnknownAgentDefinitionError extends Error {
  constructor(public readonly agentName: string) {
    super(`Unknown agent definition: ${agentName}`);
    this.name = "UnknownAgentDefinitionError";
  }
}

export function createAgentFactory(config: AgentFactoryConfig): AgentFactory {
  const definitions = new Map<string, AgentDefinition>();
  const sharedBackgroundTaskManager = config.backgroundTaskManager ?? new DefaultBackgroundTaskManager({ logger: config.logger });
  const agentConfig = { ...config, backgroundTaskManager: sharedBackgroundTaskManager };

  for (const definition of config.definitions) {
    if (definitions.has(definition.name)) {
      throw new DuplicateAgentDefinitionError(definition.name);
    }
    definitions.set(definition.name, definition);
  }

  const factory: AgentFactory = {
    createRootAgent(name, options = {}) {
      const rootConfig = { ...agentConfig, backgroundTaskManager: undefined };
      return createConfiguredAgent(rootConfig, factory.getDefinition(name), options);
    },

    createAgent(name, options = {}) {
      return createConfiguredAgent(agentConfig, factory.getDefinition(name), options);
    },

    getDefinition(name) {
      const definition = definitions.get(name);
      if (definition === undefined) {
        throw new UnknownAgentDefinitionError(name);
      }
      return definition;
    },

    listAgentNames() {
      return Array.from(definitions.keys());
    },

    resolveAllowedTools(definition, depth) {
      return factoryResolveAllowedTools(config, definition, depth);
    },

    getDelegateTargetsFor(definition, depth) {
      const allowedTools = factory.resolveAllowedTools(definition, depth);
      if (!allowedTools.includes("delegate")) {
        return [];
      }

      return [...(definition.tools.delegateTargets ?? [])];
    },

    resolveDelegatedSkills(targetDefinition, requestedSkills, cwd) {
      return resolveDelegatedSkills(agentConfig.skillService, cwd ?? agentConfig.workspaceRoot, targetDefinition, requestedSkills);
    },
  };

  return factory;
}

async function resolveDelegatedSkills(
  skillService: SkillService,
  workspaceRoot: string,
  targetDefinition: AgentDefinition,
  requestedSkills: readonly string[],
): Promise<readonly ResolvedSkill[]> {
  const dedupedNames: string[] = [];
  const seen = new Set<string>();

  for (const skillName of requestedSkills) {
    assertSkillName(skillName);
    if (!targetDefinition.skills.includes(skillName)) {
      throw new SkillNotAllowedError(targetDefinition.name, skillName, targetDefinition.skills);
    }
    if (seen.has(skillName)) continue;
    seen.add(skillName);
    dedupedNames.push(skillName);
  }

  const resolvedSkills: ResolvedSkill[] = [];
  for (const skillName of dedupedNames) {
    const skill = await skillService.readForAgent(workspaceRoot, skillName, targetDefinition.skills);
    if (skill === null) {
      throw new SkillNotFoundError(skillName);
    }
    resolvedSkills.push(skill);
  }

  return resolvedSkills;
}

function createConfiguredAgent(
  config: AgentFactoryConfig,
  definition: AgentDefinition,
  options: CreateAgentOptions,
): Agent {
  const store = prepareStore(config, definition, options);
  if (config.providerRegistry.modelIds.length === 0) {
    throw new NoModelsConfiguredError();
  }

  const resolvedConfig = config.config ?? ({ provider: {} } as ArchCodeConfig);
  const { modelInfo, options: modelOptions } = resolveAgentModel(definition.name, resolvedConfig, config.providerRegistry);

  store.setState({ modelInfo: toSessionModelInfo(modelInfo) });

  return new ConfiguredAgent({
    definition,
    providerRegistry: config.providerRegistry,
    modelInfo,
    modelOptions,
    toolRegistry: config.toolRegistry,
    skillService: config.skillService,
    storeManager: config.storeManager,
    projectRoot: config.workspaceRoot,
    cwd: options.cwd ?? store.getState().cwd ?? config.workspaceRoot,
    store,
    depth: options.depth,
    backgroundTaskManager: config.backgroundTaskManager,
    memoryConfig: resolvedConfig.memory,
    projectContextResolver: config.projectContextResolver,
    logger: config.logger,
    resolveAllowedTools: (agentDefinition, depth) => factoryResolveAllowedTools(config, agentDefinition, depth),
    startChildExecution: config.startChildExecution,
    cancelChildSession: config.cancelChildSession,
    resumeChildSession: config.resumeChildSession,
    abortSessionExecutionAndWait: config.abortSessionExecutionAndWait,
    acquireSessionCwdTransition: config.acquireSessionCwdTransition,
    activeSkills: options.activeSkills,
  });
}

function factoryResolveAllowedTools(
  config: AgentFactoryConfig,
  definition: AgentDefinition,
  depth: number,
): string[] {
  const resolved = config.toolRegistry.resolveForAgent(definition.tools.tools).descriptors.map((tool) => tool.name);

  // Merge MCP tools for each server listed in definition.mcpTools.
  // Server names are sanitized to match the registry name generation
  // (dots and other unsafe chars become `_`), so "grep.app" → prefix "mcp__grep_app__".
  const mcpToolNames: string[] = [];
  if (definition.mcpTools) {
    for (const serverName of definition.mcpTools) {
      const prefix = `mcp__${sanitizeMcpServerNameForRegistry(serverName)}__`;
      const tools = config.toolRegistry.listByPrefix(prefix);
      mcpToolNames.push(...tools.map((t) => t.name));
    }
  }

  const all = [...resolved, ...mcpToolNames];

  if (depth >= MAX_SUB_AGENT_DEPTH) {
    return all.filter((name) => !(DELEGATION_TOOLS as readonly string[]).includes(name));
  }

  return all;
}

function prepareStore(config: AgentFactoryConfig, definition: AgentDefinition, options: CreateAgentOptions): StoreApi<SessionStoreState> {
  const store = options.store ?? config.storeManager.create(crypto.randomUUID(), config.workspaceRoot, {
    cwd: options.cwd ?? config.workspaceRoot,
    agentName: definition.name,
  });

  const state: Partial<SessionStoreState> = { agentName: definition.name };
  if (options.title !== undefined) {
    state.title = options.title;
  }
  if (Object.keys(state).length > 0) {
    store.setState(state);
  }

  return store;
}

function toSessionModelInfo(modelInfo: ModelInfo): SessionModelInfo {
  return {
    displayName: modelInfo.displayName,
    modelId: modelInfo.modelId,
    providerId: modelInfo.providerId,
    qualifiedId: modelInfo.qualifiedId,
  };
}
