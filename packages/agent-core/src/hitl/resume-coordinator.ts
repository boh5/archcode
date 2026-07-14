import { hitlIdentityKey, type HitlIdentity, type HitlOwnerKey, type HitlRecord, type HitlResponse } from "@archcode/protocol";

import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { HitlService, type HitlLookupResult } from "./service";

export interface PreparedHitlResume {
  run(record: HitlRecord, response: HitlResponse): Promise<void>;
  release(): void;
}

export function createPreparedHitlResume(
  run: PreparedHitlResume["run"],
  release: () => void = () => undefined,
): PreparedHitlResume {
  let released = false;
  return {
    run,
    release: () => {
      if (released) return;
      released = true;
      release();
    },
  };
}

export interface SessionHitlResumeAdapter {
  prepare(record: HitlRecord, response: HitlResponse): Promise<PreparedHitlResume>;
  /** Runs only after the owner record is durably terminal. */
  finalize?(record: HitlRecord): Promise<void>;
}

export interface GoalHitlResumeAdapter {
  prepare(record: HitlRecord, response: HitlResponse): Promise<PreparedHitlResume>;
}

export interface ResumeCoordinatorAdapters {
  readonly session?: SessionHitlResumeAdapter;
  readonly goal?: GoalHitlResumeAdapter;
}

export interface ResumeRetryHandle {
  cancel(): void;
}

export interface ResumeRetryScheduler {
  now(): number;
  schedule(delayMs: number, run: () => Promise<void>): ResumeRetryHandle;
}

