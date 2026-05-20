import { AgentRunningError } from "../agents/errors";
import type { Agent } from "../agents/types";
import type { CommandResult } from "../commands/types";
import type { SpecraRuntime } from "../runtime";
import { saveSessionTranscript } from "../store/helpers";
import { scopedKey } from "../store/store";
import type { AskUserCallback, ToolConfirmationCallback } from "../tools/types";
import type { AskUserService } from "./ask-user-service";
import type { PermissionService } from "./permission-service";
import { sessionStreams } from "./routes/events";

const ABORT_AND_WAIT_TIMEOUT_MS = 10000;

export interface RunningJob {
  jobId: string;
  sessionId: string;
  workspaceRoot: string;
  abortController: AbortController;
  promise: Promise<void>;
}

export class AgentRunner {
  static #instances = new Set<AgentRunner>();

  #jobs = new Map<string, RunningJob>();
  #runtime: SpecraRuntime;
  #permissionService?: PermissionService;
  #askUserService?: AskUserService;

  constructor(runtime: SpecraRuntime, permissionService?: PermissionService, askUserService?: AskUserService) {
    this.#runtime = runtime;
    this.#permissionService = permissionService;
    this.#askUserService = askUserService;
    AgentRunner.#instances.add(this);
  }

  submit(sessionId: string, workspaceRoot: string, userMessage: string): RunningJob {
    const key = scopedKey(workspaceRoot, sessionId);
    if (this.#jobs.has(key)) {
      throw new AgentRunningError();
    }

    this.#runtime.sessionAgentManager.acquireSlot(workspaceRoot, sessionId);
    const abortController = new AbortController();
    const jobId = crypto.randomUUID();
    let job: RunningJob;

    const promise = this.#runJob(sessionId, workspaceRoot, userMessage, abortController)
      .finally(() => {
        this.#jobs.delete(key);
        this.#runtime.sessionAgentManager.releaseSlot(workspaceRoot, sessionId);
      });

    job = {
      jobId,
      sessionId,
      workspaceRoot,
      abortController,
      promise,
    };
    this.#jobs.set(key, job);

    return job;
  }

  abort(workspaceRoot: string, sessionId: string): boolean {
    const key = scopedKey(workspaceRoot, sessionId);
    const job = this.#jobs.get(key);
    if (!job) {
      return false;
    }

    job.abortController.abort();
    this.#jobs.delete(key);
    return true;
  }

  async abortAndWait(workspaceRoot: string, sessionId: string): Promise<void> {
    const key = scopedKey(workspaceRoot, sessionId);
    const job = this.#jobs.get(key);
    if (!job) return;

    job.abortController.abort();
    this.#jobs.delete(key);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, ABORT_AND_WAIT_TIMEOUT_MS));
    await Promise.race([job.promise.catch(() => {}), timeout]);
  }

  cleanupSession(workspaceRoot: string, sessionId: string): void {
    this.#permissionService?.cleanup(sessionId, workspaceRoot);
    this.#askUserService?.cleanup(sessionId, workspaceRoot);
  }

  async abortAll(): Promise<void> {
    const jobs = AgentRunner.#runningJobs();
    for (const job of jobs) {
      job.abortController.abort();
    }

    await Promise.allSettled(jobs.map((job) => job.promise));
  }

  static #runningJobs(): RunningJob[] {
    return [...AgentRunner.#instances].flatMap((runner) => [...runner.#jobs.values()]);
  }

  isRunning(workspaceRoot: string, sessionId: string): boolean {
    return this.#jobs.has(scopedKey(workspaceRoot, sessionId));
  }

  getJob(workspaceRoot: string, sessionId: string): RunningJob | undefined {
    return this.#jobs.get(scopedKey(workspaceRoot, sessionId));
  }

  async dispatchCommand(workspaceRoot: string, sessionId: string, name: string, args?: string): Promise<CommandResult | null> {
    return await this.#runtime.dispatchCommand(workspaceRoot, sessionId, name, args);
  }

  async #runJob(
    sessionId: string,
    workspaceRoot: string,
    userMessage: string,
    abortController: AbortController,
  ): Promise<void> {
    let agent: Agent | undefined;

    try {
      agent = await this.#runtime.agentFor(workspaceRoot, sessionId);
      if (abortController.signal.aborted) {
        return;
      }

      const activeAgent = agent;
      sessionStreams.set(scopedKey(workspaceRoot, sessionId), {
        store: activeAgent.store,
        lastSentEventId: activeAgent.store.getState().nextEventId - 1,
      });

      const confirmPermission: ToolConfirmationCallback | undefined = this.#permissionService
        ? (request, abortSignal) => this.#permissionService!.request(sessionId, workspaceRoot, request, activeAgent.store, abortSignal)
        : undefined;
      const askUser: AskUserCallback | undefined = this.#askUserService
        ? (request) => {
          const { abortSignal, ...serializableRequest } = request;
          return this.#askUserService!.request(sessionId, workspaceRoot, serializableRequest, activeAgent.store, abortSignal);
        }
        : undefined;

      await activeAgent.run(userMessage, {
        abort: abortController.signal,
        ...(confirmPermission ? { confirmPermission } : {}),
        ...(askUser ? { askUser } : {}),
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.error(
          `[AgentRunner] Job for session "${sessionId}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      if (agent && !this.#runtime.sessionAgentManager.isTombstoned(workspaceRoot, sessionId)) {
        try {
          await saveSessionTranscript(agent.store.getState(), workspaceRoot);
        } catch (error) {
          console.error(
            `[AgentRunner] Failed to save session "${sessionId}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
}
