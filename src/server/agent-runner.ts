import { AgentRunningError } from "../agents/errors";
import type { Agent } from "../agents/types";
import type { SpecraRuntime } from "../main";
import { saveSessionTranscript } from "../store/helpers";
import type { ToolConfirmationCallback } from "../tools/types";
import type { PermissionService } from "./permission-service";
import { ensureSessionRing } from "./routes/events";

export interface RunningJob {
  jobId: string;
  sessionId: string;
  abortController: AbortController;
  promise: Promise<void>;
}

export class AgentRunner {
  #jobs = new Map<string, RunningJob>();
  #runtime: SpecraRuntime;
  #permissionService?: PermissionService;

  constructor(runtime: SpecraRuntime, permissionService?: PermissionService) {
    this.#runtime = runtime;
    this.#permissionService = permissionService;
  }

  submit(sessionId: string, workspaceRoot: string, userMessage: string): RunningJob {
    if (this.#jobs.has(sessionId)) {
      throw new AgentRunningError();
    }

    const abortController = new AbortController();
    const jobId = crypto.randomUUID();
    let job: RunningJob;

    const promise = this.#runJob(sessionId, workspaceRoot, userMessage, abortController)
      .finally(() => {
        this.#jobs.delete(sessionId);
      });

    job = {
      jobId,
      sessionId,
      abortController,
      promise,
    };
    this.#jobs.set(sessionId, job);

    return job;
  }

  abort(sessionId: string): boolean {
    const job = this.#jobs.get(sessionId);
    if (!job) {
      return false;
    }

    job.abortController.abort();
    this.#jobs.delete(sessionId);
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.#jobs.has(sessionId);
  }

  getJob(sessionId: string): RunningJob | undefined {
    return this.#jobs.get(sessionId);
  }

  async #runJob(
    sessionId: string,
    workspaceRoot: string,
    userMessage: string,
    abortController: AbortController,
  ): Promise<void> {
    let agent: Agent | undefined;

    try {
      agent = await this.#runtime.agentFor(workspaceRoot);
      if (abortController.signal.aborted) {
        return;
      }

      const ring = ensureSessionRing(sessionId);
      const confirmPermission: ToolConfirmationCallback | undefined = this.#permissionService
        ? (request, abortSignal) => this.#permissionService!.request(sessionId, request, ring, abortSignal)
        : undefined;

      await agent.run(userMessage, {
        abort: abortController.signal,
        ...(confirmPermission ? { confirmPermission } : {}),
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.error(
          `[AgentRunner] Job for session "${sessionId}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      if (agent) {
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
