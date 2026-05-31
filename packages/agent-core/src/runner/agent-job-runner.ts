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

export interface RunningJob {
  readonly jobId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly abortController: AbortController;
  readonly promise: Promise<void>;
}

export interface SubmitAgentJobInput {
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly userMessage: string;
}

interface AgentJobRunnerConfig {
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

export class AgentJobRunner {
  readonly #jobs = new Map<string, RunningJob>();
  readonly #eventBridge: SessionEventBridge;
  readonly #config: AgentJobRunnerConfig;
  readonly #logger: Logger;

  constructor(config: AgentJobRunnerConfig) {
    this.#config = config;
    this.#logger = config.logger;
    this.#eventBridge = new SessionEventBridge({
      getStore: (workspaceRoot, sessionId) => this.#config.storeManager.get(sessionId, workspaceRoot),
    });
  }

  submit(input: SubmitAgentJobInput): RunningJob {
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    if (this.#jobs.has(key)) {
      throw new AgentRunningError();
    }

    this.#config.sessionAgentManager.acquireSlot(input.workspaceRoot, input.sessionId);
    this.#config.trackSession(input.workspaceRoot, input.sessionId);
    const abortController = new AbortController();
    const jobId = crypto.randomUUID();

    const promise = this.#runJob(input, abortController).finally(() => {
      this.#jobs.delete(key);
      this.#config.sessionAgentManager.releaseSlot(input.workspaceRoot, input.sessionId);
      this.#config.cleanupDeferredSession(input.workspaceRoot, input.sessionId);
    });

    const job: RunningJob = {
      jobId,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      abortController,
      promise,
    };
    this.#jobs.set(key, job);
    return job;
  }

  abort(workspaceRoot: string, sessionId: string): boolean {
    const job = this.#jobs.get(scopedKey(workspaceRoot, sessionId));
    if (!job) return false;

    job.abortController.abort();
    this.#jobs.delete(scopedKey(workspaceRoot, sessionId));
    return true;
  }

  async abortAndWait(workspaceRoot: string, sessionId: string): Promise<void> {
    const job = this.#jobs.get(scopedKey(workspaceRoot, sessionId));
    if (!job) return;

    job.abortController.abort();
    this.#jobs.delete(scopedKey(workspaceRoot, sessionId));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, ABORT_AND_WAIT_TIMEOUT_MS));
    await Promise.race([job.promise.catch(() => { /* aborted — ignore rejection */ }), timeout]);
  }

  async abortAll(): Promise<void> {
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) {
      job.abortController.abort();
      this.#jobs.delete(scopedKey(job.workspaceRoot, job.sessionId));
    }

    await Promise.allSettled(jobs.map((job) => job.promise));
  }

  isRunning(workspaceRoot: string, sessionId: string): boolean {
    return this.#jobs.has(scopedKey(workspaceRoot, sessionId));
  }

  getJob(workspaceRoot: string, sessionId: string): RunningJob | undefined {
    return this.#jobs.get(scopedKey(workspaceRoot, sessionId));
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
      this.#eventBridge.detachSession(workspaceRoot, id);
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

  async #abortAndWaitForSessions(workspaceRoot: string, sessionIds: readonly string[]): Promise<string[]> {
    const runningJobs = sessionIds
      .map((sessionId) => this.#jobs.get(scopedKey(workspaceRoot, sessionId)))
      .filter((job): job is RunningJob => job !== undefined);

    for (const job of runningJobs) {
      job.abortController.abort();
      this.#jobs.delete(scopedKey(job.workspaceRoot, job.sessionId));
    }

    const settled = await Promise.all(runningJobs.map(async (job) => {
      try {
        await waitForJobToStop(job);
        return undefined;
      } catch {
        return job.sessionId;
      }
    }));

    return settled.filter((id): id is string => id !== undefined);
  }

  async #runJob(input: SubmitAgentJobInput, abortController: AbortController): Promise<void> {
    try {
      const agent = await this.#config.sessionAgentManager.getOrCreate(input.workspaceRoot, input.sessionId);
      this.#eventBridge.attachSession(input.workspaceRoot, input.sessionId, agent.store);
      if (abortController.signal.aborted) return;

      await agent.run(input.userMessage, {
        abort: abortController.signal,
        confirmPermission: (request, abortSignal) =>
          this.#config.requestPermission(input.workspaceRoot, input.sessionId, request, abortSignal),
        askUser: (request) => this.#config.requestQuestion(input.workspaceRoot, input.sessionId, request),
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        this.#logger.error("agent.job.failed", {
          error,
          context: { sessionId: input.sessionId },
          meta: { workspaceRoot: input.workspaceRoot },
        });
      }
    }
  }

}

async function waitForJobToStop(job: RunningJob): Promise<void> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for session "${job.sessionId}" to abort`)), ABORT_AND_WAIT_TIMEOUT_MS);
  });
  await Promise.race([job.promise, timeout]);
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
