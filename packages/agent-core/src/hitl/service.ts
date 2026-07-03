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
import { DurableHitlQueue } from "./durable-queue";

interface PendingHitl {
  request: HitlRequest;
  promise: Promise<HitlResponse>;
  resolve(response: HitlResponse): void;
  timeout?: ReturnType<typeof setTimeout>;
  cleanupAbortListener?(): void;
}

const DEFAULT_CANCEL_REASON = "Cancelled";
const ABORT_REASON = "Aborted";
const SHUTDOWN_REASON = "Shutdown";
const TIMEOUT_REASON = "Timed out";

export class HitlService {
  readonly #pendingResolvers = new Map<string, PendingHitl>();
  readonly #events: HitlEventSubmitter;
  readonly #queue: DurableHitlQueue;

  constructor(events: HitlEventSubmitter = { submitHitlEvent: () => {} }, queue = new DurableHitlQueue()) {
    this.#events = events;
    this.#queue = queue;
  }

  async load(workspaceRoot: string): Promise<void> {
    await this.#queue.load(workspaceRoot);
  }

  async flush(): Promise<void> {
    await this.#queue.flush();
  }

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
    const record = this.#queue.createOrReusePending(request);
    const durableRequest = this.#queue.toRequest(record);

    const existingPending = this.#pendingResolvers.get(durableRequest.hitlId);
    if (existingPending) return existingPending.promise;

    this.#events.submitHitlEvent(sessionId, { type: "hitl.request", ...durableRequest });

    if (trigger.abortSignal?.aborted) {
      const response = this.#terminalResponse(durableRequest, "cancelled", ABORT_REASON);
      this.#queue.cancel(durableRequest.trigger.projectSlug ?? "unknown-project", durableRequest.hitlId, ABORT_REASON);
      this.#emitResolved(durableRequest, response);
      return Promise.resolve(response);
    }

    let resolvePending!: (response: HitlResponse) => void;
    const promise = new Promise<HitlResponse>((resolve) => {
      resolvePending = resolve;
    });

    const pending: PendingHitl = {
      request: durableRequest,
      promise,
      resolve: resolvePending,
    };

    const onAbort = (): void => {
      this.#resolveTerminal(durableRequest.hitlId, "cancelled", ABORT_REASON);
    };

    if (trigger.abortSignal) {
      trigger.abortSignal.addEventListener("abort", onAbort, { once: true });
      pending.cleanupAbortListener = () => trigger.abortSignal?.removeEventListener("abort", onAbort);
    }

    if (durableRequest.trigger.timeoutMs !== undefined) {
      pending.timeout = setTimeout(() => {
        this.#resolveTerminal(durableRequest.hitlId, "timeout", TIMEOUT_REASON);
      }, durableRequest.trigger.timeoutMs);
    }

    this.#pendingResolvers.set(durableRequest.hitlId, pending);
    return promise;
  }

  respond(hitlId: string, responsePayload: HitlResponsePayload, projectSlug?: string): boolean {
    const pending = this.#pendingResolvers.get(hitlId);
    const record = this.#queue.get(hitlId);
    if (!record) return false;
    const responseProjectSlug = projectSlug ?? record.projectSlug;
    const result = this.#queue.resolve(responseProjectSlug, hitlId, responsePayload);
    if (!result.ok) return false;

    const response: HitlResponse = {
      hitlId,
      kind: result.record.kind,
      status: "resolved",
      response: responsePayload,
    };

    if (pending) this.#resolvePending(hitlId, response);
    else this.#emitResolved(this.#queue.toRequest(result.record), response);
    return true;
  }

  cancel(hitlId: string, reason = DEFAULT_CANCEL_REASON, projectSlug?: string): boolean {
    return this.#resolveTerminal(hitlId, "cancelled", reason, projectSlug);
  }

  has(hitlId: string): boolean {
    return this.#queue.has(hitlId);
  }

  listPending(projectSlug?: string, goalId?: string, loopId?: string): HitlRequest[] {
    return this.#queue.listPending(projectSlug, goalId, loopId).map((record) => this.#queue.toRequest(record));
  }

  shutdown(): void {
    for (const hitlId of Array.from(this.#pendingResolvers.keys())) {
      this.#resolveTerminal(hitlId, "cancelled", SHUTDOWN_REASON);
    }
  }

  #resolveTerminal(
    hitlId: string,
    status: Exclude<HitlResolutionStatus, "resolved">,
    reason: string,
    projectSlug?: string,
  ): boolean {
    const pending = this.#pendingResolvers.get(hitlId);
    const record = this.#queue.get(hitlId);
    if (!record) return false;
    const responseProjectSlug = projectSlug ?? record.projectSlug;
    const result = status === "timeout"
      ? this.#queue.timeout(responseProjectSlug, hitlId, reason)
      : this.#queue.cancel(responseProjectSlug, hitlId, reason);
    if (!result.ok) return false;

    const response = this.#terminalResponse(this.#queue.toRequest(result.record), status, reason);
    if (pending) this.#resolvePending(hitlId, response);
    else this.#emitResolved(this.#queue.toRequest(result.record), response);
    return true;
  }

  #resolvePending(hitlId: string, response: HitlResponse): void {
    const pending = this.#pendingResolvers.get(hitlId);
    if (!pending) return;

    this.#pendingResolvers.delete(hitlId);
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
