import { join } from "node:path";

import {
  PROJECT_STATE_DIR_NAME,
  type HitlAllowedAction,
  type HitlDisplayPayload,
  type HitlOwner,
  type HitlResponse,
  type HitlSource,
  type HitlStatus,
  type HitlView,
} from "@archcode/protocol";
import { sortJsonValue } from "@archcode/utils";
import { z } from "zod/v4";

import { atomicWrite } from "../utils/safe-file";

export const MAX_HITL_DELIVERY_ATTEMPTS = 3;

export interface HitlDelivery {
  readonly attempts: number;
  readonly retryAt?: string;
  readonly error?: string;
}

export interface HitlRecord {
  readonly hitlId: string;
  readonly requestKey: string;
  readonly owner: HitlOwner;
  readonly source: HitlSource;
  readonly status: HitlStatus;
  readonly displayPayload: HitlDisplayPayload;
  readonly response?: HitlResponse;
  readonly delivery?: HitlDelivery;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
}

export type ProjectHitlQueueEvent =
  | { readonly type: "hitl.created"; readonly view: HitlView }
  | { readonly type: "hitl.answered"; readonly view: HitlView }
  | { readonly type: "hitl.delivery"; readonly view: HitlView }
  | { readonly type: "hitl.resolved"; readonly view: HitlView }
  | { readonly type: "hitl.cancelled"; readonly view: HitlView };

export interface CreateHitlInput {
  readonly requestKey: string;
  readonly owner: HitlOwner;
  readonly source: HitlSource;
  readonly displayPayload: HitlDisplayPayload;
  readonly hitlId?: string;
  readonly createdAt?: string;
}

export interface HitlListFilter {
  readonly owner?: HitlOwner;
  readonly statuses?: readonly HitlStatus[];
}

export type ResolveHitlOutcome =
  | { readonly type: "dispatching" }
  | { readonly type: "delivery_failed"; readonly error: string; readonly retryAt?: string }
  | { readonly type: "applied" };

export interface ProjectHitlQueueOptions {
  readonly workspaceRoot: string;
  readonly onEvent?: (event: ProjectHitlQueueEvent) => unknown;
  readonly now?: () => Date;
}

interface ProjectHitlFile {
  readonly records: HitlRecord[];
  readonly updatedAt: string;
}

const NonEmptyStringSchema = z.string().trim().min(1);

const HitlOwnerSchema: z.ZodType<HitlOwner> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("session"), id: NonEmptyStringSchema }),
  z.strictObject({ type: z.literal("goal"), id: NonEmptyStringSchema }),
]);

const HitlSourceSchema: z.ZodType<HitlSource> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ask_user"), toolCallId: NonEmptyStringSchema }),
  z.strictObject({ type: z.literal("tool_permission"), toolCallId: NonEmptyStringSchema, toolName: NonEmptyStringSchema }),
  z.strictObject({ type: z.literal("goal_budget"), approvalPoint: NonEmptyStringSchema }),
]);

const HitlDisplayPayloadSchema: z.ZodType<HitlDisplayPayload> = z.strictObject({
  title: NonEmptyStringSchema,
  summary: z.string().optional(),
  fields: z.array(z.strictObject({ label: z.string(), value: z.string() })).optional(),
  questions: z.array(z.strictObject({
    question: z.string(),
    header: z.string(),
    options: z.array(z.strictObject({ label: z.string(), description: z.string() })).optional(),
    multiple: z.boolean().optional(),
    custom: z.boolean(),
  })).optional(),
  redacted: z.literal(true),
});

const HitlResponseSchema: z.ZodType<HitlResponse> = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("question_answer"),
    answers: z.array(z.string()),
    comment: z.string().optional(),
    answeredBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("permission_decision"),
    decision: z.enum(["approve_once", "approve_always", "deny"]),
    comment: z.string().optional(),
    decidedBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("budget_decision"),
    decision: z.enum(["approved", "denied"]),
    comment: z.string().optional(),
    decidedBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("cancel"),
    reason: NonEmptyStringSchema,
    cancelledBy: z.string().optional(),
  }),
]);

const HitlDeliverySchema: z.ZodType<HitlDelivery> = z.strictObject({
  attempts: z.number().int().min(0).max(MAX_HITL_DELIVERY_ATTEMPTS),
  retryAt: NonEmptyStringSchema.optional(),
  error: NonEmptyStringSchema.optional(),
});

