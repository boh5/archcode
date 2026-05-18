import type {
  ToolConfirmationRequest,
  ToolConfirmationResult,
} from "../tools/types";
import type { EventRing } from "./event-ring";

interface PendingPermission {
  sessionId: string;
  request: ToolConfirmationRequest;
  resolve(result: ToolConfirmationResult): void;
  reject(error: Error): void;
  cleanupAbortListener?(): void;
}

export class PermissionService {
  #pending = new Map<string, PendingPermission>();

  request(
    sessionId: string,
    req: ToolConfirmationRequest,
    ring: EventRing,
    abortSignal?: AbortSignal,
  ): Promise<ToolConfirmationResult> {
    const permissionId = crypto.randomUUID();

    ring.push("permission.request", JSON.stringify({ id: permissionId, sessionId, ...req }));

    if (abortSignal?.aborted) {
      return Promise.resolve("timeout");
    }

    return new Promise<ToolConfirmationResult>((resolve, reject) => {
      const pending: PendingPermission = {
        sessionId,
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
    return true;
  }

  has(permissionId: string): boolean {
    return this.#pending.has(permissionId);
  }

  cleanup(sessionId?: string): void {
    for (const [permissionId, pending] of this.#pending) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) {
        continue;
      }

      this.#pending.delete(permissionId);
      pending.cleanupAbortListener?.();
      pending.resolve("timeout");
    }
  }
}
