import {
  type HitlDisplayPayload,
  type HitlOwnerKey,
  type HitlProjection,
  type HitlRecord,
  type HitlResponse as ProtocolHitlResponse,
  type HitlSource,
} from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { silentLogger } from "../logger";
import { LoopStateManager } from "../loops/state";
import type { ProjectInfo } from "../projects/types";
import type { SessionStoreManager } from "../store/session-store-manager";
import { HitlOwnerStore } from "./owner-store";
import { resolveHitlOwnerPath } from "./owner-paths";
import { aggregateHitlProjections, collectKnownHitlOwners, type HitlAggregationQuery } from "./aggregation";

export interface HitlServiceManagers {
  readonly sessions?: SessionStoreManager;
  readonly goalState?: GoalStateManager;
  readonly loopState?: LoopStateManager;
}

export interface HitlServiceOptions extends HitlServiceManagers {
  readonly workspaceRoot?: string;
  readonly project?: Pick<ProjectInfo, "slug" | "name">;
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
  readonly #localOwners = new Map<string, HitlOwnerKey>();

  constructor(options: HitlServiceOptions = {}) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#project = options.project;
    this.#sessions = options.sessions;
    this.#goalState = options.goalState;
    this.#loopState = options.loopState;
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
  }

  async flush(): Promise<void> {
    // Owner-local writes are awaited per operation; no global queue remains.
  }

  async create(input: CreateHitlRecordInput): Promise<HitlRecord> {
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
    return result.record;
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

  async claim(hitlId: string, response: ProtocolHitlResponse): Promise<HitlRecord | undefined> {
    const found = await this.lookup(hitlId);
    if (found.status !== "found") return undefined;
    return await (await this.#storeFor(found.owner)).claim(hitlId, response);
  }

  async markResumeFailed(hitlId: string, reason: string): Promise<HitlRecord | undefined> {
    const found = await this.lookup(hitlId);
    if (found.status !== "found") return undefined;
    return await (await this.#storeFor(found.owner)).markResumeFailed(hitlId, reason);
  }

  async finishResume(
    hitlId: string,
    status: Extract<HitlRecord["status"], "resolved" | "cancelled">,
    response?: ProtocolHitlResponse,
  ): Promise<HitlRecord | undefined> {
    const found = await this.lookup(hitlId);
    if (found.status !== "found") return undefined;
    return await (await this.#storeFor(found.owner)).complete(hitlId, status, response);
  }

  async complete(hitlId: string, response?: ProtocolHitlResponse): Promise<HitlRecord | undefined> {
    const found = await this.lookup(hitlId);
    if (found.status !== "found") return undefined;
    return await (await this.#storeFor(found.owner)).complete(hitlId, "resolved", response);
  }

  async cancelRecord(hitlId: string, reason = "Cancelled", cancelledBy?: string): Promise<HitlRecord | undefined> {
    const found = await this.lookup(hitlId);
    if (found.status !== "found") return undefined;
    return await (await this.#storeFor(found.owner)).complete(hitlId, "cancelled", { type: "cancel", reason, cancelledBy });
  }

  async cancelOwner(owner: HitlOwnerKey, reason = "owner_deleted"): Promise<HitlRecord[]> {
    return await (await this.#storeFor(owner)).cancelActive(reason);
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
