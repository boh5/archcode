import type { BackgroundTaskManager } from "../background/manager";
import { BackgroundTaskManager as DefaultBackgroundTaskManager } from "../background/manager";
import type { MemoryExtractionConfig } from "../config/schema";
import type { ProjectContextResolver } from "../projects/context-resolver";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import type { Logger } from "../logger";
import { SkillNotFoundError, type SkillService } from "../skills";
import { assertSkillName } from "../skills/schema";
import type { ToolRegistry } from "../tools/index";
import { sanitizeMcpServerNameForRegistry } from "../mcp/naming";
import { ConfiguredAgent } from "./configured-agent";
import { SkillNotAllowedError } from "./errors";
import type { StoreApi } from "zustand";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";
import type { AgentDefinition, AgentName } from "./factory-types";
import { DELEGATION_CORE_TOOLS, MAX_SUB_AGENT_DEPTH } from "./constants";
import type { Agent } from "./types";
import { detectVersionControl, type VersionControlDetector } from "../version-control/detector";
import type { ToolOutputAccessService } from "../tool-output/access-service";

export type { ChildExecutionHandle, ChildExecutionRequest } from "./factory-types";

export interface AgentFactoryConfig {
  readonly definitions: readonly AgentDefinition[];
  readonly toolRegistry: ToolRegistry;
  readonly skillService: SkillService;
  readonly storeManager: SessionStoreManager;
  readonly createToolOutputAccess: (workspaceRoot: string, rootSessionId: string) => ToolOutputAccessService;
  readonly workspaceRoot: string;
  readonly memoryConfig?: MemoryExtractionConfig;
  readonly backgroundTaskManager?: BackgroundTaskManager;
  readonly projectContextResolver: ProjectContextResolver;
  readonly versionControlDetector?: VersionControlDetector;
  readonly startChildExecution?: (request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  readonly cancelChildSession?: (workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean;
  readonly resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  readonly acquireSessionCwdTransition?: (workspaceRoot: string, sessionId: string) => () => void;
  readonly logger: Logger;
}

export interface CreateAgentOptions {
  readonly store?: StoreApi<SessionStoreState>;
  readonly depth?: number;
}

export interface AgentFactory {
  createRootAgent(name: AgentName, options?: CreateAgentOptions): Agent;
  createAgent(name: AgentName, options?: CreateAgentOptions): Agent;
  getDefinition(name: string): AgentDefinition;
  listAgentNames(): string[];
  resolveAllowedTools(definition: AgentDefinition, depth: number): string[];
  getDelegateTargetsFor(definition: AgentDefinition, depth: number): string[];
  resolveDelegatedSkillNames(targetDefinition: AgentDefinition, requestedSkills: readonly string[], cwd: string): Promise<readonly string[]>;
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

export class AgentStoreIdentityMismatchError extends Error {
  constructor(
    public readonly expectedAgentName: AgentName,
    public readonly actualAgentName: AgentName,
  ) {
    super(`Agent definition "${expectedAgentName}" does not match Session identity "${actualAgentName}"`);
    this.name = "AgentStoreIdentityMismatchError";
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

    resolveDelegatedSkillNames(targetDefinition, requestedSkills, cwd) {
      return resolveDelegatedSkillNames(agentConfig.skillService, cwd, targetDefinition, requestedSkills);
    },
  };

  return factory;
}

async function resolveDelegatedSkillNames(
  skillService: SkillService,
  workspaceRoot: string,
  targetDefinition: AgentDefinition,
  requestedSkills: readonly string[],
): Promise<readonly string[]> {
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

  for (const skillName of dedupedNames) {
    const skill = await skillService.readForAgent(workspaceRoot, skillName, targetDefinition.skills);
    if (skill === null) {
      throw new SkillNotFoundError(skillName);
    }
  }

  return dedupedNames;
}

function createConfiguredAgent(
  config: AgentFactoryConfig,
  definition: AgentDefinition,
  options: CreateAgentOptions,
): Agent {
  const store = prepareStore(config, definition, options);

  return new ConfiguredAgent({
    definition,
    toolRegistry: config.toolRegistry,
    skillService: config.skillService,
    storeManager: config.storeManager,
    toolOutputAccess: config.createToolOutputAccess(
      config.workspaceRoot,
      store.getState().rootSessionId,
    ),
    projectRoot: config.workspaceRoot,
    cwd: store.getState().cwd,
    store,
    depth: options.depth,
    backgroundTaskManager: config.backgroundTaskManager,
    memoryConfig: config.memoryConfig,
    projectContextResolver: config.projectContextResolver,
    resolveVersionControl: config.versionControlDetector ?? detectVersionControl,
    logger: config.logger,
    resolveAllowedTools: (agentDefinition, depth) => factoryResolveAllowedTools(config, agentDefinition, depth),
    startChildExecution: config.startChildExecution,
    cancelChildSession: config.cancelChildSession,
    resumeChildSession: config.resumeChildSession,
    acquireSessionCwdTransition: config.acquireSessionCwdTransition,
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
    return all.filter((name) => !(DELEGATION_CORE_TOOLS as readonly string[]).includes(name));
  }

  return all;
}

function prepareStore(config: AgentFactoryConfig, definition: AgentDefinition, options: CreateAgentOptions): StoreApi<SessionStoreState> {
  const store = options.store ?? config.storeManager.create(crypto.randomUUID(), config.workspaceRoot, {
    agentName: definition.name,
  });
  if (store.getState().agentName !== definition.name) {
    throw new AgentStoreIdentityMismatchError(definition.name, store.getState().agentName);
  }

  return store;
}
