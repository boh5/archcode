import type {
  AgentRuntime,
  ToolConfirmationRequest,
  ToolConfirmationResult,
} from "@archcode/agent-core";

export class PermissionService {
  readonly #runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
    this.#runtime = runtime;
  }

  request(
    sessionId: string,
    workspaceRoot: string,
    request: ToolConfirmationRequest,
    abortSignal?: AbortSignal,
  ): Promise<ToolConfirmationResult> {
    return this.#runtime.requestPermission(workspaceRoot, sessionId, request, abortSignal);
  }

  respond(permissionId: string, response: ToolConfirmationResult): boolean {
    return this.#runtime.respondPermission(permissionId, response);
  }

  cleanup(sessionId?: string, workspaceRoot?: string): void {
    if (sessionId === undefined || workspaceRoot === undefined) return;
    this.#runtime.cleanupDeferredSession(workspaceRoot, sessionId);
  }
}
