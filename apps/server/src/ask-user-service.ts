import type { AskUserRequest, AskUserResponse, SpecraRuntime } from "@specra/agent-core";

export class AskUserService {
  readonly #runtime: SpecraRuntime;

  constructor(runtime: SpecraRuntime) {
    this.#runtime = runtime;
  }

  request(
    sessionId: string,
    workspaceRoot: string,
    request: AskUserRequest,
  ): Promise<AskUserResponse> {
    return this.#runtime.requestQuestion(workspaceRoot, sessionId, request);
  }

  respond(questionId: string, response: AskUserResponse): boolean {
    return this.#runtime.respondQuestion(questionId, response);
  }

  cleanup(sessionId?: string, workspaceRoot?: string): void {
    if (sessionId === undefined || workspaceRoot === undefined) return;
    this.#runtime.cleanupDeferredSession(workspaceRoot, sessionId);
  }
}
