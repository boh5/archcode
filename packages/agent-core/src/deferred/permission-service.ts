import type {
  ToolConfirmationRequest,
  ToolConfirmationResult,
} from "../tools/types";
import type { DeferredEventSubmitter } from "./types";

interface PendingPermission {
  sessionId: string;
  workspaceRoot: string;
  resolve(result: ToolConfirmationResult): void;
  cleanupAbortListener?(): void;
}

export class DeferredPermissionService {
  readonly #pending = new Map<string, PendingPermission>();
  readonly #events: DeferredEventSubmitter;

  constructor(events: DeferredEventSubmitter) {
    this.#events = events;
  }

  request(
    sessionId: string,
    workspaceRoot: string,
    request: ToolConfirmationRequest,
    abortSignal?: AbortSignal,
  ): Promise<ToolConfirmationResult> {
    const permissionId = crypto.randomUUID();

    this.#events.submitDeferredEvent(workspaceRoot, sessionId, {
      type: "permission.request",
      permissionId,
      toolName: request.toolName,
      args: request.input,
      description: request.description,
    });

    if (abortSignal?.aborted) {
      this.#events.submitDeferredEvent(workspaceRoot, sessionId, {
        type: "permission.terminal",
        permissionId,
        status: "timeout",
      });
      return Promise.resolve("timeout");
    }

    return new Promise<ToolConfirmationResult>((resolve) => {
      const pending: PendingPermission = {
        sessionId,
        workspaceRoot,
        resolve,
      };

      const onAbort = (): void => {
        if (!this.#pending.has(permissionId)) return;
        this.#pending.delete(permissionId);
        pending.cleanupAbortListener?.();
        this.#events.submitDeferredEvent(workspaceRoot, sessionId, {
          type: "permission.terminal",
          permissionId,
          status: "timeout",
        });
        resolve("timeout");
      };

      if (abortSignal) {
        abortSignal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
      }

      this.#pending.set(permissionId, pending);
    });
  }

  respond(permissionId: string, response: ToolConfirmationResult): boolean {
    const pending = this.#pending.get(permissionId);
    if (!pending) return false;

    this.#pending.delete(permissionId);
    pending.cleanupAbortListener?.();
    pending.resolve(response);
    this.#events.submitDeferredEvent(pending.workspaceRoot, pending.sessionId, {
      type: "permission.terminal",
      permissionId,
      status: response === "timeout" ? "timeout" : response === "deny" ? "denied" : "resolved",
    });
    return true;
  }

  has(permissionId: string): boolean {
    return this.#pending.has(permissionId);
  }

  cleanup(sessionId?: string, workspaceRoot?: string): void {
    for (const [permissionId, pending] of this.#pending) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      if (workspaceRoot !== undefined && pending.workspaceRoot !== workspaceRoot) continue;

      this.#pending.delete(permissionId);
      pending.cleanupAbortListener?.();
      pending.resolve("timeout");
      this.#events.submitDeferredEvent(pending.workspaceRoot, pending.sessionId, {
        type: "permission.terminal",
        permissionId,
        status: "cancelled",
      });
    }
  }
}
