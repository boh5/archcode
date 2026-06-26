import { rm } from "node:fs/promises";
import type { SessionExecutionRecord, SessionTreeNode, SessionTreeResponse, ToolChildSessionLink, ToolChildSessionLinkStatus } from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import {
  AgentChildPolicyMissingError,
  AgentRunningError,
  ChildSessionAgentMismatchError,
  ChildSessionNotFoundError,
  ChildSessionNotDescendantError,
  ChildSessionParentMismatchError,
  ConcurrentLimitError,
  DelegateTargetNotAllowedError,
  DelegationToolNotAllowedError,
  DepthLimitError,
} from "../agents/errors";
import type { AgentResult } from "../agents/types";
import type { CommandResult } from "../commands/types";
import type { AvailableArtifactReference, ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";
import type { AskUserResponse } from "../deferred";
import { SessionEventBridge } from "../events/session-event-bridge";
import type { SubscribeSessionEventsInput } from "../events/session-event-bridge";
import { getRootSessionDir, getRootSessionPath, getSessionPath } from "../store/sessions-dir";
import { SessionDeleteConflictError } from "../store/errors";
import { scopedKey } from "../store/key";
import type { Reminder, SessionStoreState } from "../store/types";
import type { StoredMessage } from "../store/types";
import type { AskUserRequest, ToolConfirmationRequest, ToolConfirmationResult } from "../tools/types";
import type { Logger } from "../logger";
import { formatActiveWorkflowBlock, hasWorkflowTools } from "../prompt/sections/active-workflow";
import type { ActiveWorkflowPromptContext } from "../prompt/types";
import { ProjectContextResolver } from "../projects/context-resolver";

const ABORT_AND_WAIT_TIMEOUT_MS = 10000;

const TERMINAL_CHILD_LINK_STATUSES = new Set<ToolChildSessionLinkStatus>([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
]);

export type SessionExecutionOrigin =
  | "user_message"
  | "tool_call";

export interface ActiveSessionExecution {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly agentName: string;
  readonly origin: SessionExecutionOrigin;
  readonly abortController: AbortController;
  readonly promise: Promise<void>;
  readonly executionToken: symbol;
  readonly startedAt: number;
}

// Session execution lifecycle:
//   active execution: starting -> running -> cancelling -> completed | failed | cancelled | timed_out | interrupted
//   parent link:      linked   -> running -> cancelling -> completed | failed | cancelled | timed_out | interrupted
// `executionToken` is the generation guard for every manager-owned completion path:
// stale promises may resolve after abort/restart, but must not write terminal execution
// events, child links, reminders, or deferred-request cleanup for a newer generation.

export interface StartSessionExecutionInput {
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly userMessage: string;
  readonly agentName?: string;
  readonly origin?: SessionExecutionOrigin;
}

interface PendingSessionExecution extends Omit<ActiveSessionExecution, "promise"> {
  promise?: Promise<void>;
}

interface SessionExecutionManagerConfig {
  readonly sessionAgentManager: SessionAgentManager;
  readonly createSessionStore: (
    sessionId: string,
    workspaceRoot: string,
    options?: {
      readonly rootSessionId?: string;
      readonly parentSessionId?: string;
      readonly workflowId?: string;
      readonly agentName?: string;
      readonly title?: string;
    },
  ) => StoreApi<SessionStoreState>;
  readonly getSessionStore: (sessionId: string, workspaceRoot: string) => StoreApi<SessionStoreState> | undefined;
  readonly deleteSessionStore: (
    sessionId: string,
    workspaceRoot: string,
    options?: { readonly forgetWorkspaceIndex?: boolean },
  ) => boolean;
  readonly resolveRootSessionId: (sessionId: string, workspaceRoot: string) => Promise<string>;
  readonly buildSessionTree: (workspaceRoot: string, rootSessionId: string) => Promise<SessionTreeResponse>;
  readonly requestPermission: (
    workspaceRoot: string,
    sessionId: string,
    request: ToolConfirmationRequest,
    abortSignal?: AbortSignal,
  ) => Promise<ToolConfirmationResult>;
  readonly requestQuestion: (
    workspaceRoot: string,
    sessionId: string,
    request: AskUserRequest,
  ) => Promise<AskUserResponse>;
  readonly cleanupDeferredSession: (workspaceRoot: string, sessionId: string) => void;
  readonly trackSession: (workspaceRoot: string, sessionId: string) => void;
  readonly untrackSession: (workspaceRoot: string, sessionId: string) => void;
  readonly projectContextResolver?: ProjectContextResolver;
  readonly logger: Logger;
}

export class SessionExecutionManager {
  readonly #active = new Map<string, ActiveSessionExecution | PendingSessionExecution>();
  readonly #childSlots = new Map<string, number>();
  readonly #eventBridge: SessionEventBridge;
  readonly #config: SessionExecutionManagerConfig;
  readonly #logger: Logger;
  readonly #projectContextResolver: ProjectContextResolver;

  constructor(config: SessionExecutionManagerConfig) {
    this.#config = config;
    this.#logger = config.logger;
    this.#projectContextResolver = config.projectContextResolver ?? new ProjectContextResolver({ logger: config.logger });
    this.#eventBridge = new SessionEventBridge({
      getStore: (workspaceRoot, sessionId) => this.#config.getSessionStore(sessionId, workspaceRoot),
    });
  }

  startExecution(input: StartSessionExecutionInput): ActiveSessionExecution {
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    if (this.#active.has(key)) {
      throw new AgentRunningError();
    }

    const abortController = new AbortController();
    const executionToken = Symbol(`session-execution:${key}`);
    const pending: PendingSessionExecution = {
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      agentName: input.agentName ?? "orchestrator",
      origin: input.origin ?? "user_message",
      abortController,
      executionToken,
      startedAt: Date.now(),
    };

    this.#active.set(key, pending);

    let slotAcquired = false;
    try {
      this.#config.sessionAgentManager.acquireSlot(input.workspaceRoot, input.sessionId);
      slotAcquired = true;
      this.#config.trackSession(input.workspaceRoot, input.sessionId);

      const promise = this.#runExecution(input, pending).finally(() => {
        this.#finalizeExecution(key, pending, slotAcquired);
      });
      const execution: ActiveSessionExecution = { ...pending, promise };
      this.#active.set(key, execution);
      return execution;
    } catch (error) {
      if (slotAcquired) this.#config.sessionAgentManager.releaseSlot(input.workspaceRoot, input.sessionId);
      this.#active.delete(key);
      throw error;
    }
  }

  abort(workspaceRoot: string, sessionId: string): boolean {
    const executions = this.#collectActiveCascade(workspaceRoot, sessionId);
    if (executions.length === 0) return false;

    for (const execution of executions) this.#cancelExecution(execution, "Session cancelled");
    return true;
  }

  async abortAndWait(workspaceRoot: string, sessionId: string): Promise<void> {
    const executions = this.#collectActiveCascade(workspaceRoot, sessionId);
    if (executions.length === 0) return;

    for (const execution of executions) this.#cancelExecution(execution, "Session cancelled");

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, ABORT_AND_WAIT_TIMEOUT_MS));
    await Promise.race([
      Promise.all(executions.map((execution) => execution.promise?.catch(() => { /* aborted — ignore rejection */ }))).then(() => undefined),
      timeout,
    ]);
  }

  async abortAll(): Promise<void> {
    const executions = [...this.#active.values()];
    for (const execution of executions) this.#cancelExecution(execution, "Session cancelled");

    await Promise.allSettled(executions.map((execution) => execution.promise));
  }

  isRunning(workspaceRoot: string, sessionId: string): boolean {
    return this.#active.has(scopedKey(workspaceRoot, sessionId));
  }

  getExecution(workspaceRoot: string, sessionId: string): ActiveSessionExecution | undefined {
    const execution = this.#active.get(scopedKey(workspaceRoot, sessionId));
    return execution?.promise ? execution as ActiveSessionExecution : undefined;
  }

  async startChildExecution(workspaceRoot: string, request: ChildExecutionRequest): Promise<ChildExecutionHandle> {
    const factory = this.#config.sessionAgentManager.getFactory(workspaceRoot);
    const currentDepth = request.currentDepth ?? 0;
    const parentAgentName = request.parentStore.getState().agentName ?? "orchestrator";
    const parentDefinition = factory.getDefinition(parentAgentName);
    const allowedTools = factory.resolveAllowedTools(parentDefinition, currentDepth);

    if (!allowedTools.includes("delegate")) {
      throw new DelegationToolNotAllowedError(parentAgentName, currentDepth);
    }

    const delegateTargets = factory.getDelegateTargetsFor(parentDefinition, currentDepth);
    if (!delegateTargets.includes(request.targetAgentName)) {
      throw new DelegateTargetNotAllowedError(parentAgentName, request.targetAgentName, currentDepth);
    }

    const targetDefinition = factory.getDefinition(request.targetAgentName);
    const targetAllowedTools = factory.resolveAllowedTools(targetDefinition, currentDepth + 1);
    const childPolicy = parentDefinition.childPolicy;
    if (childPolicy === undefined) {
      throw new AgentChildPolicyMissingError(parentAgentName);
    }

    if (currentDepth >= childPolicy.maxDepth) {
      throw new DepthLimitError(currentDepth);
    }

    const activeSkills = await factory.resolveDelegatedSkills(targetDefinition, request.skills);
    this.#reserveChildSlot(workspaceRoot, request.parentSessionId, childPolicy.maxConcurrent);
    let childSlotReserved = true;

    this.#config.sessionAgentManager.acquireSlot(workspaceRoot, request.parentSessionId);
    let parentSlotReserved = true;
    const background = request.background ?? false;
    const childSessionId = crypto.randomUUID();
    const childTitle = request.title ?? request.description;
    const createdAt = Date.now();
    let childStore: StoreApi<SessionStoreState> | undefined;
    let execution: ActiveSessionExecution;

    try {
      this.#appendChildLinkStatus(workspaceRoot, request, childSessionId, targetDefinition.name, currentDepth + 1, "linked", childTitle, createdAt, background);
      const parentState = request.parentStore.getState();
      childStore = this.#config.createSessionStore(childSessionId, workspaceRoot, {
        rootSessionId: parentState.rootSessionId ?? request.parentSessionId,
        parentSessionId: request.parentSessionId,
        workflowId: parentState.workflowId,
        agentName: targetDefinition.name,
        ...(childTitle === undefined ? {} : { title: childTitle }),
      });
      this.#eventBridge.attachSession(workspaceRoot, childSessionId, childStore);

      const activeWorkflow = await this.#resolveChildActiveWorkflow(workspaceRoot, childStore, targetAllowedTools);

      this.#config.sessionAgentManager.createChildAgent({
        workspaceRoot,
        sessionId: childSessionId,
        agentName: targetDefinition.name,
        store: childStore,
        depth: currentDepth + 1,
        parentSessionId: request.parentSessionId,
        ...(childTitle === undefined ? {} : { title: childTitle }),
        activeSkills,
      });

      this.#config.sessionAgentManager.releaseSlot(workspaceRoot, request.parentSessionId);
      parentSlotReserved = false;
      execution = this.startExecution({
        slug: "",
        workspaceRoot,
        sessionId: childSessionId,
        userMessage: buildChildUserMessage(request.prompt, request.available_artifacts, activeWorkflow, targetAllowedTools),
        agentName: targetDefinition.name,
        origin: "tool_call",
      });
      this.#appendChildLinkStatus(workspaceRoot, request, childSessionId, targetDefinition.name, currentDepth + 1, "running", childTitle, createdAt, background);
    } catch (error) {
      if (parentSlotReserved) this.#config.sessionAgentManager.releaseSlot(workspaceRoot, request.parentSessionId);
      if (childSlotReserved) this.#releaseChildSlot(workspaceRoot, request.parentSessionId);
      if (childStore !== undefined) {
        this.#eventBridge.detachSession(workspaceRoot, childSessionId);
        this.#config.deleteSessionStore(childSessionId, workspaceRoot);
      }
      throw error;
    }

    const timeout = childPolicy.timeoutMs > 0
      ? setTimeout(() => execution.abortController.abort(new Error("Sub-agent timed out")), childPolicy.timeoutMs)
      : undefined;
    const removeParentAbort = childPolicy.abortCascade
      ? wireAbortCascade(request.parentAbort, execution.abortController)
      : () => {};

    const result = execution.promise
      .then(() => toAgentResult(childStore))
      .finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
        removeParentAbort();
        if (childSlotReserved) {
          this.#releaseChildSlot(workspaceRoot, request.parentSessionId);
          childSlotReserved = false;
        }
        const current = this.#active.get(scopedKey(workspaceRoot, childSessionId));
        if (current !== undefined && current.executionToken !== execution.executionToken) return;
        const status = childTerminalStatus(childStore.getState().executions.at(-1), execution.abortController.signal);
        this.#appendChildLinkStatus(workspaceRoot, request, childSessionId, targetDefinition.name, currentDepth + 1, status, childTitle, createdAt, background);
        if (background && childPolicy.terminalReminders) {
          appendTerminalReminder(request.parentStore, childSessionId, status);
        }
      });

    return {
      sessionId: childSessionId,
      store: childStore,
      result,
      abort: () => this.#cancelExecution(execution, "Sub-agent aborted"),
    };
  }

  cancelChildSession(workspaceRoot: string, parentSessionId: string, childSessionId: string): boolean {
    if (!this.#isDescendantOf(workspaceRoot, childSessionId, parentSessionId)) {
      throw new ChildSessionNotDescendantError(parentSessionId, childSessionId);
    }
    return this.abort(workspaceRoot, childSessionId);
  }

  async resumeChildExecution(workspaceRoot: string, request: ResumeChildRequest): Promise<ChildExecutionHandle> {
    const key = scopedKey(workspaceRoot, request.sessionId);
    if (this.#active.has(key)) throw new AgentRunningError();

    const childStore = this.#config.getSessionStore(request.sessionId, workspaceRoot);
    if (childStore === undefined) {
      throw new ChildSessionNotFoundError(workspaceRoot, request.sessionId);
    }
    const childState = childStore.getState();
    if (childState.agentName !== request.targetAgentName) {
      throw new ChildSessionAgentMismatchError(request.sessionId, request.targetAgentName, childState.agentName);
    }
    if (childState.parentSessionId !== request.parentSessionId) {
      throw new ChildSessionParentMismatchError(request.sessionId, request.parentSessionId, childState.parentSessionId);
    }

    const existingLink = this.#findChildSessionLink(request.parentStore, request.sessionId);
    const resumeLinkCreatedAt = Date.now();
    this.#appendResumeChildLinkStatus(workspaceRoot, request, existingLink, "running", resumeLinkCreatedAt);

    await this.#config.sessionAgentManager.getOrCreate(workspaceRoot, request.sessionId);
    const execution = this.startExecution({
      slug: "",
      workspaceRoot,
      sessionId: request.sessionId,
      userMessage: request.prompt,
      agentName: request.targetAgentName,
      origin: "tool_call",
    });

    const removeParentAbort = wireAbortCascade(request.parentAbort, execution.abortController);

    const result = execution.promise
      .then(() => toAgentResult(childStore))
      .finally(() => {
        removeParentAbort();
        const current = this.#active.get(scopedKey(workspaceRoot, request.sessionId));
        if (current !== undefined && current.executionToken !== execution.executionToken) return;
        const status = childTerminalStatus(childStore.getState().executions.at(-1), execution.abortController.signal);
        this.#appendResumeChildLinkStatus(workspaceRoot, request, existingLink, status, resumeLinkCreatedAt);
      });

    return {
      sessionId: request.sessionId,
      store: childStore,
      result,
      abort: () => this.#cancelExecution(execution, "Sub-agent aborted"),
    };
  }

  async dispatchCommand(
    workspaceRoot: string,
    sessionId: string,
    name: string,
    args?: string,
  ): Promise<CommandResult | null> {
    if (!this.isRunning(workspaceRoot, sessionId)) return null;
    return await this.#config.sessionAgentManager.dispatchCommand(workspaceRoot, sessionId, name, args);
  }

  subscribe(input: SubscribeSessionEventsInput): () => void {
    return this.#eventBridge.subscribe(input);
  }

  async deleteSession(workspaceRoot: string, sessionId: string): Promise<void> {
    const rootSessionId = await this.#config.resolveRootSessionId(sessionId, workspaceRoot);
    const tree = await this.#config.buildSessionTree(workspaceRoot, rootSessionId);
    const sessionIds = sessionId === rootSessionId
      ? flattenSessionTree(tree.root)
      : collectSubtreeSessionIds(tree.root, sessionId);

    if (sessionIds.length === 0) {
      throw new Error(`Session "${sessionId}" was not found in tree rooted at "${rootSessionId}"`);
    }

    const stuckSessionIds = await this.#abortAndWaitForSessions(workspaceRoot, sessionIds);
    if (stuckSessionIds.length > 0) {
      throw new SessionDeleteConflictError(stuckSessionIds);
    }

    for (const id of sessionIds) {
      this.#config.cleanupDeferredSession(workspaceRoot, id);
      this.#config.sessionAgentManager.dispose(workspaceRoot, id);
      this.#config.untrackSession(workspaceRoot, id);
      this.#detachIfIdle(workspaceRoot, id);
    }

    if (sessionId === rootSessionId) {
      await removeIfExists(getRootSessionPath(workspaceRoot, rootSessionId));
      await rm(getRootSessionDir(workspaceRoot, rootSessionId), { recursive: true, force: true });
      for (const id of sessionIds) this.#config.deleteSessionStore(id, workspaceRoot);
      this.#config.deleteSessionStore(rootSessionId, workspaceRoot, { forgetWorkspaceIndex: true });
    } else {
      for (const id of sessionIds) {
        await removeIfExists(getSessionPath(workspaceRoot, rootSessionId, id));
      }
      for (const id of sessionIds) this.#config.deleteSessionStore(id, workspaceRoot);
    }
  }

  async #runExecution(input: StartSessionExecutionInput, execution: PendingSessionExecution): Promise<void> {
    try {
      const agent = await this.#config.sessionAgentManager.getOrCreate(input.workspaceRoot, input.sessionId);
      this.#eventBridge.attachSession(input.workspaceRoot, input.sessionId, agent.store);
      if (execution.abortController.signal.aborted) return;

      const current = this.#active.get(scopedKey(input.workspaceRoot, input.sessionId));
      if (current?.executionToken !== execution.executionToken) return;

      agent.store.getState().append({ type: "execution-start" });
      if (execution.abortController.signal.aborted) return;

      await agent.run(input.userMessage, {
        abort: execution.abortController.signal,
        confirmPermission: (request, abortSignal) =>
          this.#config.requestPermission(input.workspaceRoot, input.sessionId, request, abortSignal),
        askUser: (request) => this.#config.requestQuestion(input.workspaceRoot, input.sessionId, request),
      });
    } catch (error) {
      if (!execution.abortController.signal.aborted) {
        const current = this.#active.get(scopedKey(input.workspaceRoot, input.sessionId));
        if (current?.executionToken !== execution.executionToken) return;
        const store = this.#config.getSessionStore(input.sessionId, input.workspaceRoot);
        if (store?.getState().isRunning) {
          store.getState().append({
            type: "execution-end",
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.#logger.error("session.execution.failed", {
          error,
          context: { sessionId: input.sessionId, agentName: execution.agentName, origin: execution.origin },
          meta: { workspaceRoot: input.workspaceRoot },
        });
      }
    }
  }

  #finalizeExecution(key: string, execution: PendingSessionExecution, slotAcquired: boolean): void {
    const current = this.#active.get(key);
    const isCurrentExecution = current?.executionToken === execution.executionToken;
    if (isCurrentExecution) {
      const store = this.#config.getSessionStore(execution.sessionId, execution.workspaceRoot);
      if (store?.getState().isRunning) {
        store.getState().append({
          type: "execution-end",
          status: execution.abortController.signal.aborted ? abortExecutionStatus(execution.abortController.signal) : "completed",
        });
      }
      this.#active.delete(key);
    }

    if (isCurrentExecution) {
      if (slotAcquired) this.#config.sessionAgentManager.releaseSlot(execution.workspaceRoot, execution.sessionId);
      this.#config.cleanupDeferredSession(execution.workspaceRoot, execution.sessionId);
      this.#detachIfIdle(execution.workspaceRoot, execution.sessionId);
    }
  }

  #cancelExecution(execution: ActiveSessionExecution | PendingSessionExecution, reason: string): void {
    const key = scopedKey(execution.workspaceRoot, execution.sessionId);
    const current = this.#active.get(key);
    if (current?.executionToken !== execution.executionToken) return;

    this.#markParentLinkCancelling(execution.workspaceRoot, execution.sessionId);
    execution.abortController.abort(new Error(reason));
    this.#config.cleanupDeferredSession(execution.workspaceRoot, execution.sessionId);
  }

  async #abortAndWaitForSessions(workspaceRoot: string, sessionIds: readonly string[]): Promise<string[]> {
    const executions = sessionIds
      .map((sessionId) => this.#active.get(scopedKey(workspaceRoot, sessionId)))
      .filter((execution): execution is ActiveSessionExecution | PendingSessionExecution => execution !== undefined);

    for (const execution of executions) this.#cancelExecution(execution, "Session cancelled");

    const settled = await Promise.all(executions.map(async (execution) => {
      try {
        await waitForExecutionToStop(execution);
        return undefined;
      } catch {
        return execution.sessionId;
      }
    }));

    return settled.filter((id): id is string => id !== undefined);
  }

  #collectActiveCascade(workspaceRoot: string, sessionId: string): Array<ActiveSessionExecution | PendingSessionExecution> {
    const direct = this.#active.get(scopedKey(workspaceRoot, sessionId));
    const sessionIds = new Set<string>([sessionId]);
    const activeSessionIds = [...this.#active.values()]
      .filter((execution) => execution.workspaceRoot === workspaceRoot)
      .map((execution) => execution.sessionId);

    for (const activeSessionId of activeSessionIds) {
      const store = this.#config.getSessionStore(activeSessionId, workspaceRoot);
      let parentSessionId = store?.getState().parentSessionId;
      while (parentSessionId !== undefined) {
        if (parentSessionId === sessionId) {
          sessionIds.add(activeSessionId);
          break;
        }
        parentSessionId = this.#config.getSessionStore(parentSessionId, workspaceRoot)?.getState().parentSessionId;
      }
    }

    const executions = [...sessionIds]
      .map((id) => this.#active.get(scopedKey(workspaceRoot, id)))
      .filter((execution): execution is ActiveSessionExecution | PendingSessionExecution => execution !== undefined);
    if (executions.length > 0 || direct === undefined) return executions;
    return [direct];
  }

  #detachIfIdle(workspaceRoot: string, sessionId: string): void {
    if (this.isRunning(workspaceRoot, sessionId)) return;
    this.#eventBridge.detachSession(workspaceRoot, sessionId);
  }

  #countActiveChildren(workspaceRoot: string, parentSessionId: string): number {
    let count = 0;
    for (const execution of this.#active.values()) {
      if (execution.workspaceRoot !== workspaceRoot) continue;
      const store = this.#config.getSessionStore(execution.sessionId, workspaceRoot);
      if (store?.getState().parentSessionId === parentSessionId) count += 1;
    }
    return count;
  }

  #reserveChildSlot(workspaceRoot: string, parentSessionId: string, maxConcurrent: number): void {
    const key = scopedKey(workspaceRoot, parentSessionId);
    const activeChildren = this.#countActiveChildren(workspaceRoot, parentSessionId);
    const reservedChildren = this.#childSlots.get(key) ?? 0;
    const totalChildren = Math.max(activeChildren, reservedChildren);
    if (totalChildren >= maxConcurrent) throw new ConcurrentLimitError(totalChildren);
    this.#childSlots.set(key, reservedChildren + 1);
  }

  #releaseChildSlot(workspaceRoot: string, parentSessionId: string): void {
    const key = scopedKey(workspaceRoot, parentSessionId);
    const reservedChildren = this.#childSlots.get(key) ?? 0;
    if (reservedChildren <= 1) this.#childSlots.delete(key);
    else this.#childSlots.set(key, reservedChildren - 1);
  }

  #appendChildLinkStatus(
    workspaceRoot: string,
    request: ChildExecutionRequest,
    childSessionId: string,
    childAgentName: string,
    depth: number,
    status: ToolChildSessionLinkStatus,
    title: string | undefined,
    createdAt?: number,
    background?: boolean,
  ): void {
    const run = this.#config.getSessionStore(childSessionId, workspaceRoot)?.getState().executions.at(-1);
    request.parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: request.parentSessionId,
        parentToolCallId: request.parentToolCallId,
        toolName: request.toolName,
        childSessionId,
        childAgentName,
        ...(title === undefined ? {} : { title }),
        ...(request.description === undefined ? {} : { description: request.description }),
        depth,
        background: background ?? request.background ?? false,
        status,
        createdAt: createdAt ?? Date.now(),
        ...(run?.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run?.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        ...(run?.durationMs === undefined ? {} : { durationMs: run.durationMs }),
        ...(run?.error === undefined ? {} : { error: run.error }),
      },
    });
  }

  #appendResumeChildLinkStatus(
    workspaceRoot: string,
    request: ResumeChildRequest,
    existingLink: ToolChildSessionLink | undefined,
    status: ToolChildSessionLinkStatus,
    createdAt: number,
  ): void {
    const run = this.#config.getSessionStore(request.sessionId, workspaceRoot)?.getState().executions.at(-1);
    const includeRunMetadata = TERMINAL_CHILD_LINK_STATUSES.has(status);
    request.parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: request.parentSessionId,
        parentToolCallId: request.parentToolCallId,
        toolName: request.toolName,
        childSessionId: request.sessionId,
        childAgentName: request.targetAgentName,
        ...(existingLink?.title === undefined ? {} : { title: existingLink.title }),
        ...(existingLink?.description === undefined ? {} : { description: existingLink.description }),
        depth: existingLink?.depth ?? (request.currentDepth ?? 0) + 1,
        background: false,
        status,
        createdAt,
        ...(includeRunMetadata && run?.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
        ...(includeRunMetadata && run?.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
        ...(includeRunMetadata && run?.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
        ...(includeRunMetadata && run?.error !== undefined ? { error: run.error } : {}),
      },
    });
  }

  #markParentLinkCancelling(workspaceRoot: string, childSessionId: string): void {
    const childStore = this.#config.getSessionStore(childSessionId, workspaceRoot);
    const childState = childStore?.getState();
    const parentSessionId = childState?.parentSessionId;
    if (parentSessionId === undefined) return;
    const parentStore = this.#config.getSessionStore(parentSessionId, workspaceRoot);
    const links = parentStore?.getState().childSessionLinks ?? [];
    let link: ToolChildSessionLink | undefined;
    for (let index = links.length - 1; index >= 0; index -= 1) {
      const candidate = links[index];
      if (candidate?.childSessionId === childSessionId && !TERMINAL_CHILD_LINK_STATUSES.has(candidate.status)) {
        link = candidate;
        break;
      }
    }
    if (parentStore === undefined || link === undefined || link.status === "cancelling") return;
    parentStore.getState().append({
      type: "tool-child-session-link",
      link: { ...link, status: "cancelling" },
    });
  }

  #isDescendantOf(workspaceRoot: string, descendantSessionId: string, ancestorSessionId: string): boolean {
    if (descendantSessionId === ancestorSessionId) return false;
    let currentSessionId: string | undefined = descendantSessionId;
    const visited = new Set<string>();
    while (currentSessionId !== undefined && !visited.has(currentSessionId)) {
      visited.add(currentSessionId);
      const store = this.#config.getSessionStore(currentSessionId, workspaceRoot);
      const parentSessionId = store?.getState().parentSessionId;
      if (parentSessionId === undefined) return false;
      if (parentSessionId === ancestorSessionId) return true;
      currentSessionId = parentSessionId;
    }
    return false;
  }

  #findChildSessionLink(parentStore: StoreApi<SessionStoreState>, childSessionId: string): ToolChildSessionLink | undefined {
    const links = parentStore.getState().childSessionLinks;
    for (let index = links.length - 1; index >= 0; index -= 1) {
      const candidate = links[index];
      if (candidate?.childSessionId === childSessionId) return candidate;
    }
    return undefined;
  }

  async #resolveChildActiveWorkflow(
    workspaceRoot: string,
    childStore: StoreApi<SessionStoreState>,
    allowedTools: readonly string[],
  ): Promise<ActiveWorkflowPromptContext | undefined> {
    const workflowId = childStore.getState().workflowId;
    if (workflowId === undefined || !hasWorkflowTools(allowedTools)) return undefined;

    try {
      const projectContext = await this.#projectContextResolver.resolve(workspaceRoot);
      const workflow = await projectContext.workflowState.read(workflowId);
      return {
        id: workflow.id,
        title: workflow.title,
        type: workflow.type,
        stage: workflow.stage,
        status: workflow.status,
      };
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(`Active workflow context required but workflow state could not be read for workflowId "${workflowId}": ${detail}`);
    }
  }
}

