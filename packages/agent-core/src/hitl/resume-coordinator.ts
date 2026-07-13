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

export interface ResumeCoordinatorOptions {
  readonly hitl: HitlService;
  readonly adapters?: ResumeCoordinatorAdapters;
  readonly logger?: Logger;
}

export type ResumeIntent = "respond" | "cancel";

export type ResumeCoordinatorResult =
  | { status: "missing"; scheduled: false }
  | { status: "claimed" | "terminal" | "active"; scheduled: boolean; record: HitlRecord };

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
  readonly #locks = new Map<string, Promise<void>>();
  readonly #dispatchedClaims = new Set<string>();

  constructor(options: ResumeCoordinatorOptions) {
    this.#hitl = options.hitl;
    this.#adapters = options.adapters ?? {};
    this.#logger = (options.logger ?? silentLogger).child({ module: "hitl.resume" });
  }

  async respond(identity: HitlIdentity, response: HitlResponse): Promise<ResumeCoordinatorResult> {
    return await this.#claimAndSchedule(identity, response, "respond");
  }

  async cancel(identity: HitlIdentity, reason = "Cancelled", cancelledBy?: string): Promise<ResumeCoordinatorResult> {
    return await this.#claimAndSchedule(identity, { type: "cancel", reason, cancelledBy }, "cancel");
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
        if (record.status !== "resume_claimed" && record.status !== "resume_failed") continue;
        if (record.response === undefined) {
          missingResponse += 1;
          continue;
        }

        const identity = identityFromRecord(record);
        const result = await this.#withHitlLock(identity, async () => {
          const current = await this.#lookupFound(identity);
          if (current === undefined) return false;
          if (current.record.status === "resume_claimed") {
            return await this.#prepareRecoveredDispatch(current.record);
          }
          if (current.record.status === "resume_failed" && current.record.response !== undefined) {
            return await this.#prepareClaimAndSchedule(
              identity,
              current.record,
              current.record.response,
              current.record.resume?.intent ?? (current.record.response.type === "cancel" ? "cancel" : "respond"),
            ) !== undefined;
          }
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
      if (current.status === "resume_claimed") {
        return { status: "claimed", scheduled: false, record: current };
      }
      if (current.status === "resume_failed" && intent === "cancel") {
        const prepared = await this.#prepareClaimAndSchedule(identity, current, response, intent);
        if (prepared === undefined) return { status: "missing", scheduled: false };
        return { status: "claimed", scheduled: prepared.scheduled, record: prepared.record };
      }
      if (current.status !== "pending") {
        return { status: "active", scheduled: false, record: current };
      }

      const prepared = await this.#prepareClaimAndSchedule(identity, current, response, intent);
      if (prepared === undefined) return { status: "missing", scheduled: false };
      return { status: "claimed", scheduled: prepared.scheduled, record: prepared.record };
    });
  }

  async #prepareClaimAndSchedule(
    identity: HitlIdentity,
    current: HitlRecord,
    response: HitlResponse,
    intent: ResumeIntent,
  ): Promise<{ readonly record: HitlRecord; readonly scheduled: boolean } | undefined> {
    const prepared = await this.#adapterFor(current.owner).prepare(current, response);
    try {
      const claimed = await this.#hitl.claim(identity, response, {
        claimId: crypto.randomUUID(),
        claimedAt: new Date().toISOString(),
        intent,
        attempt: (current.resume?.attempt ?? 0) + 1,
      });
      if (claimed === undefined) {
        prepared.release();
        return undefined;
      }
      const scheduled = this.#scheduleDispatch(claimed, prepared);
      return { record: claimed, scheduled };
    } catch (error) {
      prepared.release();
      throw error;
    }
  }

  async #prepareRecoveredDispatch(record: HitlRecord): Promise<boolean> {
    if (this.#isDispatched(record)) return false;
    try {
      const response = record.response;
      if (response === undefined) return false;
      const prepared = await this.#adapterFor(record.owner).prepare(record, response);
      return this.#scheduleDispatch(record, prepared);
    } catch (error) {
      void this.#recordDispatchFailure(record, error).catch((failure: unknown) => {
        this.#logDispatchFailure(record, failure);
      });
      return true;
    }
  }

  #scheduleDispatch(record: HitlRecord, prepared: PreparedHitlResume): boolean {
    const completion = this.#beginDispatch(record, prepared);
    if (completion === undefined) return false;
    void completion.catch((error: unknown) => {
      this.#logDispatchFailure(record, error);
    });
    return true;
  }

  #beginDispatch(record: HitlRecord, prepared: PreparedHitlResume): Promise<void> | undefined {
    const claimId = record.resume?.claimId;
    if (claimId === undefined || record.response === undefined) {
      prepared.release();
      return undefined;
    }
    const dispatchKey = `${hitlIdentityKey(identityFromRecord(record))}:${claimId}`;
    if (this.#dispatchedClaims.has(dispatchKey)) {
      prepared.release();
      return undefined;
    }
    this.#dispatchedClaims.add(dispatchKey);
    return this.#dispatch(record, prepared);
  }

  async #dispatch(record: HitlRecord, prepared: PreparedHitlResume): Promise<void> {
    try {
      const response = record.response;
      if (response === undefined) throw new Error(`Cannot resume HITL ${record.hitlId} without a response`);
      const adapter = this.#adapterFor(record.owner);
      await prepared.run(record, response);
      const identity = identityFromRecord(record);
      const terminal = await this.#withHitlLock(identity, async () => {
        const current = await this.#lookupFound(identity);
        if (current?.record.status !== "resume_claimed") return undefined;
        if (current.record.resume?.claimId !== record.resume?.claimId) return undefined;
        return await this.#hitl.finishResume(
          identity,
          current.record.resume?.intent === "cancel" ? "cancelled" : "resolved",
          current.record.response,
        );
      });
      if (terminal !== undefined && "finalize" in adapter && adapter.finalize !== undefined) {
        await adapter.finalize(terminal);
      }
    } catch (error) {
      await this.#recordDispatchFailure(record, error);
    } finally {
      prepared.release();
    }
  }

  async #recordDispatchFailure(record: HitlRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.#logger.warn("hitl.resume.failed", {
      error,
      context: { hitlId: record.hitlId, ownerType: record.owner.ownerType, ownerId: record.owner.ownerId },
    });
    const identity = identityFromRecord(record);
    await this.#withHitlLock(identity, async () => {
      const current = await this.#lookupFound(identity);
      if (current?.record.status !== "resume_claimed") return;
      if (current.record.resume?.claimId !== record.resume?.claimId) return;
      await this.#hitl.markResumeFailed(identity, message);
    });
  }

  #isDispatched(record: HitlRecord): boolean {
    const claimId = record.resume?.claimId;
    return claimId !== undefined
      && this.#dispatchedClaims.has(`${hitlIdentityKey(identityFromRecord(record))}:${claimId}`);
  }

  #logDispatchFailure(record: HitlRecord, error: unknown): void {
    this.#logger.error("hitl.resume.dispatch.failed", {
      error,
      context: {
        hitlId: record.hitlId,
        ownerType: record.owner.ownerType,
        ownerId: record.owner.ownerId,
        claimId: record.resume?.claimId,
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
