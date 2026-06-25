import type { AskUserRequest, AskUserResponse, AgentRuntime } from "@archcode/agent-core";

export class AskUserService {
  readonly #runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
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
