import type {
  ToolConfirmationRequest,
  ToolConfirmationResult,
} from "../tools/types";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";

interface PendingPermission {
  sessionId: string;
  workspaceRoot: string;
  request: ToolConfirmationRequest;
  store: StoreApi<SessionStoreState>;
  resolve(result: ToolConfirmationResult): void;
  reject(error: Error): void;
  cleanupAbortListener?(): void;
}

export class PermissionService {
  #pending = new Map<string, PendingPermission>();

  request(
    sessionId: string,
    workspaceRoot: string,
    request: ToolConfirmationRequest,
    store: StoreApi<SessionStoreState>,
    abortSignal?: AbortSignal,
  ): Promise<ToolConfirmationResult> {
    const permissionId = crypto.randomUUID();

    store.getState().append({
      type: "permission.request",
      permissionId,
      toolName: request.toolName,
      args: request.input,
      description: request.description,
    });

    if (abortSignal?.aborted) {
      store.getState().append({
        type: "permission.terminal",
        permissionId,
        status: "timeout",
      });
      return Promise.resolve("timeout");
    }

    return new Promise<ToolConfirmationResult>((resolve, reject) => {
      const pending: PendingPermission = {
        sessionId,
        workspaceRoot,
        request,
        store,
        resolve,
        reject,
      };

      const onAbort = (): void => {
        if (!this.#pending.has(permissionId)) return;
        this.#pending.delete(permissionId);
        pending.cleanupAbortListener?.();
        pending.store.getState().append({
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
    if (!pending) {
      return false;
    }

    this.#pending.delete(permissionId);
    pending.cleanupAbortListener?.();
    pending.resolve(response);
    pending.store.getState().append({
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
      if (sessionId !== undefined && pending.sessionId !== sessionId) {
        continue;
      }
      if (workspaceRoot !== undefined && pending.workspaceRoot !== workspaceRoot) {
        continue;
      }

      this.#pending.delete(permissionId);
      pending.cleanupAbortListener?.();
      pending.resolve("timeout");
      pending.store.getState().append({
        type: "permission.terminal",
        permissionId,
        status: "cancelled",
      });
    }
  }
}
