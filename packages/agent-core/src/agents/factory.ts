import type { BackgroundTaskManager } from "../background/manager";
import { BackgroundTaskManager as DefaultBackgroundTaskManager } from "../background/manager";
import type { ProjectContextResolver } from "../projects/context-resolver";
import type { AgentTreeProjection, BuiltinMcpServerName } from "@archcode/protocol";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import type { Logger } from "../logger";
import { RESERVED_BUILTIN_SKILL_NAMES, SkillNotFoundError, type SkillService } from "../skills";
import { assertSkillName } from "../skills/schema";
import type { ToolRegistry } from "../tools/index";
import { ConfiguredAgent } from "./configured-agent";
import { SkillNotAllowedError } from "./errors";
import type { StoreApi } from "zustand";
import type {
  CancelDescendantSession,
  ChildExecutionHandle,
  ChildExecutionRequest,
  ResumeChildRequest,
  SendMessageToChild,
} from "../delegation/types";
import type {
  AgentDefinition,
  AgentMcpToolSnapshot,
  AgentName,
  DelegationCapabilitySnapshot,
  DelegationTargetCapability,
} from "./factory-types";
import { DELEGATION_CONTROL_TOOLS } from "./constants";
import type { Agent } from "./types";
import { detectVersionControl, type VersionControlDetector } from "../version-control/detector";
import type { ToolOutputAccessService } from "../tool-output/access-service";
import type { SessionGoalService } from "../session-goal";
import type { AttachmentModelProjector } from "../attachments";

export type { ChildExecutionHandle, ChildExecutionRequest } from "./factory-types";

export interface AgentFactoryConfig {
  readonly definitions: readonly AgentDefinition[];
  readonly toolRegistry: ToolRegistry;
  readonly skillService: SkillService;
  readonly storeManager: SessionStoreManager;
  readonly createToolOutputAccess: (workspaceRoot: string, rootSessionId: string) => ToolOutputAccessService;
  readonly attachmentProjector: AttachmentModelProjector;
  readonly resolveAttachmentReadPaths: (
    workspaceRoot: string,
    rootSessionId: string,
  ) => Promise<ReadonlySet<string>>;
  readonly workspaceRoot: string;
  readonly backgroundTaskManager?: BackgroundTaskManager;
  readonly projectContextResolver: ProjectContextResolver;
  readonly sessionGoalService?: SessionGoalService;
  readonly versionControlDetector?: VersionControlDetector;
  readonly startChildExecution?: (request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  readonly cancelDescendantSession?: CancelDescendantSession;
  readonly sendMessageToChild?: SendMessageToChild;
  readonly resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  readonly getAgentTreeProjection?: (workspaceRoot: string, rootSessionId: string) => Promise<AgentTreeProjection>;
  readonly acquireSessionCwdTransition?: (workspaceRoot: string, sessionId: string) => () => void;
  readonly resolveMcpToolSnapshot?: (
    builtinServerNames: readonly BuiltinMcpServerName[],
  ) => AgentMcpToolSnapshot;
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
  resolveDelegationCapabilities(parentAgentName: AgentName, depth: number): DelegationCapabilitySnapshot;
  resolveDelegatedSkillNames(target: DelegationTargetCapability, requestedSkills: readonly string[], cwd: string): Promise<readonly string[]>;
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
      const definition = factory.getDefinition(name);
      const store = options.store ?? rootConfig.storeManager.create(crypto.randomUUID(), rootConfig.workspaceRoot, {
        agentName: definition.name,
        source: { kind: "direct" },
      });
      return createConfiguredAgent(
        rootConfig,
        definition,
        { ...options, store },
        factory.resolveDelegationCapabilities,
      );
    },

    createAgent(name, options = {}) {
      return createConfiguredAgent(
        agentConfig,
        factory.getDefinition(name),
        options,
        factory.resolveDelegationCapabilities,
      );
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

    resolveDelegationCapabilities(parentAgentName, depth) {
      const definition = factory.getDefinition(parentAgentName);
      const allowedTools = factory.resolveAllowedTools(definition, depth);
      if (!allowedTools.includes("delegate")) {
        return freezeDelegationCapabilities(parentAgentName, depth, []);
      }

      const targets = (definition.tools.delegateTargets ?? []).map((agentName) => {
        const target = factory.getDefinition(agentName);
        return {
          agentName: target.name,
          profiles: target.profiles,
          builtinSkillNames: target.skills,
        };
      });
      return freezeDelegationCapabilities(parentAgentName, depth, targets);
    },

    resolveDelegatedSkillNames(target, requestedSkills, cwd) {
      return resolveDelegatedSkillNames(agentConfig.skillService, cwd, target, requestedSkills);
    },
  };