type SubAgentTerminalStatus = Extract<ToolChildSessionLinkStatus, "completed" | "failed" | "timed_out" | "cancelled" | "interrupted">;

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

function childTerminalStatus(run: SessionExecutionRecord | undefined, signal: AbortSignal): SubAgentTerminalStatus {
  if (run?.status === "completed") return "completed";
  if (run?.status === "timed_out") return "timed_out";
  if (run?.status === "cancelled") return "cancelled";
  if (run?.status === "failed") return "failed";
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error && /timed out/i.test(reason.message)) return "timed_out";
    return "cancelled";
  }
  return "failed";
}

function abortExecutionStatus(signal: AbortSignal): "aborted" | "cancelled" | "timed_out" {
  const reason = signal.reason;
  if (reason instanceof Error) {
    if (/timed out/i.test(reason.message)) return "timed_out";
    if (/cancelled|canceled|aborted/i.test(reason.message)) return "cancelled";
  }
  return "aborted";
}

function appendTerminalReminder(
  parentStore: StoreApi<SessionStoreState>,
  sessionId: string,
  status: SubAgentTerminalStatus,
): void {
  const reminder: Reminder = {
    id: crypto.randomUUID(),
    source: status === "completed"
      ? { type: "subagent_completed", sessionId }
      : status === "timed_out"
        ? { type: "subagent_timed_out", sessionId }
        : status === "cancelled"
          ? { type: "subagent_cancelled", sessionId }
          : { type: "subagent_failed", sessionId },
    delivery: "on_demand",
    sessionId,
    terminalState: status,
    content: `Sub-agent ${sessionId} ${formatStatus(status)}. Use background_output(session_id="${sessionId}") to read the result.`,
    createdAt: Date.now(),
    consumedAt: null,
    targetSessionId: parentStore.getState().sessionId,
  };
  parentStore.getState().append({ type: "reminder", reminder });
}

