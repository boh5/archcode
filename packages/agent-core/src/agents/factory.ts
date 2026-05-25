import type { StoreApi } from "zustand";
import type { BackgroundTaskManager } from "../background/manager";
import { BackgroundTaskManager as DefaultBackgroundTaskManager } from "../background/manager";
import type { SpecraConfig } from "../config/schema";
import type { ProjectContextResolver } from "../projects/context-resolver";
import type { Registry as ProviderRegistry } from "../provider/index";
import { createSessionStore } from "../store/store";
import type { Reminder, ReminderSource, SessionStoreState } from "../store/types";
import type { SkillService } from "../skills";
import type { ResolvedSkill } from "../skills/types";
import type { ToolRegistry } from "../tools/index";
import { ConfiguredAgent } from "./configured-agent";
import {
  AgentChildPolicyMissingError,
  ConcurrentLimitError,
  DelegateTargetNotAllowedError,
  DelegationToolNotAllowedError,
  DepthLimitError,
  NoModelsConfiguredError,
  SubAgentError,
} from "./errors";
import type { AgentDefinition, AgentName, AgentRunHandle, DelegateAgentOptions } from "./factory-types";
import { DELEGATION_TOOLS, MAX_SUB_AGENT_DEPTH } from "./constants";
import type { Agent } from "./types";
import { resolveAgentModel } from "./model-resolver";

export type { AgentRunHandle, DelegateAgentOptions } from "./factory-types";

export interface AgentFactoryConfig {
  readonly definitions: readonly AgentDefinition[];
  readonly providerRegistry: ProviderRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly skillService: SkillService;
  readonly workspaceRoot: string;
  readonly config?: SpecraConfig;
  readonly backgroundTaskManager?: BackgroundTaskManager;
  readonly projectContextResolver?: ProjectContextResolver;
}

export interface CreateAgentOptions {
  readonly store?: StoreApi<SessionStoreState>;
  readonly depth?: number;
  readonly parentSessionId?: string;
  readonly title?: string;
  readonly abortSignal?: AbortSignal;
  readonly activeSkills?: readonly ResolvedSkill[];
}

export interface AgentFactory {
  createRootAgent(name: AgentName, options?: CreateAgentOptions): Agent;
  createAgent(name: AgentName, options?: CreateAgentOptions): Agent;
  delegate(options: DelegateAgentOptions): AgentRunHandle;
  getDefinition(name: string): AgentDefinition;
  listAgentNames(): string[];
  resolveAllowedTools(definition: AgentDefinition, depth: number): string[];
  getDelegateTargetsFor(definition: AgentDefinition, depth: number): string[];
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
  const activeChildrenByParent = new Map<string, Set<string>>();
  const sharedBackgroundTaskManager = config.backgroundTaskManager ?? new DefaultBackgroundTaskManager();
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
      return createConfiguredAgent(rootConfig, factory, factory.getDefinition(name), options);
    },

    createAgent(name, options = {}) {
      return createConfiguredAgent(agentConfig, factory, factory.getDefinition(name), options);
    },

    delegate(options) {
      const currentDepth = options.currentDepth ?? 0;
      const parentDefinition = factory.getDefinition(options.parentAgentName);
      const allowedTools = factory.resolveAllowedTools(parentDefinition, currentDepth);

      if (!allowedTools.includes("delegate")) {
        throw new DelegationToolNotAllowedError(options.parentAgentName, currentDepth);
      }

      const delegateTargets = factory.getDelegateTargetsFor(parentDefinition, currentDepth);
      if (!delegateTargets.includes(options.targetAgentName)) {
        throw new DelegateTargetNotAllowedError(options.parentAgentName, options.targetAgentName, currentDepth);
      }

      const targetDefinition = factory.getDefinition(options.targetAgentName);
      const childPolicy = parentDefinition.childPolicy;
      if (childPolicy === undefined) {
        throw new AgentChildPolicyMissingError(options.parentAgentName);
      }

      if (currentDepth >= childPolicy.maxDepth) {
        throw new DepthLimitError(currentDepth);
      }

      const parentSessionId = options.parentStore.getState().sessionId;
      const activeChildren = activeChildrenByParent.get(parentSessionId) ?? new Set<string>();
      if (activeChildren.size >= childPolicy.maxConcurrent) {
        throw new ConcurrentLimitError(activeChildren.size);
      }

      const childSessionId = crypto.randomUUID();
      const childStore = createSessionStore(childSessionId);
      const childTitle = options.title ?? options.description;
      childStore.setState({
        parentSessionId,
        ...(childTitle !== undefined ? { title: childTitle } : {}),
      });

      options.parentStore.setState((state) => {
        const childSessionIds = new Set(state.childSessionIds);
        childSessionIds.add(childSessionId);

        const subAgentDescriptions = new Map(state.subAgentDescriptions);
        if (options.description !== undefined) {
          subAgentDescriptions.set(childSessionId, options.description);
        }

        return { childSessionIds, subAgentDescriptions };
      });

      const childAbortController = new AbortController();
      const timeout = childPolicy.timeoutMs > 0
        ? setTimeout(() => childAbortController.abort(new Error("Sub-agent timed out")), childPolicy.timeoutMs)
        : undefined;
      const removeParentAbort = childPolicy.abortCascade
        ? wireAbortCascade(options.parentAbort, childAbortController)
        : () => {};

      const childAgent = factory.createAgent(targetDefinition.name, {
        store: childStore,
        depth: currentDepth + 1,
        parentSessionId,
        ...(childTitle !== undefined ? { title: childTitle } : {}),
        abortSignal: childAbortController.signal,
        activeSkills: undefined,
      });

      activeChildren.add(childSessionId);
      activeChildrenByParent.set(parentSessionId, activeChildren);

      const result = runWithAbort(childAgent.run(options.prompt, { abort: childAbortController.signal }), childAbortController.signal)
        .catch((error: unknown) => {
          if (error instanceof SubAgentError) throw error;
          throw new SubAgentError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (timeout !== undefined) clearTimeout(timeout);
          removeParentAbort();
          activeChildren.delete(childSessionId);
          if (activeChildren.size === 0) {
            activeChildrenByParent.delete(parentSessionId);
          }
        });

      if (options.background === true && childPolicy.terminalReminders) {
        result.then(
          () => appendTerminalReminder(options.parentStore, childSessionId, "completed"),
          (error) => appendTerminalReminder(options.parentStore, childSessionId, classifyTerminalStatus(error, childAbortController.signal)),
        );
      }

      return {
        sessionId: childSessionId,
        store: childStore,
        result,
        abort: () => childAbortController.abort(new Error("Sub-agent aborted")),
      };
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
  };

  return factory;
}

