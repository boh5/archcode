import type {
  HitlEventSubmitter,
  HitlKind,
  HitlPayload,
  HitlRequest,
  HitlResolutionStatus,
  HitlResponse,
  HitlResponsePayload,
  HitlTrigger,
} from "./types";

interface PendingHitl {
  request: HitlRequest;
  resolve(response: HitlResponse): void;
  timeout?: ReturnType<typeof setTimeout>;
  cleanupAbortListener?(): void;
}

const DEFAULT_CANCEL_REASON = "Cancelled";
const ABORT_REASON = "Aborted";
const SHUTDOWN_REASON = "Shutdown";
const TIMEOUT_REASON = "Timed out";

export class HitlService {
  readonly #pending = new Map<string, PendingHitl>();
  readonly #events: HitlEventSubmitter;

  constructor(events: HitlEventSubmitter) {
    this.#events = events;
  }

  /**
   * HitlService does not persist its queue. Callers (Goal state, session events)
   * persist business outcomes.
   */
  request(
    sessionId: string,
    kind: HitlKind,
    payload: HitlPayload,
    trigger: HitlTrigger = {},
  ): Promise<HitlResponse> {
    const hitlId = crypto.randomUUID();
    const request: HitlRequest = {
      hitlId,
      sessionId,
      kind,
      payload,
      trigger: this.#serializeTrigger(trigger),
      createdAt: Date.now(),
    };

    this.#events.submitHitlEvent(sessionId, { type: "hitl.request", ...request });

    if (trigger.abortSignal?.aborted) {
      const response = this.#terminalResponse(request, "cancelled", ABORT_REASON);
      this.#emitResolved(request, response);
      return Promise.resolve(response);
    }

    return new Promise<HitlResponse>((resolve) => {
      const pending: PendingHitl = { request, resolve };

      const onAbort = (): void => {
        this.#resolveTerminal(hitlId, "cancelled", ABORT_REASON);
      };

      if (trigger.abortSignal) {
        trigger.abortSignal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbortListener = () => trigger.abortSignal?.removeEventListener("abort", onAbort);
      }

      if (trigger.timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          this.#resolveTerminal(hitlId, "timeout", TIMEOUT_REASON);
        }, trigger.timeoutMs);
      }

      this.#pending.set(hitlId, pending);
    });
  }

  respond(hitlId: string, responsePayload: HitlResponsePayload): boolean {
    const pending = this.#pending.get(hitlId);
    if (!pending) return false;

    const response: HitlResponse = {
      hitlId,
      kind: pending.request.kind,
      status: "resolved",
      response: responsePayload,
    };

    this.#resolvePending(hitlId, response);
    return true;
  }

  cancel(hitlId: string, reason = DEFAULT_CANCEL_REASON): boolean {
    return this.#resolveTerminal(hitlId, "cancelled", reason);
  }

  has(hitlId: string): boolean {
    return this.#pending.has(hitlId);
  }

  listPending(projectSlug?: string, goalId?: string, loopId?: string): HitlRequest[] {
    const pendingRequests = Array.from(this.#pending.values()).map((pending) => pending.request);
    return pendingRequests.filter((request) => {
      if (projectSlug !== undefined && request.trigger.projectSlug !== projectSlug) return false;
      if (goalId !== undefined && request.trigger.goalId !== goalId) return false;
      if (loopId !== undefined && request.trigger.loopId !== loopId) return false;
      return true;
    });
  }

  shutdown(): void {
    for (const hitlId of Array.from(this.#pending.keys())) {
      this.#resolveTerminal(hitlId, "cancelled", SHUTDOWN_REASON);
    }
  }

  #resolveTerminal(hitlId: string, status: Exclude<HitlResolutionStatus, "resolved">, reason: string): boolean {
    const pending = this.#pending.get(hitlId);
    if (!pending) return false;

    this.#resolvePending(hitlId, this.#terminalResponse(pending.request, status, reason));
    return true;
  }

  #resolvePending(hitlId: string, response: HitlResponse): void {
    const pending = this.#pending.get(hitlId);
    if (!pending) return;

    this.#pending.delete(hitlId);
    this.#cleanup(pending);
    pending.resolve(response);
    this.#emitResolved(pending.request, response);
  }

  #terminalResponse(
    request: HitlRequest,
    status: Exclude<HitlResolutionStatus, "resolved">,
    reason: string,
  ): HitlResponse {
    return {
      hitlId: request.hitlId,
      kind: request.kind,
      status,
      reason,
    };
  }

  #emitResolved(request: HitlRequest, response: HitlResponse): void {
    this.#events.submitHitlEvent(request.sessionId, {
      type: "hitl.resolved",
      sessionId: request.sessionId,
      resolvedAt: Date.now(),
      ...response,
    });
  }

  #cleanup(pending: PendingHitl): void {
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.cleanupAbortListener?.();
  }

  #serializeTrigger(trigger: HitlTrigger): HitlRequest["trigger"] {
    const { abortSignal: _abortSignal, ...serializableTrigger } = trigger;
    return serializableTrigger;
  }
}