  return factory;
}

async function resolveDelegatedSkillNames(
  skillService: SkillService,
  workspaceRoot: string,
  target: DelegationTargetCapability,
  requestedSkills: readonly string[],
): Promise<readonly string[]> {
  const dedupedNames: string[] = [];
  const seen = new Set<string>();

  for (const skillName of requestedSkills) {
    assertSkillName(skillName);
    if (RESERVED_BUILTIN_SKILL_NAMES.has(skillName) && !target.builtinSkillNames.includes(skillName)) {
      throw new SkillNotAllowedError(target.agentName, skillName, target.builtinSkillNames);
    }
    if (seen.has(skillName)) continue;
    seen.add(skillName);
    dedupedNames.push(skillName);
  }

  for (const skillName of dedupedNames) {
    const skill = await skillService.discoverForAgent(workspaceRoot, skillName, target.builtinSkillNames);
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
  resolveDelegationCapabilities: AgentFactory["resolveDelegationCapabilities"],
): Agent {
  const store = prepareStore(config, definition, options);
  const delegationCapabilities = resolveDelegationCapabilities(definition.name, options.depth ?? 0);

  return new ConfiguredAgent({
    definition,
    toolRegistry: config.toolRegistry,
    skillService: config.skillService,
    storeManager: config.storeManager,
    toolOutputAccess: config.createToolOutputAccess(
      config.workspaceRoot,
      store.getState().rootSessionId,
    ),
    attachmentProjector: config.attachmentProjector,
    resolveAttachmentReadPaths: config.resolveAttachmentReadPaths,
    projectRoot: config.workspaceRoot,
    cwd: store.getState().cwd,
    store,
    depth: options.depth,
    backgroundTaskManager: config.backgroundTaskManager,
    projectContextResolver: config.projectContextResolver,
    ...(config.sessionGoalService === undefined ? {} : { sessionGoalService: config.sessionGoalService }),
    resolveVersionControl: config.versionControlDetector ?? detectVersionControl,
    logger: config.logger,
    delegationCapabilities,
    resolveAllowedTools: (agentDefinition, depth) => factoryResolveAllowedTools(config, agentDefinition, depth),
    startChildExecution: config.startChildExecution,
    cancelDescendantSession: config.cancelDescendantSession,
    sendMessageToChild: config.sendMessageToChild,
    resumeChildSession: config.resumeChildSession,
    getAgentTreeProjection: config.getAgentTreeProjection,
    acquireSessionCwdTransition: config.acquireSessionCwdTransition,
    resolveMcpToolSnapshot: config.resolveMcpToolSnapshot,
  });
}

function factoryResolveAllowedTools(
  config: AgentFactoryConfig,
  definition: AgentDefinition,
  depth: number,
): string[] {
  const all = config.toolRegistry.resolveForAgent(definition.tools.tools).descriptors.map((tool) => tool.name);

  if (
    definition.childPolicy === undefined
    || (definition.tools.delegateTargets?.length ?? 0) === 0
    || depth >= definition.childPolicy.maxDepth
  ) {
    return all.filter((name) => !(DELEGATION_CONTROL_TOOLS as readonly string[]).includes(name));
  }

  return all;
}

function freezeDelegationCapabilities(
  parentAgentName: AgentName,
  depth: number,
  targets: readonly DelegationTargetCapability[],
): DelegationCapabilitySnapshot {
  const frozenTargets = targets.map((target) => Object.freeze({
    agentName: target.agentName,
    profiles: Object.freeze([...target.profiles]),
    builtinSkillNames: Object.freeze([...target.builtinSkillNames]),
  }));
  return Object.freeze({
    parentAgentName,
    depth,
    targets: Object.freeze(frozenTargets),
  });
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
