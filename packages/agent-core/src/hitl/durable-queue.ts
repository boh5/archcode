import { join } from "node:path";

import { z } from "zod/v4";

import { REDACTION_MARKER, redactString, redactValue } from "../tools/security/redaction";
import { atomicWrite } from "../utils/safe-file";
import type { HitlKind, HitlPayload, HitlRequest, HitlResolutionStatus, HitlResponsePayload, HitlTrigger } from "./types";

const PROJECT_DIR_NAME = ".archcode";
const HITL_QUEUE_FILE = "hitl-queue.json";
const QUEUE_VERSION = 1;
const DISPLAY_REDACTION_MARKER = "[REDACTED]";

export type DurableHitlTriggerType = "approval_point" | "tool_approval" | "agent_request";
export type DurableHitlStatus = "pending" | HitlResolutionStatus;

export interface DurableHitlDisplayPayload {
  title: string;
  summary?: string;
  fields?: Array<{ label: string; value: string }>;
  redacted: true;
}

export interface DurableHitlRecord {
  id: string;
  projectSlug: string;
  goalId?: string;
  loopId?: string;
  sessionId: string;
  kind: HitlKind;
  trigger: DurableHitlTriggerType;
  triggerSource?: string;
  approvalPoint?: string;
  toolCallId?: string;
  approvalKey: string;
  status: DurableHitlStatus;
  displayPayload: DurableHitlDisplayPayload;
  decisionPayload: HitlPayload;
  timeoutMs?: number;
  defaultBehavior?: "cancel" | "timeout";
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  response?: HitlResponsePayload;
  terminalReason?: string;
}

export interface CreateDurableHitlInput {
  hitlId: string;
  sessionId: string;
  kind: HitlKind;
  payload: HitlPayload;
  trigger: Omit<HitlTrigger, "abortSignal">;
  createdAt: number;
}

export type DurableHitlMutationResult =
  | { ok: true; record: DurableHitlRecord }
  | { ok: false; reason: "missing" | "wrong_project" | "not_pending"; record?: DurableHitlRecord };

const DisplayFieldSchema = z.strictObject({
  label: z.string(),
  value: z.string(),
});

const DurableHitlDisplayPayloadSchema: z.ZodType<DurableHitlDisplayPayload> = z.strictObject({
  title: z.string(),
  summary: z.string().optional(),
  fields: z.array(DisplayFieldSchema).optional(),
  redacted: z.literal(true),
});

const DurableHitlRecordSchema: z.ZodType<DurableHitlRecord> = z.strictObject({
  id: z.string(),
  projectSlug: z.string(),
  goalId: z.string().optional(),
  loopId: z.string().optional(),
  sessionId: z.string(),
  kind: z.enum(["question", "approval", "review"]),
  trigger: z.enum(["approval_point", "tool_approval", "agent_request"]),
  triggerSource: z.string().optional(),
  approvalPoint: z.string().optional(),
  toolCallId: z.string().optional(),
  approvalKey: z.string(),
  status: z.enum(["pending", "resolved", "cancelled", "timeout"]),
  displayPayload: DurableHitlDisplayPayloadSchema,
  decisionPayload: z.unknown() as z.ZodType<HitlPayload>,
  timeoutMs: z.number().int().nonnegative().optional(),
  defaultBehavior: z.enum(["cancel", "timeout"]).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().optional(),
  resolvedBy: z.string().optional(),
  response: z.unknown().optional() as z.ZodType<HitlResponsePayload | undefined>,
  terminalReason: z.string().optional(),
});

const DurableHitlQueueFileSchema = z.strictObject({
  version: z.literal(QUEUE_VERSION),
  records: z.array(DurableHitlRecordSchema),
});

type DurableHitlQueueFile = z.infer<typeof DurableHitlQueueFileSchema>;

const EMPTY_QUEUE_FILE: DurableHitlQueueFile = {
  version: QUEUE_VERSION,
  records: [],
};

export function hitlQueuePath(workspaceRoot: string): string {
  return join(workspaceRoot, PROJECT_DIR_NAME, HITL_QUEUE_FILE);
}

export class DurableHitlQueue {
  #workspaceRoot: string | null = null;
  #queueFile: DurableHitlQueueFile = cloneQueueFile(EMPTY_QUEUE_FILE);
  #writeQueue: Promise<void> = Promise.resolve();
  #fileMtime: number | null = null;

  async load(workspaceRoot: string): Promise<void> {
    this.#workspaceRoot = workspaceRoot;
    const filePath = hitlQueuePath(workspaceRoot);
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
      this.#queueFile = cloneQueueFile(EMPTY_QUEUE_FILE);
      this.#fileMtime = null;
      return;
    }