const HitlRecordSchema: z.ZodType<HitlRecord> = z.strictObject({
  hitlId: NonEmptyStringSchema,
  requestKey: NonEmptyStringSchema,
  owner: HitlOwnerSchema,
  source: HitlSourceSchema,
  status: z.enum(["pending", "answered", "resolved", "cancelled"]),
  displayPayload: HitlDisplayPayloadSchema,
  response: HitlResponseSchema.optional(),
  delivery: HitlDeliverySchema.optional(),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
  resolvedAt: NonEmptyStringSchema.optional(),
}).superRefine((record, ctx) => {
  const sessionSource = record.source.type === "ask_user" || record.source.type === "tool_permission";
  if ((record.owner.type === "session") !== sessionSource) {
    ctx.addIssue({ code: "custom", path: ["source"], message: `${record.source.type} does not belong to ${record.owner.type}` });
  }
  const hasAcceptedResponse = record.status !== "pending";
  if (hasAcceptedResponse !== (record.response !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["response"], message: `${record.status} has invalid response presence` });
  }
  const isTerminal = record.status === "resolved" || record.status === "cancelled";
  if (isTerminal !== (record.resolvedAt !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["resolvedAt"], message: `${record.status} has invalid resolvedAt presence` });
  }
  if (record.delivery !== undefined && record.status !== "answered") {
    ctx.addIssue({ code: "custom", path: ["delivery"], message: "Only answered HITL may carry delivery metadata" });
  }
  if (record.delivery?.retryAt !== undefined && record.delivery.error === undefined) {
    ctx.addIssue({ code: "custom", path: ["delivery", "retryAt"], message: "retryAt requires a delivery error" });
  }
});

const ProjectHitlFileSchema: z.ZodType<ProjectHitlFile> = z.strictObject({
  records: z.array(HitlRecordSchema),
  updatedAt: NonEmptyStringSchema,
}).superRefine((file, ctx) => {
  const hitlIds = new Set<string>();
  const requestKeys = new Set<string>();
  file.records.forEach((record, index) => {
    if (hitlIds.has(record.hitlId)) ctx.addIssue({ code: "custom", path: ["records", index, "hitlId"], message: "Duplicate hitlId" });
    if (requestKeys.has(record.requestKey)) ctx.addIssue({ code: "custom", path: ["records", index, "requestKey"], message: "Duplicate requestKey" });
    hitlIds.add(record.hitlId);
    requestKeys.add(record.requestKey);
  });
});

const queueMutationLocks = new Map<string, Promise<void>>();

export class HitlConflictError extends Error {
  constructor(public readonly hitlId: string, message: string) {
    super(message);
    this.name = "HitlConflictError";
  }
}

export class HitlNotFoundError extends Error {
  constructor(public readonly hitlId: string) {
    super(`HITL ${hitlId} was not found`);
    this.name = "HitlNotFoundError";
  }
}

export class ProjectHitlQueue {
  readonly #filePath: string;
  readonly #onEvent: ProjectHitlQueueOptions["onEvent"];
  readonly #now: () => Date;

