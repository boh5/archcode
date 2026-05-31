import { rm } from "node:fs/promises";
import type { SessionTreeNode } from "@specra/protocol";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import { AgentRunningError } from "../agents/errors";
import type { CommandResult } from "../commands/types";
import type { AskUserResponse } from "../deferred";
import { SessionEventBridge } from "../events/session-event-bridge";
import type { SubscribeSessionEventsInput } from "../events/session-event-bridge";
import { getRootSessionDir, getRootSessionPath, getSessionPath } from "../store/sessions-dir";
import { SessionDeleteConflictError } from "../store/errors";
import { scopedKey } from "../store/key";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { AskUserRequest, ToolConfirmationRequest, ToolConfirmationResult } from "../tools/types";
import type { Logger } from "../logger";

const ABORT_AND_WAIT_TIMEOUT_MS = 10000;

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
  readonly storeManager: SessionStoreManager;
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
  readonly logger: Logger;
}

export class SessionExecutionManager {
  readonly #active = new Map<string, ActiveSessionExecution | PendingSessionExecution>();
  readonly #eventBridge: SessionEventBridge;
  readonly #config: SessionExecutionManagerConfig;
  readonly #logger: Logger;

  constructor(config: SessionExecutionManagerConfig) {
    this.#config = config;
    this.#logger = config.logger;
    this.#eventBridge = new SessionEventBridge({
      getStore: (workspaceRoot, sessionId) => this.#config.storeManager.get(sessionId, workspaceRoot),
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

    for (const execution of executions) {
      execution.abortController.abort();
      this.#active.delete(scopedKey(execution.workspaceRoot, execution.sessionId));
    }
    return true;
  }

  async abortAndWait(workspaceRoot: string, sessionId: string): Promise<void> {
    const executions = this.#collectActiveCascade(workspaceRoot, sessionId);
    if (executions.length === 0) return;

    for (const execution of executions) {
      execution.abortController.abort();
      this.#active.delete(scopedKey(execution.workspaceRoot, execution.sessionId));
    }

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, ABORT_AND_WAIT_TIMEOUT_MS));
    await Promise.race([
      Promise.all(executions.map((execution) => execution.promise?.catch(() => { /* aborted — ignore rejection */ }))).then(() => undefined),
      timeout,
    ]);
  }

  async abortAll(): Promise<void> {
    const executions = [...this.#active.values()];
    for (const execution of executions) {
      execution.abortController.abort();
      this.#active.delete(scopedKey(execution.workspaceRoot, execution.sessionId));
    }

    await Promise.allSettled(executions.map((execution) => execution.promise));
  }

  isRunning(workspaceRoot: string, sessionId: string): boolean {
    return this.#active.has(scopedKey(workspaceRoot, sessionId));
  }

  getExecution(workspaceRoot: string, sessionId: string): ActiveSessionExecution | undefined {
    const execution = this.#active.get(scopedKey(workspaceRoot, sessionId));
    return execution?.promise ? execution as ActiveSessionExecution : undefined;
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
    const rootSessionId = await this.#config.storeManager.resolveRootSessionId(sessionId, workspaceRoot);
    const tree = await this.#config.storeManager.buildSessionTree(workspaceRoot, rootSessionId);
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
      for (const id of sessionIds) this.#config.storeManager.delete(id, workspaceRoot);
      this.#config.storeManager.delete(rootSessionId, workspaceRoot, { forgetWorkspaceIndex: true });
    } else {
      for (const id of sessionIds) {
        await removeIfExists(getSessionPath(workspaceRoot, rootSessionId, id));
      }
      for (const id of sessionIds) this.#config.storeManager.delete(id, workspaceRoot);
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
      const store = this.#config.storeManager.get(execution.sessionId, execution.workspaceRoot);
      if (store?.getState().isRunning) {
        store.getState().append({
          type: "execution-end",
          status: execution.abortController.signal.aborted ? "aborted" : "completed",
        });
      }
      this.#active.delete(key);
    }

    if (slotAcquired) this.#config.sessionAgentManager.releaseSlot(execution.workspaceRoot, execution.sessionId);
    this.#config.cleanupDeferredSession(execution.workspaceRoot, execution.sessionId);
    this.#detachIfIdle(execution.workspaceRoot, execution.sessionId);
  }

  async #abortAndWaitForSessions(workspaceRoot: string, sessionIds: readonly string[]): Promise<string[]> {
    const executions = sessionIds
      .map((sessionId) => this.#active.get(scopedKey(workspaceRoot, sessionId)))
      .filter((execution): execution is ActiveSessionExecution | PendingSessionExecution => execution !== undefined);

    for (const execution of executions) {
      execution.abortController.abort();
      this.#active.delete(scopedKey(execution.workspaceRoot, execution.sessionId));
    }

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
      const store = this.#config.storeManager.get(activeSessionId, workspaceRoot);
      let parentSessionId = store?.getState().parentSessionId;
      while (parentSessionId !== undefined) {
        if (parentSessionId === sessionId) {
          sessionIds.add(activeSessionId);
          break;
        }
        parentSessionId = this.#config.storeManager.get(parentSessionId, workspaceRoot)?.getState().parentSessionId;
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
