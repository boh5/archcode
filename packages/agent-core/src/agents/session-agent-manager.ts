import type { MemoryExtractionConfig } from "../config/index";
import type { ProjectContextResolver } from "../projects/context-resolver";
import { SessionStoreManager } from "../store/session-store-manager";
import { scopedKey } from "../store/key";
import type { SessionStoreState } from "../store/types";
import type { ToolRegistry } from "../tools/index";
import type { SkillService } from "../skills";
import type { StoreApi } from "zustand";
import { createAgentFactory } from "./factory";
import type { AgentFactory } from "./factory";
import type { AgentDefinition } from "./factory-types";
import type { Agent } from "./types";
import type { Logger } from "../logger";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";
import { assertValidSessionCwd } from "../store/session-cwd";
import type { ToolOutputAccessService } from "../tool-output/access-service";

export interface SessionAgentManagerConfig {
  readonly definitions: readonly AgentDefinition[];
  readonly toolRegistry: ToolRegistry;
  readonly skillService: SkillService;
  readonly memoryConfig?: MemoryExtractionConfig;
  readonly projectContextResolver: ProjectContextResolver;
  readonly tombstoneTtlMs?: number;
  readonly storeManager: SessionStoreManager;
  readonly createToolOutputAccess: (workspaceRoot: string, rootSessionId: string) => ToolOutputAccessService;
  readonly startChildExecution?: (workspaceRoot: string, request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  readonly cancelChildSession?: (workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean;
  readonly resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  readonly acquireSessionCwdTransition?: (workspaceRoot: string, sessionId: string) => () => void;
  readonly logger: Logger;
}

const DEFAULT_TOMBSTONE_TTL_MS = 300000;

export class SessionAgentManager {
  #agents = new Map<string, Agent>();
  #pendingAgents = new Map<string, Promise<Agent>>();
  #factories = new Map<string, AgentFactory>();
  #tombstones = new Map<string, number>();
  #config: SessionAgentManagerConfig;
  readonly tombstoneTtlMs: number;
  readonly #storeManager: SessionStoreManager;
  readonly #logger: Logger;
  #startChildExecution: SessionAgentManagerConfig["startChildExecution"];
  #cancelChildSession: SessionAgentManagerConfig["cancelChildSession"];
  #resumeChildSession: SessionAgentManagerConfig["resumeChildSession"];
  #acquireSessionCwdTransition: SessionAgentManagerConfig["acquireSessionCwdTransition"];

  constructor(config: SessionAgentManagerConfig) {
    this.#config = config;
    this.#storeManager = config.storeManager;
    this.#logger = config.logger;
    this.#startChildExecution = config.startChildExecution;
    this.#cancelChildSession = config.cancelChildSession;
    this.#resumeChildSession = config.resumeChildSession;
    this.#acquireSessionCwdTransition = config.acquireSessionCwdTransition;
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

  setAcquireSessionCwdTransition(callback: SessionAgentManagerConfig["acquireSessionCwdTransition"]): void {
    this.#acquireSessionCwdTransition = callback;
  }

  async getOrCreate(workspaceRoot: string, sessionId: string): Promise<Agent> {
    const key = scopedKey(workspaceRoot, sessionId);
    if (this.#isTombstonedKey(key)) {
      throw new Error(`Session "${sessionId}" in workspace "${workspaceRoot}" has been deleted`);
    }

    const existing = this.#agents.get(key);
    if (existing) {
      const currentCwd = existing.store.getState().cwd;
      if (existing.cwd === currentCwd) return existing;
      existing.dispose();
      this.#agents.delete(key);
    }

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
    const store = await this.#storeManager.getOrLoad(sessionId, workspaceRoot);
    const factory = this.getFactory(workspaceRoot);
    const state = store.getState();
    await this.#validateSessionCwd(workspaceRoot, state.cwd);
    if (state.parentSessionId === undefined) {
      return factory.createRootAgent(state.agentName, { store });
    }
    const depth = await this.#storeManager.resolveSessionDepth(workspaceRoot, sessionId);
    return factory.createAgent(state.agentName, {
      store,
      depth,
    });
  }

  createChildAgent(input: {
    workspaceRoot: string;
    sessionId: string;
    store: StoreApi<SessionStoreState>;
    depth: number;
  }): void {
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    const existing = this.#agents.get(key);
    if (existing) return;

    const factory = this.getFactory(input.workspaceRoot);
    const state = input.store.getState();
    const agent = factory.createAgent(state.agentName, {
      store: input.store,
      depth: input.depth,
    });
    this.#agents.set(key, agent);
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

  release(workspaceRoot: string, sessionId: string): void {
    const key = scopedKey(workspaceRoot, sessionId);
    const agent = this.#agents.get(key);
    agent?.dispose();
    this.#agents.delete(key);
    this.#pendingAgents.delete(key);
    this.#storeManager.delete(sessionId, workspaceRoot);
  }

  /** Dispose only the cached Agent runtime while preserving the canonical Session store. */
  releaseAgent(workspaceRoot: string, sessionId: string): void {
    const key = scopedKey(workspaceRoot, sessionId);
    const agent = this.#agents.get(key);
    agent?.dispose();
    this.#agents.delete(key);
    this.#pendingAgents.delete(key);
  }

  releaseWorkspace(workspaceRoot: string): void {
    const prefix = `${workspaceRoot}\0`;
    for (const [key, agent] of [...this.#agents.entries()]) {
      if (!key.startsWith(prefix)) continue;
      agent.dispose();
      this.#agents.delete(key);
    }
    for (const key of [...this.#pendingAgents.keys()]) {
      if (key.startsWith(prefix)) this.#pendingAgents.delete(key);
    }
    this.#factories.delete(workspaceRoot);
  }

  isTombstoned(workspaceRoot: string, sessionId: string): boolean {
    return this.#isTombstonedKey(scopedKey(workspaceRoot, sessionId));
  }

  clearTombstone(workspaceRoot: string, sessionId: string): boolean {
    return this.#tombstones.delete(scopedKey(workspaceRoot, sessionId));
  }

  disposeAll(): void {
    for (const key of [...this.#agents.keys()]) {
      const [workspaceRoot, sessionId] = key.split("\0");
      if (workspaceRoot !== undefined && sessionId !== undefined) {
        this.dispose(workspaceRoot, sessionId);
      }
    }
  }

  getFactory(workspaceRoot: string): AgentFactory {
    let factory = this.#factories.get(workspaceRoot);
    if (!factory) {
      factory = createAgentFactory({
        definitions: this.#config.definitions,
        toolRegistry: this.#config.toolRegistry,
        skillService: this.#config.skillService,
        storeManager: this.#storeManager,
        createToolOutputAccess: this.#config.createToolOutputAccess,
        workspaceRoot,
        memoryConfig: this.#config.memoryConfig,
        projectContextResolver: this.#config.projectContextResolver,
        startChildExecution: (request) => {
          if (this.#startChildExecution === undefined) {
            return Promise.reject(new Error("Child execution is not available in this session agent manager"));
          }
          return this.#startChildExecution(workspaceRoot, request);
        },
        cancelChildSession: this.#cancelChildSession,
        resumeChildSession: this.#resumeChildSession,
        acquireSessionCwdTransition: this.#acquireSessionCwdTransition,
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

  async #validateSessionCwd(workspaceRoot: string, cwd: string): Promise<string> {
    await assertValidSessionCwd(workspaceRoot, cwd);
    return cwd;
  }
}
