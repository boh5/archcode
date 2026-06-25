import type { ArchCodeConfig } from "../config/index";
import type { ProjectContextResolver } from "../projects/context-resolver";
import type { Registry as ProviderRegistry } from "../provider/index";
import { SessionStoreManager } from "../store/session-store-manager";
import { scopedKey } from "../store/key";
import type { SessionStoreState } from "../store/types";
import type { ToolRegistry } from "../tools/index";
import type { SkillService } from "../skills";
import type { ResolvedSkill } from "../skills/types";
import type { StoreApi } from "zustand";
import { ConcurrentSessionLimitError } from "./errors";
import { createAgentFactory } from "./factory";
import type { AgentFactory } from "./factory";
import type { AgentDefinition } from "./factory-types";
import type { Agent } from "./types";
import type { CommandResult } from "../commands/types";
import type { Logger } from "../logger";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";

export interface SessionAgentManagerConfig {
  readonly definitions: readonly AgentDefinition[];
  readonly providerRegistry: ProviderRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly skillService: SkillService;
  readonly config?: ArchCodeConfig;
  readonly projectContextResolver?: ProjectContextResolver;
  readonly maxConcurrentSessions?: number;
  readonly tombstoneTtlMs?: number;
  readonly storeManager: SessionStoreManager;
  readonly startChildExecution?: (workspaceRoot: string, request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  readonly cancelChildSession?: (workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean;
  readonly resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  readonly logger: Logger;
}

const DEFAULT_TOMBSTONE_TTL_MS = 300000;

export class SessionAgentManager {
  #agents = new Map<string, Agent>();
  #pendingAgents = new Map<string, Promise<Agent>>();
  #factories = new Map<string, AgentFactory>();
  #tombstones = new Map<string, number>();
  #activeJobsByWorkspace = new Map<string, Set<string>>();
  #config: SessionAgentManagerConfig;
  readonly maxConcurrentSessions: number;
  readonly tombstoneTtlMs: number;
  readonly #storeManager: SessionStoreManager;
  readonly #logger: Logger;
  #startChildExecution: SessionAgentManagerConfig["startChildExecution"];
  #cancelChildSession: SessionAgentManagerConfig["cancelChildSession"];
  #resumeChildSession: SessionAgentManagerConfig["resumeChildSession"];

  constructor(config: SessionAgentManagerConfig) {
    this.#config = config;
    this.#storeManager = config.storeManager;
    this.#logger = config.logger;
    this.#startChildExecution = config.startChildExecution;
    this.#cancelChildSession = config.cancelChildSession;
    this.#resumeChildSession = config.resumeChildSession;
    this.maxConcurrentSessions = config.maxConcurrentSessions ?? 4;
    this.tombstoneTtlMs = config.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
  }

  setStartChildExecution(callback: SessionAgentManagerConfig["startChildExecution"]): void {
    this.#startChildExecution = callback;
  }

  setCancelChildSession(callback: SessionAgentManagerConfig["cancelChildSession"]): void {
    this.#cancelChildSession = callback;
  }

  setResumeChildSession(callback: SessionAgentManagerConfig["resumeChildSession"]): void {
    this.#resumeChildSession = callback;
  }

  async getOrCreate(workspaceRoot: string, sessionId: string): Promise<Agent> {
    const key = scopedKey(workspaceRoot, sessionId);
    if (this.#isTombstonedKey(key)) {
      throw new Error(`Session "${sessionId}" in workspace "${workspaceRoot}" has been deleted`);
    }

    const existing = this.#agents.get(key);
    if (existing) return existing;

    const pending = this.#pendingAgents.get(key);
    if (pending) return pending;

    const promise = this.#createAndRegisterAgent(workspaceRoot, sessionId, key);
    this.#pendingAgents.set(key, promise);
    return promise;
  }

  async #createAndRegisterAgent(workspaceRoot: string, sessionId: string, key: string): Promise<Agent> {
    try {
      const agent = await this.#createAgent(workspaceRoot, sessionId);
      if (this.#isTombstonedKey(key)) {
        agent.dispose();
        throw new Error(`Session "${sessionId}" in workspace "${workspaceRoot}" has been deleted`);
      }

      this.#agents.set(key, agent);
      return agent;
    } finally {
      this.#pendingAgents.delete(key);
    }
  }

  async #createAgent(workspaceRoot: string, sessionId: string): Promise<Agent> {
    const factory = this.getFactory(workspaceRoot);
    let store: StoreApi<SessionStoreState>;
    try {
      store = await this.#storeManager.getOrLoad(sessionId, workspaceRoot);
    } catch {
      store = this.#storeManager.create(sessionId, workspaceRoot);
    }
    return factory.createRootAgent("orchestrator", { store });
  }