    const fileMtime = file.lastModified;
    try {
      this.#queueFile = DurableHitlQueueFileSchema.parse(JSON.parse(await file.text()));
    } catch {
      this.#queueFile = cloneQueueFile(EMPTY_QUEUE_FILE);
    }
    this.#fileMtime = fileMtime;
  }

  async reloadIfStale(workspaceRoot: string): Promise<void> {
    const file = Bun.file(hitlQueuePath(workspaceRoot));
    const currentMtime = await file.exists() ? file.lastModified : null;
    if (currentMtime !== this.#fileMtime) await this.load(workspaceRoot);
  }

  createOrReusePending(input: CreateDurableHitlInput): DurableHitlRecord {
    const approvalKey = deterministicApprovalKey(input.sessionId, input.kind, input.payload, input.trigger);
    const existing = this.#queueFile.records.find((record) => record.approvalKey === approvalKey && record.status === "pending");
    if (existing) return cloneRecord(existing);

    const projectSlug = input.trigger.projectSlug ?? "unknown-project";
    const now = new Date(input.createdAt).toISOString();
    const record: DurableHitlRecord = DurableHitlRecordSchema.parse(withoutUndefined({
      id: input.hitlId,
      projectSlug,
      goalId: input.trigger.goalId,
      loopId: input.trigger.loopId,
      sessionId: input.sessionId,
      kind: input.kind,
      trigger: durableTriggerType(input.kind, input.trigger),
      triggerSource: input.trigger.source,
      approvalPoint: approvalPointFrom(input.trigger, input.payload),
      toolCallId: input.trigger.toolCallId,
      approvalKey,
      status: "pending" as const,
      displayPayload: buildDisplayPayload(input.payload),
      decisionPayload: redactPayload(input.payload),
      timeoutMs: input.trigger.timeoutMs,
      defaultBehavior: input.trigger.timeoutMs === undefined ? "cancel" as const : "timeout" as const,
      createdAt: now,
      updatedAt: now,
    }) as unknown);

    this.#queueFile = {
      version: QUEUE_VERSION,
      records: [...this.#queueFile.records, DurableHitlRecordSchema.parse(record)],
    };
    void this.#persist();
    return cloneRecord(record);
  }

  resolve(projectSlug: string, hitlId: string, response: HitlResponsePayload, resolvedBy?: string): DurableHitlMutationResult {
    return this.#transition(projectSlug, hitlId, "resolved", { response: redactValue(response), resolvedBy });
  }

  cancel(projectSlug: string, hitlId: string, reason: string, resolvedBy?: string): DurableHitlMutationResult {
    return this.#transition(projectSlug, hitlId, "cancelled", { terminalReason: redactedDisplayString(reason), resolvedBy });
  }

  timeout(projectSlug: string, hitlId: string, reason: string): DurableHitlMutationResult {
    return this.#transition(projectSlug, hitlId, "timeout", { terminalReason: redactedDisplayString(reason) });
  }

  has(hitlId: string): boolean {
    return this.#queueFile.records.some((record) => record.id === hitlId && record.status === "pending");
  }

  get(hitlId: string): DurableHitlRecord | undefined {
    const record = this.#queueFile.records.find((entry) => entry.id === hitlId);
    return record ? cloneRecord(record) : undefined;
  }

  listPending(projectSlug?: string, goalId?: string, loopId?: string): DurableHitlRecord[] {
    return this.#queueFile.records
      .filter((record) => record.status === "pending")
      .filter((record) => projectSlug === undefined || record.projectSlug === projectSlug)
      .filter((record) => goalId === undefined || record.goalId === goalId)
      .filter((record) => loopId === undefined || record.loopId === loopId)
      .map(cloneRecord);
  }

  listRecords(projectSlug?: string): DurableHitlRecord[] {
    return this.#queueFile.records
      .filter((record) => projectSlug === undefined || record.projectSlug === projectSlug)
      .map(cloneRecord);
  }

  toRequest(record: DurableHitlRecord): HitlRequest {
    return withoutUndefined({
      hitlId: record.id,
      sessionId: record.sessionId,
      kind: record.kind,
      payload: record.decisionPayload,
      trigger: {
        projectSlug: record.projectSlug,
        goalId: record.goalId,
        loopId: record.loopId,
        source: record.triggerSource,
        timeoutMs: record.timeoutMs,
        approvalPoint: record.approvalPoint,
        toolCallId: record.toolCallId,
      },
      createdAt: new Date(record.createdAt).getTime(),
      status: record.status,
      displayPayload: record.displayPayload,
      approvalKey: record.approvalKey,
    });
  }

  async flush(): Promise<void> {
    await this.#writeQueue;
  }

  #transition(
    projectSlug: string,
    hitlId: string,
    status: Exclude<DurableHitlStatus, "pending">,
    update: { response?: HitlResponsePayload; terminalReason?: string; resolvedBy?: string },
  ): DurableHitlMutationResult {
    const recordIndex = this.#queueFile.records.findIndex((record) => record.id === hitlId);
    if (recordIndex === -1) return { ok: false, reason: "missing" };

    const current = this.#queueFile.records[recordIndex]!;
    if (current.projectSlug !== projectSlug) return { ok: false, reason: "wrong_project", record: cloneRecord(current) };
    if (current.status !== "pending") return { ok: false, reason: "not_pending", record: cloneRecord(current) };

    const now = new Date().toISOString();
    const next = DurableHitlRecordSchema.parse(withoutUndefined({
      ...current,
      status,
      updatedAt: now,
      resolvedAt: now,
      resolvedBy: update.resolvedBy,
      response: update.response,
      terminalReason: update.terminalReason,
    }));

    const records = [...this.#queueFile.records];
    records[recordIndex] = next;
    this.#queueFile = { version: QUEUE_VERSION, records };
    void this.#persist();
    return { ok: true, record: cloneRecord(next) };
  }

  async #persist(): Promise<void> {
    const workspaceRoot = this.#workspaceRoot;
    if (workspaceRoot === null) return;

    const snapshot = cloneQueueFile(this.#queueFile);
    this.#writeQueue = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        await atomicWrite(hitlQueuePath(workspaceRoot), `${JSON.stringify(snapshot, null, 2)}\n`);
        const file = Bun.file(hitlQueuePath(workspaceRoot));
        this.#fileMtime = await file.exists() ? file.lastModified : null;
      })
      .catch(() => {
        // Match existing project persistence behavior: storage failures are non-fatal to callers.
      });
    await this.#writeQueue;
  }
}