function formatStatus(status: SubAgentTerminalStatus): string {
  if (status === "timed_out") return "timed out";
  return status;
}

function buildChildUserMessage(
  prompt: string,
  availableArtifacts: readonly AvailableArtifactReference[] | undefined,
  activeWorkflow: ActiveWorkflowPromptContext | undefined,
  allowedTools: readonly string[],
): string {
  const sections = [prompt];

  if (activeWorkflow !== undefined && hasWorkflowTools(allowedTools)) {
    sections.push("", formatActiveWorkflowBlock(activeWorkflow));
  }

  if (availableArtifacts === undefined || availableArtifacts.length === 0) return sections.join("\n");

  const references = availableArtifacts.map(formatArtifactReference).join("\n");
  sections.push(
    "",
    "Available artifacts:",
    references,
    "Use artifact_read before relying on artifact content. The references above identify available artifacts only; their contents are not included in this prompt.",
  );
  return sections.join("\n");
}

function formatArtifactReference(reference: AvailableArtifactReference): string {
  const locator = reference.path === undefined
    ? `${reference.workflowId}/${reference.kind ?? "artifact"}`
    : reference.kind === undefined
      ? `${reference.workflowId}/${reference.path}`
      : `${reference.workflowId}/${reference.kind} (${reference.path})`;
  return reference.description === undefined ? `- ${locator}` : `- ${locator}: ${reference.description}`;
}

function toAgentResult(store: StoreApi<SessionStoreState>): AgentResult {
  return { text: getLastAssistantText(store.getState().messages), steps: store.getState().steps.length };
}

function getLastAssistantText(messages: readonly StoredMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.length > 0) return text;
  }
  return "";
}

async function waitForExecutionToStop(execution: ActiveSessionExecution | PendingSessionExecution): Promise<void> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for session "${execution.sessionId}" to abort`)), ABORT_AND_WAIT_TIMEOUT_MS);
  });
  await Promise.race([execution.promise ?? Promise.resolve(), timeout]);
}

async function removeIfExists(path: string): Promise<void> {
  if (await Bun.file(path).exists()) await rm(path);
}

function flattenSessionTree(node: SessionTreeNode): string[] {
  return [node.session.sessionId, ...node.children.flatMap((child) => flattenSessionTree(child))];
}

function collectSubtreeSessionIds(node: SessionTreeNode, targetSessionId: string): string[] {
  if (node.session.sessionId === targetSessionId) return flattenSessionTree(node);
  for (const child of node.children) {
    const found = collectSubtreeSessionIds(child, targetSessionId);
    if (found.length > 0) return found;
  }
  return [];
}
