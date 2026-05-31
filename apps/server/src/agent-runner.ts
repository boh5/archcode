import type { ActiveSessionExecution, CommandResult, SpecraRuntime } from "@specra/agent-core";
import { globalEventBus } from "./events/global-event-bus";

export type { ActiveSessionExecution } from "@specra/agent-core";

export interface StartSessionExecutionInput {
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

  start(input: StartSessionExecutionInput): ActiveSessionExecution {
    const unsubscribe = this.#runtime.subscribeSessionEvents({
      slug: input.slug,
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      onEvent: (event) => globalEventBus.emit(event),
    });
    try {
      const execution = this.#runtime.startSessionExecution(input);
      void execution.promise.finally(unsubscribe);
      return execution;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  submit(input: StartSessionExecutionInput): ActiveSessionExecution {
    return this.start(input);
  }

  abort(workspaceRoot: string, sessionId: string): boolean {
    return this.#runtime.abortSessionExecution(workspaceRoot, sessionId);
  }

  async abortAndWait(workspaceRoot: string, sessionId: string): Promise<void> {
    await this.#runtime.abortSessionExecutionAndWait(workspaceRoot, sessionId);
  }

  cleanupSession(workspaceRoot: string, sessionId: string): void {
    this.#runtime.cleanupDeferredSession(workspaceRoot, sessionId);
  }

  async abortAll(): Promise<void> {
    await this.#runtime.abortAllSessionExecutions();
  }

  isRunning(workspaceRoot: string, sessionId: string): boolean {
    return this.#runtime.isSessionExecutionRunning(workspaceRoot, sessionId);
  }

  getExecution(workspaceRoot: string, sessionId: string): ActiveSessionExecution | undefined {
    return this.#runtime.getSessionExecution(workspaceRoot, sessionId);
  }

  async dispatchCommand(workspaceRoot: string, sessionId: string, name: string, args?: string): Promise<CommandResult | null> {
    return await this.#runtime.dispatchCommand(workspaceRoot, sessionId, name, args);
  }
}
