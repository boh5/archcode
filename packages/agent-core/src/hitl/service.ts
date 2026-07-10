import {
  type HitlDisplayPayload,
  type GlobalSSEHitlEventPayload,
  type GlobalSSEHitlRealtimeEvent,
  type HitlOwnerKey,
  type HitlProjection,
  type HitlProjectionContext,
  type HitlRecord,
  type HitlResponse as ProtocolHitlResponse,
  type HitlResumeMetadata,
  type HitlSource,
} from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { silentLogger, type Logger } from "../logger";
import { LoopStateManager } from "../loops/state";
import type { ProjectInfo } from "../projects/types";
import type { SessionStoreManager } from "../store/session-store-manager";
import { HitlOwnerStore, type HitlCreateResult } from "./owner-store";
import { resolveHitlOwnerPath } from "./owner-paths";
import { aggregateHitlProjections, collectKnownHitlOwners, type HitlAggregationQuery } from "./aggregation";

export type HitlRealtimeListener = (event: GlobalSSEHitlRealtimeEvent) => unknown;

export interface HitlServiceManagers {
  readonly sessions?: SessionStoreManager;
  readonly goalState?: GoalStateManager;
  readonly loopState?: LoopStateManager;
}

export interface HitlServiceOptions extends HitlServiceManagers {
  readonly workspaceRoot?: string;
  readonly project?: Pick<ProjectInfo, "slug" | "name">;
  readonly realtimePublisher?: HitlRealtimeListener;
  readonly logger?: Logger;
}

export interface CreateHitlRecordInput {
  readonly owner: HitlOwnerKey;
  readonly blockingKey: string;
  readonly source: HitlSource;
  readonly displayPayload: HitlDisplayPayload;
  readonly hitlId?: string;
  readonly createdAt?: string;
}

export type HitlLookupResult =
  | { status: "found"; record: HitlRecord; owner: HitlOwnerKey }
  | { status: "missing" }
  | { status: "ambiguous"; hitlId: string; owners: HitlOwnerKey[] };

export class HitlService {
  #workspaceRoot: string | undefined;
  #project: Pick<ProjectInfo, "slug" | "name"> | undefined;
  #sessions: SessionStoreManager | undefined;
  #goalState: GoalStateManager | undefined;
  #loopState: LoopStateManager | undefined;
  #realtimePublisher: HitlRealtimeListener | undefined;
  #logger: Logger;
  readonly #localOwners = new Map<string, HitlOwnerKey>();
  readonly #realtimeListeners = new Set<HitlRealtimeListener>();

