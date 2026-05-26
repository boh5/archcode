import type { CommandResult, RunningJob, SpecraRuntime } from "@specra/agent-core";
import { globalEventBus } from "./events/global-event-bus";

export type { RunningJob } from "@specra/agent-core";

export interface SubmitAgentJobInput {
  slug: string;
  sessionId: string;
  workspaceRoot: string;
  userMessage: string;
}

export class AgentRunner {
  readonly #runtime: SpecraRuntime;

  constructor(runtime: SpecraRuntime) {
    this.#runtime = runtime;
  }

  submit(input: SubmitAgentJobInput): RunningJob {
    const unsubscribe = this.#runtime.subscribeSessionEvents({
      slug: input.slug,
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      onEvent: (event) => globalEventBus.emit(event),
    });
    try {
      const job = this.#runtime.submitAgentJob(input);
      void job.promise.finally(unsubscribe);
      return job;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  abort(workspaceRoot: string, sessionId: string): boolean {
    return this.#runtime.abortAgentJob(workspaceRoot, sessionId);
  }

  async abortAndWait(workspaceRoot: string, sessionId: string): Promise<void> {
    await this.#runtime.abortAgentJobAndWait(workspaceRoot, sessionId);
  }

  cleanupSession(workspaceRoot: string, sessionId: string): void {
    this.#runtime.cleanupDeferredSession(workspaceRoot, sessionId);
  }

  async abortAll(): Promise<void> {
    await this.#runtime.abortAllAgentJobs();
  }

  isRunning(workspaceRoot: string, sessionId: string): boolean {
    return this.#runtime.isAgentJobRunning(workspaceRoot, sessionId);
  }

  getJob(workspaceRoot: string, sessionId: string): RunningJob | undefined {
    return this.#runtime.getAgentJob(workspaceRoot, sessionId);
  }

  async dispatchCommand(workspaceRoot: string, sessionId: string, name: string, args?: string): Promise<CommandResult | null> {
    return await this.#runtime.dispatchCommand(workspaceRoot, sessionId, name, args);
  }
}