  createChildAgent(input: {
    workspaceRoot: string;
    sessionId: string;
    agentName: string;
    store: StoreApi<SessionStoreState>;
    depth: number;
    parentSessionId: string;
    title?: string;
    activeSkills?: readonly ResolvedSkill[];
  }): Agent {
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    const existing = this.#agents.get(key);
    if (existing) return existing;

    const factory = this.getFactory(input.workspaceRoot);
    const agent = factory.createAgent(input.agentName, {
      store: input.store,
      depth: input.depth,
      parentSessionId: input.parentSessionId,
      ...(input.title === undefined ? {} : { title: input.title }),
      activeSkills: input.activeSkills,
    });
    this.#agents.set(key, agent);
    return agent;
  }

  get(workspaceRoot: string, sessionId: string): Agent | undefined {
    return this.#agents.get(scopedKey(workspaceRoot, sessionId));
  }

  async dispatchCommand(
    workspaceRoot: string,
    sessionId: string,
    name: string,
    args?: string,
  ): Promise<CommandResult | null> {
    const agent = this.get(workspaceRoot, sessionId);
    if (!agent?.dispatchCommand) return null;

    return await agent.dispatchCommand(name, args);
  }

  dispose(workspaceRoot: string, sessionId: string): void {
    const key = scopedKey(workspaceRoot, sessionId);
    this.#tombstones.set(key, Date.now());
    const agent = this.#agents.get(key);
    if (!agent) {
      this.#storeManager.delete(sessionId, workspaceRoot);
      return;
    }

    agent.dispose();
    this.#agents.delete(key);
    this.#storeManager.delete(sessionId, workspaceRoot);
  }

  isTombstoned(workspaceRoot: string, sessionId: string): boolean {
    return this.#isTombstonedKey(scopedKey(workspaceRoot, sessionId));
  }

  clearTombstone(workspaceRoot: string, sessionId: string): boolean {
    return this.#tombstones.delete(scopedKey(workspaceRoot, sessionId));
  }

  acquireSlot(workspaceRoot: string, sessionId: string): void {
    const active = this.#activeJobsByWorkspace.get(workspaceRoot) ?? new Set<string>();
    if (!active.has(sessionId) && active.size >= this.maxConcurrentSessions) {
      throw new ConcurrentSessionLimitError(workspaceRoot, active.size, this.maxConcurrentSessions);
    }

    active.add(sessionId);
    this.#activeJobsByWorkspace.set(workspaceRoot, active);
  }

  releaseSlot(workspaceRoot: string, sessionId: string): void {
    const active = this.#activeJobsByWorkspace.get(workspaceRoot);
    if (!active) return;

    active.delete(sessionId);
    if (active.size === 0) {
      this.#activeJobsByWorkspace.delete(workspaceRoot);
    }
  }

  disposeAll(): void {
    for (const key of [...this.#agents.keys()]) {
      const [workspaceRoot, sessionId] = key.split("\0");
      if (workspaceRoot !== undefined && sessionId !== undefined) {
        this.dispose(workspaceRoot, sessionId);
      }
    }
  }

  getByWorkspace(workspaceRoot: string): Agent[] {
    const prefix = `${workspaceRoot}\0`;
    return [...this.#agents]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, agent]) => agent);
  }

  getFactory(workspaceRoot: string): AgentFactory {
    let factory = this.#factories.get(workspaceRoot);
    if (!factory) {
      factory = createAgentFactory({
        definitions: this.#config.definitions,
        providerRegistry: this.#config.providerRegistry,
        toolRegistry: this.#config.toolRegistry,
        skillService: this.#config.skillService,
        storeManager: this.#storeManager,
        workspaceRoot,
        config: this.#config.config,
        projectContextResolver: this.#config.projectContextResolver,
        startChildExecution: (request) => {
          if (this.#startChildExecution === undefined) {
            return Promise.reject(new Error("Child execution is not available in this session agent manager"));
          }
          return this.#startChildExecution(workspaceRoot, request);
        },
        cancelChildSession: this.#cancelChildSession,
        resumeChildSession: this.#resumeChildSession,
        logger: this.#logger,
      });
      this.#factories.set(workspaceRoot, factory);
    }
    return factory;
  }

  #isTombstonedKey(key: string): boolean {
    const tombstonedAt = this.#tombstones.get(key);
    if (tombstonedAt === undefined) return false;

    if (Date.now() - tombstonedAt > this.tombstoneTtlMs) {
      this.#tombstones.delete(key);
      return false;
    }

    return true;
  }
}
