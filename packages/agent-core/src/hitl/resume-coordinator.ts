import { hitlIdentityKey, type HitlIdentity, type HitlOwnerKey, type HitlRecord, type HitlResponse } from "@archcode/protocol";

import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { HitlService, type HitlLookupResult } from "./service";

export interface SessionHitlResumeAdapter {
  resume(record: HitlRecord, response: HitlResponse): Promise<void>;
  /** Runs only after the owner record is durably terminal. */
  finalize?(record: HitlRecord): Promise<void>;
}

export interface GoalHitlResumeAdapter {
  resume(record: HitlRecord, response: HitlResponse): Promise<void>;
}

export interface LoopHitlResumeAdapter {
  resume(record: HitlRecord, response: HitlResponse): Promise<void>;
}

export interface ResumeCoordinatorAdapters {
  readonly session?: SessionHitlResumeAdapter;
  readonly goal?: GoalHitlResumeAdapter;
  readonly loop?: LoopHitlResumeAdapter;
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

type ResumeAdapter = SessionHitlResumeAdapter | GoalHitlResumeAdapter | LoopHitlResumeAdapter;

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
            return this.#scheduleDispatch(current.record);
          }
          if (current.record.status === "resume_failed" && current.record.response !== undefined) {
            const claimed = await this.#hitl.claim(identity, current.record.response, {
              claimId: crypto.randomUUID(),
              claimedAt: new Date().toISOString(),
              intent: current.record.resume?.intent ?? (current.record.response.type === "cancel" ? "cancel" : "respond"),
              attempt: (current.record.resume?.attempt ?? 0) + 1,
            });
            if (claimed === undefined) return false;
            return this.#scheduleDispatch(claimed);
          }
          return false;
        });
        if (result) scheduled += 1;
      }
    }

    // Durable claims and owner-local blockers are the readiness boundary.
    // Adapter work may include a full agent or Loop run, so recovery only
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
        const claimed = await this.#hitl.claim(identity, response, {
          claimId: crypto.randomUUID(),
          claimedAt: new Date().toISOString(),
          intent,
          attempt: (current.resume?.attempt ?? 0) + 1,
        });
        if (claimed === undefined) return { status: "missing", scheduled: false };
        return { status: "claimed", scheduled: this.#scheduleDispatch(claimed), record: claimed };
      }
      if (current.status !== "pending") {
        return { status: "active", scheduled: false, record: current };
      }

      const claimed = await this.#hitl.claim(identity, response, {
        claimId: crypto.randomUUID(),
        claimedAt: new Date().toISOString(),
        intent,
        attempt: (current.resume?.attempt ?? 0) + 1,
      });
      if (claimed === undefined) return { status: "missing", scheduled: false };
      const scheduled = this.#scheduleDispatch(claimed);
      return { status: "claimed", scheduled, record: claimed };
    });
  }

  #scheduleDispatch(record: HitlRecord): boolean {
    const completion = this.#beginDispatch(record);
    if (completion === undefined) return false;
    void completion.catch((error: unknown) => {
      this.#logger.error("hitl.resume.dispatch.failed", {
        error,
        context: {
          hitlId: record.hitlId,
          ownerType: record.owner.ownerType,
          ownerId: record.owner.ownerId,
          claimId: record.resume?.claimId,
        },
      });
    });
    return true;
  }

  #beginDispatch(record: HitlRecord): Promise<void> | undefined {
    const claimId = record.resume?.claimId;
    if (claimId === undefined || record.response === undefined) return undefined;
    const dispatchKey = `${hitlIdentityKey(identityFromRecord(record))}:${claimId}`;
    if (this.#dispatchedClaims.has(dispatchKey)) return undefined;
    this.#dispatchedClaims.add(dispatchKey);
    return this.#dispatch(record);
  }

  async #dispatch(record: HitlRecord): Promise<void> {
    try {
      const response = record.response;
      if (response === undefined) throw new Error(`Cannot resume HITL ${record.hitlId} without a response`);
      const adapter = this.#adapterFor(record.owner);
      await adapter.resume(record, response);
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
