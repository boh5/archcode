import type {
  ToolConfirmationRequest,
  ToolConfirmationResult,
} from "../tools/types";
import type { EventRing } from "./event-ring";

interface PendingPermission {
  sessionId: string;
  workspaceRoot?: string;
  request: ToolConfirmationRequest;
  resolve(result: ToolConfirmationResult): void;
  reject(error: Error): void;
  cleanupAbortListener?(): void;
}

export class PermissionService {
  #pending = new Map<string, PendingPermission>();

  request(
    sessionId: string,
    workspaceRootOrReq: string | ToolConfirmationRequest,
    reqOrRing: ToolConfirmationRequest | EventRing,
    ringOrAbortSignal?: EventRing | AbortSignal,
    abortSignal?: AbortSignal,
  ): Promise<ToolConfirmationResult> {
    const workspaceRoot = typeof workspaceRootOrReq === "string" ? workspaceRootOrReq : undefined;
    const req = (workspaceRoot ? reqOrRing : workspaceRootOrReq) as ToolConfirmationRequest;
    const ring = (workspaceRoot ? ringOrAbortSignal : reqOrRing) as EventRing;
    const signal = (workspaceRoot ? abortSignal : ringOrAbortSignal) as AbortSignal | undefined;
    const permissionId = crypto.randomUUID();

    ring.push("permission.request", JSON.stringify({ id: permissionId, sessionId, ...req }));

    if (signal?.aborted) {
      return Promise.resolve("timeout");
    }

    return new Promise<ToolConfirmationResult>((resolve, reject) => {
      const pending: PendingPermission = {
        sessionId,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        request: req,
        resolve,
        reject,
      };

      const onAbort = (): void => {
        if (!this.#pending.has(permissionId)) return;
        this.#pending.delete(permissionId);
        pending.cleanupAbortListener?.();
        resolve("timeout");
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbortListener = () => signal.removeEventListener("abort", onAbort);
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
    }
  }
}
