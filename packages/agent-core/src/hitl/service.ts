import {
  type HitlDisplayPayload,
  type GlobalSSEHitlEventPayload,
  type GlobalSSEHitlRealtimeEvent,
  type HitlIdentity,
  type HitlOwnerKey,
  type HitlProjection,
  type HitlProjectionContext,
  type HitlRecord,
  type HitlResponse as ProtocolHitlResponse,
  type HitlDeliveryMetadata,
  type HitlSource,
} from "@archcode/protocol";

import type { GoalStateManager } from "../goals/state";
import { silentLogger, type Logger } from "../logger";
import type { ProjectInfo } from "../projects/types";
import type { SessionStoreManager } from "../store/session-store-manager";
import { HitlOwnerStore, HitlRecordStateError, type HitlCreateResult } from "./owner-store";
import { resolveHitlOwnerPath } from "./owner-paths";
import { aggregateHitlProjections, collectKnownHitlOwners, toHitlProjection, type HitlAggregationQuery } from "./aggregation";

export type HitlRealtimeListener = (event: GlobalSSEHitlRealtimeEvent) => unknown;

export interface HitlServiceManagers {
  readonly sessions: SessionStoreManager;
  readonly goalState: GoalStateManager;
}

export interface HitlServiceOptions extends HitlServiceManagers {
  readonly workspaceRoot: string;
  readonly project: Pick<ProjectInfo, "slug" | "name">;
  readonly realtimePublisher?: HitlRealtimeListener;
  readonly logger?: Logger;
}

export interface CreateHitlRecordInput {
  readonly owner: HitlOwnerKey;
  readonly sessionRootId?: string;
  readonly blockingKey: string;
  readonly source: HitlSource;
  readonly displayPayload: HitlDisplayPayload;
  readonly hitlId?: string;
  readonly createdAt?: string;
}

export type HitlLookupResult =
  | { status: "found"; record: HitlRecord; owner: HitlOwnerKey }
  | { status: "missing" };

export class HitlService {
  readonly #workspaceRoot: string;
  readonly #project: Pick<ProjectInfo, "slug" | "name">;
  readonly #sessions: SessionStoreManager;
  readonly #goalState: GoalStateManager;
  #realtimePublisher: HitlRealtimeListener | undefined;
  #logger: Logger;
  readonly #localOwners = new Map<string, HitlOwnerKey>();
  readonly #realtimeListeners = new Set<HitlRealtimeListener>();

  constructor(options: HitlServiceOptions) {
    if (options.workspaceRoot === undefined || options.workspaceRoot.length === 0) {
      throw new TypeError("HitlService requires workspaceRoot");
    }
    if (options.project === undefined) throw new TypeError("HitlService requires project");
    if (options.sessions === undefined) throw new TypeError("HitlService requires sessions");
    if (options.goalState === undefined) throw new TypeError("HitlService requires goalState");
    this.#workspaceRoot = options.workspaceRoot;
    this.#project = options.project;
    this.#sessions = options.sessions;
    this.#goalState = options.goalState;
    this.#realtimePublisher = options.realtimePublisher;
    this.#logger = (options.logger ?? silentLogger).child({ module: "hitl" });
  }

  async create(input: CreateHitlRecordInput): Promise<HitlRecord> {
    return (await this.createWithResult(input)).record;
  }