export function deterministicApprovalKey(
  sessionId: string,
  kind: HitlKind,
  payload: HitlPayload,
  trigger: Omit<HitlTrigger, "abortSignal">,
): string {
  const projectSlug = trigger.projectSlug ?? "unknown-project";
  const goalId = trigger.goalId ?? "no-goal";
  const triggerType = durableTriggerType(kind, trigger);
  const approvalPoint = approvalPointFrom(trigger, payload);

  if (trigger.toolCallId !== undefined) {
    return `${projectSlug}:${goalId}:${sessionId}:${trigger.toolCallId}`;
  }

  if (approvalPoint !== undefined) {
    return `${projectSlug}:${goalId}:${sessionId}:${triggerType}:${approvalPoint}`;
  }

  return `${projectSlug}:${goalId}:${sessionId}:${triggerType}:${trigger.source ?? kind}:${crypto.randomUUID()}`;
}

function durableTriggerType(kind: HitlKind, trigger: Omit<HitlTrigger, "abortSignal">): DurableHitlTriggerType {
  if (trigger.toolCallId !== undefined) return "tool_approval";
  if (trigger.source?.startsWith("goal.") || kind === "review") return "approval_point";
  return "agent_request";
}

function approvalPointFrom(trigger: Omit<HitlTrigger, "abortSignal">, payload: HitlPayload): string | undefined {
  if (trigger.approvalPoint !== undefined) return trigger.approvalPoint;
  if (payload.kind === "approval" && typeof payload.context.approvalPoint === "string") return payload.context.approvalPoint;
  if (trigger.source?.startsWith("goal.approval.")) return trigger.source.slice("goal.approval.".length);
  if (trigger.source === "goal.review") return "review";
  return undefined;
}

function buildDisplayPayload(payload: HitlPayload): DurableHitlDisplayPayload {
  const fields: Array<{ label: string; value: string }> = [];
  const title = redactedDisplayString(payload.title ?? (payload.kind === "approval" ? payload.action : "Human input requested"));
  const summary = payload.message ?? payload.rationale;

  if (payload.details !== undefined) fields.push({ label: "details", value: redactedDisplayString(JSON.stringify(redactValue(payload.details))) });
  if (payload.kind === "approval") {
    fields.push({ label: "action", value: redactedDisplayString(payload.action) });
    fields.push({ label: "context", value: redactedDisplayString(JSON.stringify(redactValue(payload.context))) });
  }
  if (payload.kind === "review") {
    fields.push({ label: "artifacts", value: redactedDisplayString(JSON.stringify(redactValue(payload.artifacts))) });
  }
  if (payload.options !== undefined) {
    fields.push({ label: "options", value: redactedDisplayString(JSON.stringify(redactValue(payload.options))) });
  }

  return DurableHitlDisplayPayloadSchema.parse(withoutUndefined({
    title,
    summary: summary === undefined ? undefined : redactedDisplayString(summary),
    fields: fields.length === 0 ? undefined : fields,
    redacted: true as const,
  }) as unknown);
}

function redactPayload(payload: HitlPayload): HitlPayload {
  return redactValue(payload);
}

function redactedDisplayString(value: string): string {
  return redactString(value).replaceAll(REDACTION_MARKER, DISPLAY_REDACTION_MARKER);
}

function cloneQueueFile(file: DurableHitlQueueFile): DurableHitlQueueFile {
  return DurableHitlQueueFileSchema.parse(structuredClone(file));
}

function cloneRecord(record: DurableHitlRecord): DurableHitlRecord {
  return DurableHitlRecordSchema.parse(structuredClone(record));
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