  constructor(options: ProjectHitlQueueOptions) {
    if (options.workspaceRoot.trim().length === 0) throw new TypeError("ProjectHitlQueue requires workspaceRoot");
    this.#filePath = projectHitlQueuePath(options.workspaceRoot);
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: CreateHitlInput): Promise<{ created: boolean; record: HitlRecord }> {
    const parsedInput = parseCreateInput(input);
    const result = await this.#mutate((file) => {
      const existing = file.records.find((record) => record.requestKey === parsedInput.requestKey);
      if (existing !== undefined) {
        if (!sameCreateIntent(existing, parsedInput)) {
          throw new HitlConflictError(existing.hitlId, `requestKey ${parsedInput.requestKey} was already used for a different HITL request`);
        }
        return { file, result: { created: false, record: cloneRecord(existing) } };
      }
      const hitlId = parsedInput.hitlId ?? crypto.randomUUID();
      if (file.records.some((record) => record.hitlId === hitlId)) {
        throw new HitlConflictError(hitlId, `HITL id ${hitlId} already exists`);
      }
      const now = parsedInput.createdAt ?? this.#now().toISOString();
      const record = HitlRecordSchema.parse({
        hitlId,
        requestKey: parsedInput.requestKey,
        owner: parsedInput.owner,
        source: parsedInput.source,
        status: "pending",
        displayPayload: parsedInput.displayPayload,
        createdAt: now,
        updatedAt: now,
      });
      return {
        file: { records: [...file.records, record], updatedAt: now },
        result: { created: true, record: cloneRecord(record) },
        event: { type: "hitl.created", view: toHitlView(record) } as const,
      };
    });
    return result;
  }

  async list(filter: HitlListFilter = {}): Promise<HitlRecord[]> {
    const file = await this.#read();
    return file.records
      .filter((record) => filter.owner === undefined || sameOwner(record.owner, filter.owner))
      .filter((record) => filter.statuses === undefined || filter.statuses.includes(record.status))
      .map(cloneRecord)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.hitlId.localeCompare(right.hitlId));
  }

  async respond(hitlId: string, response: Exclude<HitlResponse, { type: "cancel" }>): Promise<HitlRecord> {
    return await this.#acceptResponse(hitlId, response);
  }

  async cancel(hitlId: string, response: Extract<HitlResponse, { type: "cancel" }>): Promise<HitlRecord> {
    return await this.#acceptResponse(hitlId, response);
  }

  async resolve(hitlId: string, outcome: ResolveHitlOutcome): Promise<HitlRecord> {
    return await this.#mutate((file) => {
      const { index, record } = findRecord(file, hitlId);
      if (record.status === "pending") throw new HitlConflictError(hitlId, "Cannot deliver an unanswered HITL request");
      if (record.status === "resolved" || record.status === "cancelled") return { file, result: cloneRecord(record) };

      const now = this.#now().toISOString();
      let next: HitlRecord;
      let event: ProjectHitlQueueEvent;
      switch (outcome.type) {
        case "dispatching": {
          const attempts = record.delivery?.attempts ?? 0;
          if (record.delivery?.error !== undefined && record.delivery.retryAt === undefined) {
            throw new HitlConflictError(hitlId, "HITL delivery requires manual inspection");
          }
          if (attempts >= MAX_HITL_DELIVERY_ATTEMPTS) {
            throw new HitlConflictError(hitlId, `HITL delivery exhausted ${MAX_HITL_DELIVERY_ATTEMPTS} attempts`);
          }
          next = HitlRecordSchema.parse({
            ...record,
            delivery: { attempts: attempts + 1 },
            updatedAt: now,
          });
          event = { type: "hitl.delivery", view: toHitlView(next) };
          break;
        }
        case "delivery_failed": {
          const attempts = record.delivery?.attempts ?? 0;
          if (attempts === 0) throw new HitlConflictError(hitlId, "Delivery failure requires a persisted dispatch attempt");
          const retryAt = attempts >= MAX_HITL_DELIVERY_ATTEMPTS ? undefined : outcome.retryAt;
          next = HitlRecordSchema.parse({
            ...record,
            delivery: withoutUndefined({ attempts, error: outcome.error, retryAt }),
            updatedAt: now,
          });
          event = { type: "hitl.delivery", view: toHitlView(next) };
          break;
        }
        case "applied": {
          if ((record.delivery?.attempts ?? 0) === 0) {
            throw new HitlConflictError(hitlId, "Applied HITL requires a persisted dispatch attempt");
          }
          const status = record.response?.type === "cancel" ? "cancelled" : "resolved";
          next = HitlRecordSchema.parse({
            ...record,
            status,
            delivery: undefined,
            updatedAt: now,
            resolvedAt: now,
          });
          event = { type: status === "cancelled" ? "hitl.cancelled" : "hitl.resolved", view: toHitlView(next) };
          break;
        }
      }
      const records = [...file.records];
      records[index] = next;
      return { file: { records, updatedAt: now }, result: cloneRecord(next), event };
    });
  }

  async #acceptResponse(hitlId: string, response: HitlResponse): Promise<HitlRecord> {
    const parsedResponse = HitlResponseSchema.parse(response);
    return await this.#mutate((file) => {
      const { index, record } = findRecord(file, hitlId);
      assertResponseMatchesSource(record.source, parsedResponse, hitlId);
      if (record.response !== undefined) {
        if (stableJson(record.response) === stableJson(parsedResponse)) return { file, result: cloneRecord(record) };
        throw new HitlConflictError(hitlId, "Cannot replace an accepted HITL response");
      }
      if (record.status !== "pending") throw new HitlConflictError(hitlId, `Cannot answer HITL in ${record.status}`);
      const now = this.#now().toISOString();
      const next = HitlRecordSchema.parse({ ...record, status: "answered", response: parsedResponse, updatedAt: now });
      const records = [...file.records];
      records[index] = next;
      return {
        file: { records, updatedAt: now },
        result: cloneRecord(next),
        event: { type: "hitl.answered", view: toHitlView(next) } as const,
      };
    });
  }

  async #read(): Promise<ProjectHitlFile> {
    return await withQueueMutationLock(this.#filePath, async () => await this.#readUnlocked());
  }

  async #readUnlocked(): Promise<ProjectHitlFile> {
    const file = Bun.file(this.#filePath);
    if (!(await file.exists())) return { records: [], updatedAt: this.#now().toISOString() };
    return ProjectHitlFileSchema.parse(JSON.parse(await file.text()));
  }

  async #mutate<T>(operation: (file: ProjectHitlFile) => {
    file: ProjectHitlFile;
    result: T;
    event?: ProjectHitlQueueEvent;
  }): Promise<T> {
    let event: ProjectHitlQueueEvent | undefined;
    const result = await withQueueMutationLock(this.#filePath, async () => {
      const current = await this.#readUnlocked();
      const mutation = operation(current);
      event = mutation.event;
      if (mutation.file !== current) {
        const parsed = ProjectHitlFileSchema.parse(mutation.file);
        await atomicWrite(this.#filePath, `${JSON.stringify(parsed, null, 2)}\n`);
      }
      return mutation.result;
    });
    if (event !== undefined) this.#publish(event);
    return result;
  }

  #publish(event: ProjectHitlQueueEvent): void {
    if (this.#onEvent === undefined) return;
    try {
      const pending = this.#onEvent(event);
      if (pending instanceof Promise) void pending.catch(() => undefined);
    } catch {
      // Event delivery is best-effort and never changes durable queue state.
    }
  }
}

