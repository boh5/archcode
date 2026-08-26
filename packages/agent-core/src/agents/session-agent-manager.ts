import type { AgentTreeProjection, BuiltinMcpServerName, ToolAuthorizationSnapshot } from "@archcode/protocol";
import type { ProjectContextResolver } from "../projects/context-resolver";
import { SessionStoreManager } from "../store/session-store-manager";
import { scopedKey } from "../store/key";
import type { SessionStoreState } from "../store/types";
import type { ToolRegistry } from "../tools/index";
import type { SkillService } from "../skills";
import type { StoreApi } from "zustand";
import { createAgentFactory } from "./factory";
import type { AgentFactory } from "./factory";
import type { AgentDefinition, AgentMcpToolSnapshot } from "./factory-types";
import type { Agent } from "./types";
import { ConfiguredAgent } from "./configured-agent";
import type { Logger } from "../logger";
import type {
  CancelDescendantSession,
  ChildExecutionHandle,
  ChildExecutionRequest,
  ResumeChildRequest,
  SendMessageToChild,
} from "../delegation/types";
import { assertValidSessionCwd } from "../store/session-cwd";
import type { ToolOutputAccessService } from "../tool-output/access-service";
import type { SessionGoalService } from "../session-goal";
import type { AttachmentModelProjector } from "../attachments";

export interface SessionAgentManagerConfig {
  readonly definitions: readonly AgentDefinition[];
  readonly toolRegistry: ToolRegistry;
  readonly skillService: SkillService;
  readonly projectContextResolver: ProjectContextResolver;
  readonly sessionGoalService?: SessionGoalService;
  readonly tombstoneTtlMs?: number;
  readonly storeManager: SessionStoreManager;
  readonly createToolOutputAccess: (workspaceRoot: string, rootSessionId: string) => ToolOutputAccessService;
  readonly attachmentProjector: AttachmentModelProjector;
  readonly resolveAttachmentReadPaths: (
    workspaceRoot: string,
    rootSessionId: string,
  ) => Promise<ReadonlySet<string>>;
  readonly startChildExecution?: (workspaceRoot: string, request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
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

const DEFAULT_TOMBSTONE_TTL_MS = 300000;

interface PendingAgentActivation {
  readonly token: symbol;
  readonly promise: Promise<Agent>;
}

export class SessionAgentManager {
  #agents = new Map<string, Agent>();
  #pendingAgents = new Map<string, PendingAgentActivation>();
  #factories = new Map<string, AgentFactory>();
  #tombstones = new Map<string, number>();
  #config: SessionAgentManagerConfig;
  readonly tombstoneTtlMs: number;
  readonly #storeManager: SessionStoreManager;
  readonly #logger: Logger;
  #startChildExecution: SessionAgentManagerConfig["startChildExecution"];
  #cancelDescendantSession: SessionAgentManagerConfig["cancelDescendantSession"];
  #sendMessageToChild: SessionAgentManagerConfig["sendMessageToChild"];
  #resumeChildSession: SessionAgentManagerConfig["resumeChildSession"];
  #getAgentTreeProjection: SessionAgentManagerConfig["getAgentTreeProjection"];
  #acquireSessionCwdTransition: SessionAgentManagerConfig["acquireSessionCwdTransition"];

  constructor(config: SessionAgentManagerConfig) {
    this.#config = config;
    this.#storeManager = config.storeManager;
    this.#logger = config.logger;
    this.#startChildExecution = config.startChildExecution;
    this.#cancelDescendantSession = config.cancelDescendantSession;
    this.#sendMessageToChild = config.sendMessageToChild;
    this.#resumeChildSession = config.resumeChildSession;
    this.#getAgentTreeProjection = config.getAgentTreeProjection;
    this.#acquireSessionCwdTransition = config.acquireSessionCwdTransition;
    this.tombstoneTtlMs = config.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
  }

  setStartChildExecution(callback: SessionAgentManagerConfig["startChildExecution"]): void {
    this.#startChildExecution = callback;
  }

  setCancelDescendantSession(callback: SessionAgentManagerConfig["cancelDescendantSession"]): void {
    this.#cancelDescendantSession = callback;
  }

  setSendMessageToChild(callback: SessionAgentManagerConfig["sendMessageToChild"]): void {
    this.#sendMessageToChild = callback;
  }

  setResumeChildSession(callback: SessionAgentManagerConfig["resumeChildSession"]): void {
    this.#resumeChildSession = callback;
  }

  setGetAgentTreeProjection(callback: SessionAgentManagerConfig["getAgentTreeProjection"]): void {
    this.#getAgentTreeProjection = callback;
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
    if (pending) return pending.promise;

    const token = Symbol(`agent-activation:${key}`);
    const promise = this.#createAndRegisterAgent(workspaceRoot, sessionId, key, token);
    this.#pendingAgents.set(key, { token, promise });
    return promise;
  }

  async validateToolAuthorization(
    workspaceRoot: string,
    sessionId: string,
    authorization: ToolAuthorizationSnapshot,
  ): Promise<void> {
    const agent = await this.getOrCreate(workspaceRoot, sessionId);
    if (!(agent instanceof ConfiguredAgent)) {
      throw new Error(`Session "${sessionId}" does not own a ConfiguredAgent authorization boundary`);
    }
    await agent.validateToolAuthorization(authorization);
  }

  /** Read-only cache probe used to preserve pre-existing warm Agents on failed activation. */
  get(workspaceRoot: string, sessionId: string): Agent | undefined {
    return this.#agents.get(scopedKey(workspaceRoot, sessionId));
  }

  async #createAndRegisterAgent(
    workspaceRoot: string,
    sessionId: string,
    key: string,
    token: symbol,
  ): Promise<Agent> {
    try {
      const agent = await this.#createAgent(workspaceRoot, sessionId);
      if (this.#isTombstonedKey(key)) {
        agent.dispose();
        throw new Error(`Session "${sessionId}" in workspace "${workspaceRoot}" has been deleted`);
      }
      if (this.#pendingAgents.get(key)?.token !== token) {
        agent.dispose();
        throw new Error(`Agent activation for Session "${sessionId}" was superseded`);
      }

      this.#agents.set(key, agent);
      return agent;
    } finally {
      if (this.#pendingAgents.get(key)?.token === token) this.#pendingAgents.delete(key);
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
    this.#pendingAgents.delete(key);

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
    this.#pendingAgents.delete(key);
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
        attachmentProjector: this.#config.attachmentProjector,
        resolveAttachmentReadPaths: this.#config.resolveAttachmentReadPaths,
        workspaceRoot,
        projectContextResolver: this.#config.projectContextResolver,
        sessionGoalService: this.#config.sessionGoalService,
        startChildExecution: (request) => {
          if (this.#startChildExecution === undefined) {
            return Promise.reject(new Error("Child execution is not available in this session agent manager"));
          }
          return this.#startChildExecution(workspaceRoot, request);
        },
        cancelDescendantSession: this.#cancelDescendantSession,
        sendMessageToChild: this.#sendMessageToChild,
        resumeChildSession: this.#resumeChildSession,
        getAgentTreeProjection: this.#getAgentTreeProjection,
        acquireSessionCwdTransition: this.#acquireSessionCwdTransition,
        resolveMcpToolSnapshot: this.#config.resolveMcpToolSnapshot,
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
