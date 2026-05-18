import { AgentRunningError } from "../agents/errors";
import { ConfiguredAgent } from "../agents/configured-agent";
import type { Agent } from "../agents/types";
import type { CommandResult } from "../commands/types";
import type { SpecraRuntime } from "../main";
import { saveSessionTranscript } from "../store/helpers";
import type { AskUserCallback, ToolConfirmationCallback } from "../tools/types";
import type { AskUserService } from "./ask-user-service";
import type { PermissionService } from "./permission-service";
import { ensureSessionRing } from "./routes/events";

export interface RunningJob {
  jobId: string;
  sessionId: string;
  abortController: AbortController;
  promise: Promise<void>;
}

export class AgentRunner {
  static #instances = new Set<AgentRunner>();

  #jobs = new Map<string, RunningJob>();
  #agents = new Map<string, Agent>();
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

  isRunning(sessionId: string): boolean {
    return this.#jobs.has(sessionId);
  }

  getJob(sessionId: string): RunningJob | undefined {
    return this.#jobs.get(sessionId);
  }

  async dispatchCommand(sessionId: string, name: string, args?: string): Promise<CommandResult | null> {
    const agent = this.#agents.get(sessionId);
    if (!(agent instanceof ConfiguredAgent)) {
      return null;
    }

    return await agent.dispatchCommand(name, args);
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
      this.#agents.set(sessionId, agent);

      const ring = ensureSessionRing(sessionId);
      const confirmPermission: ToolConfirmationCallback | undefined = this.#permissionService
        ? (request, abortSignal) => this.#permissionService!.request(sessionId, request, ring, abortSignal)
        : undefined;
      const askUser: AskUserCallback | undefined = this.#askUserService
        ? (request) => {
          const { abortSignal, ...serializableRequest } = request;
          return this.#askUserService!.request(sessionId, serializableRequest, ring, abortSignal);
        }
        : undefined;

      await agent.run(userMessage, {
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
      this.#agents.delete(sessionId);
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