type SubAgentTerminalStatus = "completed" | "failed" | "timed_out" | "cancelled";

function runWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReasonToError(signal.reason));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReasonToError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReasonToError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (reason !== undefined) return new Error(String(reason));
  return new Error("Sub-agent aborted");
}

function wireAbortCascade(parentAbort: AbortSignal | undefined, childController: AbortController): () => void {
  if (parentAbort === undefined) return () => {};
  const onAbort = () => childController.abort(parentAbort.reason);
  if (parentAbort.aborted) {
    onAbort();
    return () => {};
  }
  parentAbort.addEventListener("abort", onAbort, { once: true });
  return () => parentAbort.removeEventListener("abort", onAbort);
}

function appendTerminalReminder(
  parentStore: StoreApi<SessionStoreState>,
  sessionId: string,
  status: SubAgentTerminalStatus,
): void {
  const reminder: Reminder = {
    id: crypto.randomUUID(),
    source: terminalSource(status, sessionId),
    delivery: "on_demand",
    sessionId,
    terminalState: status,
    content: `Sub-agent ${sessionId} ${formatStatus(status)}. Use background_output with this session_id to read the result.`,
    createdAt: Date.now(),
    consumedAt: null,
    targetSessionId: parentStore.getState().sessionId,
  };
  parentStore.getState().append({ type: "reminder", reminder });
}

function classifyTerminalStatus(error: unknown, signal: AbortSignal): SubAgentTerminalStatus {
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error && /timed out/i.test(reason.message)) return "timed_out";
    return "cancelled";
  }
  if (error instanceof Error && /timed out/i.test(error.message)) return "timed_out";
  return "failed";
}

function terminalSource(status: SubAgentTerminalStatus, sessionId: string): ReminderSource {
  if (status === "completed") return { type: "subagent_completed", sessionId };
  if (status === "timed_out") return { type: "subagent_timed_out", sessionId };
  if (status === "cancelled") return { type: "subagent_cancelled", sessionId };
  return { type: "subagent_failed", sessionId };
}

function formatStatus(status: SubAgentTerminalStatus): string {
  if (status === "timed_out") return "timed out";
  return status;
}

function createConfiguredAgent(
  config: AgentFactoryConfig,
  factory: AgentFactory,
  definition: AgentDefinition,
  options: CreateAgentOptions,
): Agent {
  const store = prepareStore(options);
  if (config.providerRegistry.modelIds.length === 0) {
    throw new NoModelsConfiguredError();
  }

  const resolvedConfig = config.config ?? ({ provider: {} } as SpecraConfig);
  const { modelInfo, options: modelOptions } = resolveAgentModel(definition.name, resolvedConfig, config.providerRegistry);

  return new ConfiguredAgent({
    definition,
    providerRegistry: config.providerRegistry,
    modelInfo,
    modelOptions,
    toolRegistry: config.toolRegistry,
    skillService: config.skillService,
    workspaceRoot: config.workspaceRoot,
    store,
    depth: options.depth,
    backgroundTaskManager: config.backgroundTaskManager,
    memoryConfig: resolvedConfig.memory,
    projectContextResolver: config.projectContextResolver,
    resolveAllowedTools: (agentDefinition, depth) => factoryResolveAllowedTools(config, agentDefinition, depth),
    agentFactory: factory,
    activeSkills: options.activeSkills,
  });
}

function factoryResolveAllowedTools(
  config: AgentFactoryConfig,
  definition: AgentDefinition,
  depth: number,
): string[] {
  const resolved = config.toolRegistry.resolveForAgent(definition.tools.tools).descriptors.map((tool) => tool.name);

  if (depth >= MAX_SUB_AGENT_DEPTH) {
    return resolved.filter((name) => !(DELEGATION_TOOLS as readonly string[]).includes(name));
  }

  return resolved;
}

function prepareStore(options: CreateAgentOptions): StoreApi<SessionStoreState> {
  const store = options.store ?? createSessionStore(crypto.randomUUID());

  const state: Partial<SessionStoreState> = {};
  if (options.parentSessionId !== undefined) {
    state.parentSessionId = options.parentSessionId;
  }
  if (options.title !== undefined) {
    state.title = options.title;
  }
  if (Object.keys(state).length > 0) {
    store.setState(state);
  }

  return store;
}