  constructor(options: HitlServiceOptions = {}) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#project = options.project;
    this.#sessions = options.sessions;
    this.#goalState = options.goalState;
    this.#loopState = options.loopState;
    this.#realtimePublisher = options.realtimePublisher;
    this.#logger = (options.logger ?? silentLogger).child({ module: "hitl" });
  }

  async load(workspaceRoot: string): Promise<void> {
    this.#workspaceRoot = workspaceRoot;
    this.#goalState ??= new GoalStateManager(workspaceRoot, silentLogger);
    this.#loopState ??= new LoopStateManager(workspaceRoot, silentLogger);
  }

  configure(options: HitlServiceOptions): void {
    this.#workspaceRoot = options.workspaceRoot ?? this.#workspaceRoot;
    this.#project = options.project ?? this.#project;
    this.#sessions = options.sessions ?? this.#sessions;
    this.#goalState = options.goalState ?? this.#goalState;
    this.#loopState = options.loopState ?? this.#loopState;
    this.#realtimePublisher = options.realtimePublisher ?? this.#realtimePublisher;
    this.#logger = options.logger?.child({ module: "hitl" }) ?? this.#logger;
  }

  async flush(): Promise<void> {
    // Owner-local writes are awaited per operation; no global queue remains.
  }

  async create(input: CreateHitlRecordInput): Promise<HitlRecord> {
    return (await this.createWithResult(input)).record;
  }

  async createWithResult(input: CreateHitlRecordInput): Promise<HitlCreateResult> {
    const now = input.createdAt ?? new Date().toISOString();
    const record: HitlRecord = {
      hitlId: input.hitlId ?? crypto.randomUUID(),
      owner: input.owner,
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

  async lookup(hitlId: string): Promise<HitlLookupResult> {
    const matches: Array<{ record: HitlRecord; owner: HitlOwnerKey }> = [];
    for (const owner of await this.#knownOwners()) {
      const result = await (await this.#storeFor(owner)).lookup(hitlId);
      if (result.status === "found") matches.push({ record: result.record, owner });
    }
    if (matches.length === 0) return { status: "missing" };
    if (matches.length > 1) return { status: "ambiguous", hitlId, owners: matches.map((match) => match.owner) };
    return { status: "found", record: matches[0]!.record, owner: matches[0]!.owner };
  }

  async claim(hitlId: string, response: ProtocolHitlResponse, resume: HitlResumeMetadata = {}): Promise<HitlRecord | undefined> {
    const found = await this.lookup(hitlId);
    if (found.status !== "found") return undefined;
    const record = await (await this.#storeFor(found.owner)).claim(hitlId, response, resume);
    await this.#publish({ type: "hitl.updated", status: record.status }, record);
    return record;
  }

  async markResumeFailed(hitlId: string, reason: string): Promise<HitlRecord | undefined> {
    const found = await this.lookup(hitlId);
    if (found.status !== "found") return undefined;
    const record = await (await this.#storeFor(found.owner)).markResumeFailed(hitlId, reason);
    await this.#publishResolved(record);
    return record;
  }

  async finishResume(
    hitlId: string,
    status: Extract<HitlRecord["status"], "resolved" | "cancelled">,
    response?: ProtocolHitlResponse,
  ): Promise<HitlRecord | undefined> {
    const found = await this.lookup(hitlId);
    if (found.status !== "found") return undefined;
    const record = await (await this.#storeFor(found.owner)).complete(hitlId, status, response);
    await this.#publishResolved(record);
    return record;
  }

  async complete(hitlId: string, response?: ProtocolHitlResponse): Promise<HitlRecord | undefined> {
    const found = await this.lookup(hitlId);
    if (found.status !== "found") return undefined;
    const record = await (await this.#storeFor(found.owner)).complete(hitlId, "resolved", response);
    await this.#publishResolved(record);
    return record;
  }

  async cancelRecord(hitlId: string, reason = "Cancelled", cancelledBy?: string): Promise<HitlRecord | undefined> {
    const found = await this.lookup(hitlId);
    if (found.status !== "found") return undefined;
    const record = await (await this.#storeFor(found.owner)).complete(hitlId, "cancelled", { type: "cancel", reason, cancelledBy });
    await this.#publishResolved(record);
    return record;
  }

  async cancelOwner(owner: HitlOwnerKey, reason = "owner_deleted"): Promise<HitlRecord[]> {
    const records = await (await this.#storeFor(owner)).cancelActive(reason);
    for (const record of records) await this.#publishResolved(record);
    return records;
  }

  async ownerStore(owner: HitlOwnerKey): Promise<HitlOwnerStore> {
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
  }

  async #publishResolved(record: HitlRecord): Promise<void> {
    if (record.status !== "resolved" && record.status !== "cancelled" && record.status !== "resume_failed") return;
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
    const projectSlug = this.#project?.slug ?? record.owner.projectSlug;
    const projectName = this.#project?.name;
    const ancestry = await this.#ancestryFor(record);
    return {
      hitlId: record.hitlId,
      project: { slug: projectSlug, ...(projectName === undefined ? {} : { name: projectName }) },
      owner: record.owner,
      ...(ancestry === undefined ? {} : { ancestry }),
      source: record.source,
      status: record.status,
      displayPayload: record.displayPayload,
      allowedActions: allowedActionsFor(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
    };
  }

  async #ancestryFor(record: HitlRecord): Promise<HitlProjectionContext | undefined> {
    const source = record.source;
    if (record.owner.ownerType === "session") return await this.#sessionAncestry(record.owner.ownerId);
    if (record.owner.ownerType === "goal") return await this.#goalAncestry(record.owner.ownerId, source);
    if (record.owner.ownerType === "loop") return { loopId: record.owner.ownerId, projectionPath: ["loop", record.owner.ownerId] };
    return undefined;
  }

  async #sessionAncestry(sessionId: string): Promise<HitlProjectionContext | undefined> {
    const sessions = this.#sessions;
    if (sessions === undefined) return { projectionPath: ["session", sessionId, sessionId] };
    try {
      const file = await sessions.getSessionFile(this.#requiredWorkspaceRoot(), sessionId);
      const ancestorSessionIds = await this.#ancestorSessionIds(file.parentSessionId, sessionId);
      return withoutUndefined({
        rootSessionId: file.rootSessionId,
        parentSessionId: file.parentSessionId,
        ancestorSessionIds,
        goalId: file.goalId,
        loopId: file.loopId,
        projectionPath: ["session", file.rootSessionId, sessionId],
      });
    } catch {
      return { projectionPath: ["session", sessionId, sessionId] };
    }
  }

  async #ancestorSessionIds(parentSessionId: string | undefined, sessionId: string): Promise<string[] | undefined> {
    const sessions = this.#sessions;
    if (sessions === undefined || parentSessionId === undefined) return undefined;
    const ancestors: string[] = [];
    let current: string | undefined = parentSessionId;
    const visited = [sessionId];
    while (current !== undefined && !visited.includes(current)) {
      ancestors.push(current);
      visited.push(current);
      try {
        const file = await sessions.getSessionFile(this.#requiredWorkspaceRoot(), current);
        current = file.parentSessionId;
      } catch {
        break;
      }
    }
    return ancestors.length === 0 ? undefined : ancestors;
  }

  async #goalAncestry(goalId: string, source: HitlSource): Promise<HitlProjectionContext> {
    let loopId = "loopId" in source ? source.loopId : undefined;
    if (loopId === undefined && this.#goalState !== undefined) {
      try {
        loopId = (await this.#goalState.read(goalId)).loopId;
      } catch {
        loopId = undefined;
      }
    }
    return withoutUndefined({ goalId, loopId, projectionPath: loopId === undefined ? ["goal", goalId] : ["loop", loopId, "goal", goalId] });
  }

  async #storeFor(owner: HitlOwnerKey): Promise<HitlOwnerStore> {
    const workspaceRoot = this.#requiredWorkspaceRoot();
    const filePath = await resolveHitlOwnerPath(workspaceRoot, owner, {
      goalState: this.#goalState,
      loopState: this.#loopState,
    });
    return new HitlOwnerStore(filePath, owner);
  }

  async #knownOwners(): Promise<HitlOwnerKey[]> {
    const context = this.#aggregationContext();
    const owners = new Map<string, HitlOwnerKey>();
    for (const owner of this.#localOwners.values()) owners.set(ownerKey(owner), owner);
    for (const owner of await collectKnownHitlOwners(context)) owners.set(ownerKey(owner), owner);
    return [...owners.values()];
  }

  #aggregationContext() {
    if (this.#sessions === undefined) throw new Error("SessionStoreManager is required for HITL aggregation and lookup");
    if (this.#goalState === undefined) throw new Error("GoalStateManager is required for HITL aggregation and lookup");
    if (this.#loopState === undefined) throw new Error("LoopStateManager is required for HITL aggregation and lookup");
    return {
      workspaceRoot: this.#requiredWorkspaceRoot(),
      project: this.#project ?? { slug: "unknown-project" },
      sessions: this.#sessions,
      goalState: this.#goalState,
      loopState: this.#loopState,
    };
  }

  #requiredWorkspaceRoot(): string {
    if (this.#workspaceRoot === undefined) throw new Error("HitlService must be loaded with a workspaceRoot before use");
    return this.#workspaceRoot;
  }
}

function ownerKey(owner: HitlOwnerKey): string {
  return `${owner.projectSlug}:${owner.ownerType}:${owner.ownerId}`;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function allowedActionsFor(record: HitlRecord): HitlProjection["allowedActions"] {
  if (record.status === "resume_failed") return ["retry_resume", "cancel"];
  if (record.status !== "pending") return [];
  switch (record.source.type) {
    case "ask_user":
    case "goal_question":
    case "loop_question":
      return ["answer", "cancel"];
    case "tool_permission":
      return ["approve", "deny", "cancel"];
    case "goal_approval":
    case "goal_budget":
    case "loop_approval":
      return ["approve", "deny", "cancel"];
    case "goal_review":
      return ["approve", "deny", "cancel"];
    case "loop_blocker":
    case "loop_retry":
      return ["approve", "cancel"];
  }
}