  async createWithResult(input: CreateHitlRecordInput): Promise<HitlCreateResult> {
    this.#assertProjectOwner(input.owner);
    const now = input.createdAt ?? new Date().toISOString();
    const record: HitlRecord = {
      hitlId: input.hitlId ?? crypto.randomUUID(),
      owner: input.owner,
      ...(input.sessionRootId === undefined ? {} : { sessionRootId: input.sessionRootId }),
      blockingKey: input.blockingKey,
      source: input.source,
      status: "pending",
      displayPayload: input.displayPayload,
      createdAt: now,
      updatedAt: now,
    };
    const result = await (await this.#storeFor(input.owner)).create(record);
    this.#localOwners.set(ownerKey(result.record.owner), result.record.owner);
    return result;
  }

  subscribeRealtimeEvents(listener: HitlRealtimeListener): () => void {
    this.#realtimeListeners.add(listener);
    return () => {
      this.#realtimeListeners.delete(listener);
    };
  }

  async publishRequest(record: HitlRecord): Promise<void> {
    await this.#publish({ type: "hitl.request", status: "pending" }, record);
  }

  async lookup(identity: HitlIdentity): Promise<HitlLookupResult> {
    this.#assertProjectOwner(identity.owner);
    const result = await (await this.#storeFor(identity.owner)).lookup(identity.hitlId);
    if (result.status === "missing") return result;
    return { status: "found", record: result.record, owner: identity.owner };
  }

  async claim(identity: HitlIdentity, response: ProtocolHitlResponse, delivery: HitlDeliveryMetadata): Promise<HitlRecord | undefined> {
    const found = await this.lookup(identity);
    if (found.status !== "found") return undefined;
    let record: HitlRecord;
    try {
      record = await (await this.#storeFor(identity.owner)).claim(identity.hitlId, response, delivery);
    } catch (error) {
      if (!(error instanceof HitlRecordStateError)) throw error;
      const latest = await this.lookup(identity);
      if (latest.status === "missing" || latest.record.status === "resolved" || latest.record.status === "cancelled") return undefined;
      if (latest.record.status === "answered") return latest.record;
      throw error;
    }
    await this.#publish({ type: "hitl.updated", status: record.status }, record);
    return record;
  }

  async markDeliveryFailed(identity: HitlIdentity, reason: string, nextAttemptAt?: string): Promise<HitlRecord | undefined> {
    const found = await this.lookup(identity);
    if (found.status !== "found") return undefined;
    const record = await (await this.#storeFor(identity.owner)).markDeliveryFailed(identity.hitlId, reason, nextAttemptAt);
    await this.#publish({ type: "hitl.updated", status: record.status }, record);
    return record;
  }

  async finishResume(
    identity: HitlIdentity,
    status: Extract<HitlRecord["status"], "resolved" | "cancelled">,
    response?: ProtocolHitlResponse,
  ): Promise<HitlRecord | undefined> {
    const found = await this.lookup(identity);
    if (found.status !== "found") return undefined;
    const record = await (await this.#storeFor(identity.owner)).complete(identity.hitlId, status, response);
    await this.#publishResolved(record);
    return record;
  }

  async complete(identity: HitlIdentity, response?: ProtocolHitlResponse): Promise<HitlRecord | undefined> {
    const found = await this.lookup(identity);
    if (found.status !== "found") return undefined;
    const record = await (await this.#storeFor(identity.owner)).complete(identity.hitlId, "resolved", response);
    await this.#publishResolved(record);
    return record;
  }

  async cancelRecord(identity: HitlIdentity, reason = "Cancelled", cancelledBy?: string): Promise<HitlRecord | undefined> {
    const found = await this.lookup(identity);
    if (found.status !== "found") return undefined;
    const record = await (await this.#storeFor(identity.owner)).complete(identity.hitlId, "cancelled", { type: "cancel", reason, cancelledBy });
    await this.#publishResolved(record);
    return record;
  }

  async cancelOwner(owner: HitlOwnerKey, reason = "owner_deleted"): Promise<HitlRecord[]> {
    this.#assertProjectOwner(owner);
    const records = await (await this.#storeFor(owner)).cancelActive(reason);
    for (const record of records) await this.#publishResolved(record);
    return records;
  }

  async ownerStore(owner: HitlOwnerKey): Promise<HitlOwnerStore> {
    this.#assertProjectOwner(owner);
    return await this.#storeFor(owner);
  }

  async knownOwners(): Promise<HitlOwnerKey[]> {
    return await this.#knownOwners();
  }

  async list(query: HitlAggregationQuery = { scope: "project" }): Promise<HitlProjection[]> {
    const context = this.#aggregationContext();
    return await aggregateHitlProjections(context, query);
  }

  shutdown(): void {
    // Owner-local writes are committed per operation; no in-memory waiters remain.
    this.#realtimeListeners.clear();
    this.#realtimePublisher = undefined;
  }

  async #publishResolved(record: HitlRecord): Promise<void> {
    if (record.status !== "resolved" && record.status !== "cancelled") return;
    await this.#publish({
      type: "hitl.resolved",
      status: record.status,
    }, record);
  }

  async #publish(payload: GlobalSSEHitlEventPayload, record: HitlRecord): Promise<void> {
    if (this.#realtimeListeners.size === 0 && this.#realtimePublisher === undefined) return;
    let event: GlobalSSEHitlRealtimeEvent;
    try {
      event = {
        type: "hitl.event",
        projectSlug: record.owner.projectSlug,
        owner: record.owner,
        hitlId: record.hitlId,
        createdAt: Date.now(),
        payload,
        projection: await this.#projectionFor(record),
      };
    } catch (error) {
      this.#logger.warn("hitl.realtime.projection_failed", {
        error,
        context: { hitlId: record.hitlId, ownerType: record.owner.ownerType, ownerId: record.owner.ownerId },
      });
      return;
    }

    if (this.#realtimePublisher !== undefined) this.#deliverRealtime("publisher", this.#realtimePublisher, event, record);
    for (const listener of this.#realtimeListeners) {
      this.#deliverRealtime("listener", listener, event, record);
    }
  }

  #deliverRealtime(
    kind: "publisher" | "listener",
    listener: HitlRealtimeListener,
    event: GlobalSSEHitlRealtimeEvent,
    record: HitlRecord,
  ): void {
    const logFailure = (error: unknown): void => {
      this.#logger.warn(`hitl.realtime.${kind}_failed`, {
        error,
        context: { hitlId: record.hitlId, ownerType: record.owner.ownerType, ownerId: record.owner.ownerId },
      });
    };
    try {
      const result = listener(event);
      if (result instanceof Promise) void result.catch(logFailure);
    } catch (error) {
      logFailure(error);
    }
  }

  async #projectionFor(record: HitlRecord): Promise<HitlProjection> {
    const ancestry = await this.#ancestryFor(record);
    return toHitlProjection(this.#project, record, ancestry);
  }

  async #ancestryFor(record: HitlRecord): Promise<HitlProjectionContext> {
    const source = record.source;
    if (record.owner.ownerType === "session") return await this.#sessionAncestry(record.owner.ownerId);
    if (record.owner.ownerType === "goal") return await this.#goalAncestry(record.owner.ownerId, source);
    throw new Error("Unsupported HITL owner type");
  }