export function projectHitlQueuePath(workspaceRoot: string): string {
  return join(workspaceRoot, PROJECT_STATE_DIR_NAME, "hitl-queue.json");
}

export function toHitlView(record: HitlRecord): HitlView {
  return withoutUndefined({
    hitlId: record.hitlId,
    owner: structuredClone(record.owner),
    source: structuredClone(record.source),
    status: record.status,
    displayPayload: structuredClone(record.displayPayload),
    allowedActions: allowedActions(record),
    ...(requiresInspection(record) ? { requiresInspection: true as const } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    resolvedAt: record.resolvedAt,
  });
}

export function requiresInspection(record: Pick<HitlRecord, "status" | "delivery">): boolean {
  return record.status === "answered"
    && record.delivery?.error !== undefined
    && record.delivery.retryAt === undefined;
}

function allowedActions(record: HitlRecord): HitlAllowedAction[] {
  if (record.status !== "pending") return [];
  switch (record.source.type) {
    case "ask_user": return ["answer", "cancel"];
    case "tool_permission":
    case "goal_budget": return ["approve", "deny", "cancel"];
  }
}

function parseCreateInput(input: CreateHitlInput): CreateHitlInput {
  return z.strictObject({
    requestKey: NonEmptyStringSchema,
    owner: HitlOwnerSchema,
    source: HitlSourceSchema,
    displayPayload: HitlDisplayPayloadSchema,
    hitlId: NonEmptyStringSchema.optional(),
    createdAt: NonEmptyStringSchema.optional(),
  }).superRefine((value, ctx) => {
    const sessionSource = value.source.type === "ask_user" || value.source.type === "tool_permission";
    if ((value.owner.type === "session") !== sessionSource) {
      ctx.addIssue({ code: "custom", path: ["source"], message: `${value.source.type} does not belong to ${value.owner.type}` });
    }
  }).parse(input) as CreateHitlInput;
}

function assertResponseMatchesSource(source: HitlSource, response: HitlResponse, hitlId: string): void {
  const matches = response.type === "cancel"
    || (source.type === "ask_user" && response.type === "question_answer")
    || (source.type === "tool_permission" && response.type === "permission_decision")
    || (source.type === "goal_budget" && response.type === "budget_decision");
  if (!matches) throw new HitlConflictError(hitlId, `${response.type} does not answer ${source.type}`);
}

function sameCreateIntent(record: HitlRecord, input: CreateHitlInput): boolean {
  return stableJson({ owner: record.owner, source: record.source, displayPayload: record.displayPayload })
    === stableJson({ owner: input.owner, source: input.source, displayPayload: input.displayPayload });
}

function findRecord(file: ProjectHitlFile, hitlId: string): { index: number; record: HitlRecord } {
  const index = file.records.findIndex((record) => record.hitlId === hitlId);
  if (index === -1) throw new HitlNotFoundError(hitlId);
  return { index, record: file.records[index]! };
}

function sameOwner(left: HitlOwner, right: HitlOwner): boolean {
  return left.type === right.type && left.id === right.id;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function cloneRecord(record: HitlRecord): HitlRecord {
  return HitlRecordSchema.parse(structuredClone(record));
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

async function withQueueMutationLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = queueMutationLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  queueMutationLocks.set(filePath, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (queueMutationLocks.get(filePath) === tail) queueMutationLocks.delete(filePath);
  }
}