const realResumeRetryScheduler: ResumeRetryScheduler = Object.freeze({
  now: () => Date.now(),
  schedule(delayMs: number, run: () => Promise<void>) {
    const timer = setTimeout(() => void run(), Math.max(0, delayMs));
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
});

export interface ResumeCoordinatorOptions {
  readonly hitl: HitlService;
  readonly adapters?: ResumeCoordinatorAdapters;
  readonly logger?: Logger;
  readonly retryScheduler?: ResumeRetryScheduler;
}

export type ResumeIntent = "respond" | "cancel";

export type ResumeCoordinatorResult =
  | { status: "missing"; scheduled: false }
  | { status: "answered" | "terminal" | "active"; scheduled: boolean; record: HitlRecord };

export interface ResumeRecoverySummary {
  scanned: number;
  scheduled: number;
  skippedPending: number;
  missingResponse: number;
}

type ResumeAdapter = SessionHitlResumeAdapter | GoalHitlResumeAdapter;

export class ResumeCoordinator {
  readonly #hitl: HitlService;
  readonly #adapters: ResumeCoordinatorAdapters;
  readonly #logger: Logger;
  readonly #retryScheduler: ResumeRetryScheduler;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #dispatchedClaims = new Set<string>();
  readonly #retryTimers = new Map<string, ResumeRetryHandle>();
  #disposed = false;

  constructor(options: ResumeCoordinatorOptions) {
    this.#hitl = options.hitl;
    this.#adapters = options.adapters ?? {};
    this.#logger = (options.logger ?? silentLogger).child({ module: "hitl.resume" });
    this.#retryScheduler = options.retryScheduler ?? realResumeRetryScheduler;
  }

  async respond(identity: HitlIdentity, response: HitlResponse): Promise<ResumeCoordinatorResult> {
    return await this.#claimAndSchedule(identity, response, "respond");
  }

  async cancel(identity: HitlIdentity, reason = "Cancelled", cancelledBy?: string): Promise<ResumeCoordinatorResult> {
    return await this.#claimAndSchedule(identity, { type: "cancel", reason, cancelledBy }, "cancel");
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#retryTimers.values()) timer.cancel();
    this.#retryTimers.clear();
  }

  async recover(): Promise<ResumeRecoverySummary> {
    let scanned = 0;
    let scheduled = 0;
    let skippedPending = 0;
    let missingResponse = 0;
    for (const owner of await this.#hitl.knownOwners()) {
      const store = await this.#hitl.ownerStore(owner);
      const file = await store.read();
      for (const record of file.pending) {
        scanned += 1;
        if (record.status === "pending") {
          skippedPending += 1;
          continue;
        }
        if (record.status !== "answered") continue;
        if (record.response === undefined) {
          missingResponse += 1;
          continue;
        }

        const identity = identityFromRecord(record);
        const result = await this.#withHitlLock(identity, async () => {
          const current = await this.#lookupFound(identity);
          if (current === undefined) return false;
          if (current.record.status === "answered") return await this.#scheduleAnsweredRecovery(current.record);
          return false;
        });
        if (result) scheduled += 1;
      }
    }

    // Durable claims and owner-local blockers are the readiness boundary.
    // Adapter work may include a full agent run, so recovery only
    // registers each claim exactly once and lets that work continue after the
    // project context becomes available.
    return { scanned, scheduled, skippedPending, missingResponse };
  }

  async #claimAndSchedule(identity: HitlIdentity, response: HitlResponse, intent: ResumeIntent): Promise<ResumeCoordinatorResult> {
    return await this.#withHitlLock(identity, async () => {
      const found = await this.#hitl.lookup(identity);
      if (found.status === "missing") return { status: "missing", scheduled: false };

      const current = found.record;
      if (current.status === "resolved" || current.status === "cancelled") {
        return { status: "terminal", scheduled: false, record: current };
      }
      if (current.status === "answered") {
        return { status: "answered", scheduled: this.#scheduleDispatch(current), record: current };
      }
      if (current.status !== "pending") {
        return { status: "active", scheduled: false, record: current };
      }

      const prepared = await this.#prepareClaimAndSchedule(identity, current, response, intent);
      if (prepared === undefined) return { status: "missing", scheduled: false };
      return { status: "answered", scheduled: prepared.scheduled, record: prepared.record };
    });
  }

  async #prepareClaimAndSchedule(
    identity: HitlIdentity,
    current: HitlRecord,
    response: HitlResponse,
    intent: ResumeIntent,
  ): Promise<{ readonly record: HitlRecord; readonly scheduled: boolean } | undefined> {
    const claimed = await this.#hitl.claim(identity, response, {
        claimId: crypto.randomUUID(),
        claimedAt: new Date(this.#retryScheduler.now()).toISOString(),
        intent,
        attempt: (current.delivery?.attempt ?? 0) + 1,
      });
    if (claimed === undefined) return undefined;
    const scheduled = this.#scheduleDispatch(claimed);
    return { record: claimed, scheduled };
  }

  async #scheduleAnsweredRecovery(record: HitlRecord): Promise<boolean> {
    const nextAttemptAt = record.delivery?.nextAttemptAt;
    if (record.delivery?.lastError !== undefined && nextAttemptAt === undefined) return false;
    if (nextAttemptAt !== undefined && Date.parse(nextAttemptAt) > this.#retryScheduler.now()) {
      this.#scheduleRetry(record, Date.parse(nextAttemptAt) - this.#retryScheduler.now());
      return true;
    }
    if (record.delivery?.lastError === undefined) {
      return this.#scheduleDispatch(record);
    }
    const response = record.response;
    if (response === undefined) return false;
    const claimed = await this.#prepareClaimAndSchedule(
      identityFromRecord(record),
      record,
      response,
      record.delivery?.intent ?? (response.type === "cancel" ? "cancel" : "respond"),
    );
    return claimed !== undefined;
  }

  #scheduleDispatch(record: HitlRecord): boolean {
    if (this.#disposed) return false;
    const claimId = record.delivery?.claimId;
    if (claimId === undefined || record.response === undefined) {
      return false;
    }
    const dispatchKey = `${hitlIdentityKey(identityFromRecord(record))}:${claimId}`;
    if (this.#dispatchedClaims.has(dispatchKey)) return false;
    this.#dispatchedClaims.add(dispatchKey);
    void this.#dispatch(record).catch((error: unknown) => this.#logDispatchFailure(record, error));
    return true;
  }

  async #dispatch(record: HitlRecord): Promise<void> {
    let prepared: PreparedHitlResume | undefined;
    try {
      const response = record.response;
      if (response === undefined) throw new Error(`Cannot resume HITL ${record.hitlId} without a response`);
      const adapter = this.#adapterFor(record.owner);
      prepared = await adapter.prepare(record, response);
      await prepared.run(record, response);
      const identity = identityFromRecord(record);
      const terminal = await this.#withHitlLock(identity, async () => {
        const current = await this.#lookupFound(identity);
        if (current?.record.status !== "answered") return undefined;
        if (current.record.delivery?.claimId !== record.delivery?.claimId) return undefined;
        return await this.#hitl.finishResume(
          identity,
          current.record.delivery?.intent === "cancel" ? "cancelled" : "resolved",
          current.record.response,
        );
      });
      if (terminal !== undefined && "finalize" in adapter && adapter.finalize !== undefined) {
        await adapter.finalize(terminal);
      }
    } catch (error) {
      await this.#recordDispatchFailure(record, error);
    } finally {
      prepared?.release();
    }
  }

  async #recordDispatchFailure(record: HitlRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.#logger.warn("hitl.delivery.failed", {
      error,
      context: { hitlId: record.hitlId, ownerType: record.owner.ownerType, ownerId: record.owner.ownerId },
    });
    const identity = identityFromRecord(record);
    const failed = await this.#withHitlLock(identity, async () => {
      const current = await this.#lookupFound(identity);
      if (current?.record.status !== "answered") return undefined;
      if (current.record.delivery?.claimId !== record.delivery?.claimId) return undefined;
      const attempt = current.record.delivery?.attempt ?? 1;
      const retryable = !isNonRetryableDeliveryError(error);
      const delayMs = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
      const nextAttemptAt = retryable ? new Date(this.#retryScheduler.now() + delayMs).toISOString() : undefined;
      return await this.#hitl.markDeliveryFailed(identity, message, nextAttemptAt);
    });
    if (failed?.delivery?.nextAttemptAt !== undefined) {
      this.#scheduleRetry(failed, Math.max(0, Date.parse(failed.delivery.nextAttemptAt) - this.#retryScheduler.now()));
    }
  }

  #scheduleRetry(record: HitlRecord, delayMs: number): void {
    if (this.#disposed) return;
    const identity = identityFromRecord(record);
    const key = hitlIdentityKey(identity);
    const existing = this.#retryTimers.get(key);
    existing?.cancel();
    const timer = this.#retryScheduler.schedule(delayMs, async () => {
      this.#retryTimers.delete(key);
      if (this.#disposed) return;
      await this.#withHitlLock(identity, async () => {
        const current = await this.#lookupFound(identity);
        if (current?.record.status !== "answered" || current.record.response === undefined) return;
        await this.#prepareClaimAndSchedule(
          identity,
          current.record,
          current.record.response,
          current.record.delivery?.intent ?? (current.record.response.type === "cancel" ? "cancel" : "respond"),
        );
      }).catch((error: unknown) => this.#logDispatchFailure(record, error));
    });
    this.#retryTimers.set(key, timer);
  }

  #logDispatchFailure(record: HitlRecord, error: unknown): void {
    this.#logger.error("hitl.delivery.dispatch.failed", {
      error,
      context: {
        hitlId: record.hitlId,
        ownerType: record.owner.ownerType,
        ownerId: record.owner.ownerId,
        claimId: record.delivery?.claimId,
      },
    });
  }

  #adapterFor(owner: HitlOwnerKey): ResumeAdapter {
    const adapter = this.#adapters[owner.ownerType];
    if (adapter === undefined) throw new Error(`No HITL resume adapter registered for ${owner.ownerType} owner`);
    return adapter;
  }

  async #lookupFound(identity: HitlIdentity): Promise<Extract<HitlLookupResult, { status: "found" }> | undefined> {
    const found = await this.#hitl.lookup(identity);
    return found.status === "found" ? found : undefined;
  }

  async #withHitlLock<T>(identity: HitlIdentity, operation: () => Promise<T>): Promise<T> {
    const key = hitlIdentityKey(identity);
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current, () => current);
    this.#locks.set(key, chained);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === chained) this.#locks.delete(key);
    }
  }
}

function identityFromRecord(record: HitlRecord): HitlIdentity {
  return { owner: record.owner, hitlId: record.hitlId };
}

function isNonRetryableDeliveryError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "retryable" in error && error.retryable === false;
}