  async #sessionAncestry(sessionId: string): Promise<HitlProjectionContext> {
    const file = await this.#sessions.getSessionFile(this.#workspaceRoot, sessionId);
    const ancestorSessionIds = await this.#ancestorSessionIds(file.parentSessionId, sessionId);
    return withoutUndefined({
      rootSessionId: file.rootSessionId,
      parentSessionId: file.parentSessionId,
      ancestorSessionIds,
      goalId: file.goalId,
      projectionPath: ["session", file.rootSessionId, sessionId],
    });
  }

  async #ancestorSessionIds(parentSessionId: string | undefined, sessionId: string): Promise<string[] | undefined> {
    if (parentSessionId === undefined) return undefined;
    const ancestors: string[] = [];
    let current: string | undefined = parentSessionId;
    const visited = [sessionId];
    while (current !== undefined && !visited.includes(current)) {
      ancestors.push(current);
      visited.push(current);
      const file = await this.#sessions.getSessionFile(this.#workspaceRoot, current);
      current = file.parentSessionId;
    }
    return ancestors.length === 0 ? undefined : ancestors;
  }

  async #goalAncestry(goalId: string, _source: HitlSource): Promise<HitlProjectionContext> {
    await this.#goalState.read(goalId);
    return { goalId, projectionPath: ["goal", goalId] };
  }

  async #storeFor(owner: HitlOwnerKey): Promise<HitlOwnerStore> {
    const filePath = await resolveHitlOwnerPath(this.#workspaceRoot, owner, {
      goalState: this.#goalState,
    });
    return new HitlOwnerStore(filePath, owner);
  }

  #assertProjectOwner(owner: HitlOwnerKey): void {
    if (owner.projectSlug !== this.#project.slug) {
      throw new TypeError(`HITL owner project ${owner.projectSlug} does not match service project ${this.#project.slug}`);
    }
  }

  async #knownOwners(): Promise<HitlOwnerKey[]> {
    const context = this.#aggregationContext();
    const owners = new Map<string, HitlOwnerKey>();
    for (const owner of this.#localOwners.values()) owners.set(ownerKey(owner), owner);
    for (const owner of await collectKnownHitlOwners(context)) owners.set(ownerKey(owner), owner);
    return [...owners.values()];
  }

  #aggregationContext() {
    return {
      workspaceRoot: this.#workspaceRoot,
      project: this.#project,
      sessions: this.#sessions,
      goalState: this.#goalState,
    };
  }

}

function ownerKey(owner: HitlOwnerKey): string {
  return `${owner.projectSlug}:${owner.ownerType}:${owner.ownerId}`;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
