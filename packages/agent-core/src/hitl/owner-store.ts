import { z } from "zod/v4";
import {
  HITL_RECENT_TERMINAL_LIMIT,
  type HitlDisplayPayload,
  type HitlFile,
  type HitlOwnerKey,
  type HitlRecord,
  type HitlResponse,
  type HitlResumeMetadata,
  type HitlSource,
  type HitlStatus,
} from "@archcode/protocol";

import { atomicWrite } from "../utils/safe-file";

const ACTIVE_HITL_STATUSES = new Set<HitlStatus>(["pending", "resume_claimed", "resume_failed"]);
const TERMINAL_HITL_STATUSES = new Set<HitlStatus>(["resolved", "cancelled"]);

const HitlOwnerKeySchema: z.ZodType<HitlOwnerKey> = z.strictObject({
  projectSlug: z.string().trim().min(1),
  ownerType: z.enum(["session", "goal", "loop"]),
  ownerId: z.string().trim().min(1),
  workspaceRoot: z.never().optional(),
});

const HitlDisplayPayloadSchema: z.ZodType<HitlDisplayPayload> = z.strictObject({
  title: z.string().trim().min(1),
  summary: z.string().optional(),
  fields: z.array(z.strictObject({ label: z.string(), value: z.string() })).optional(),
  redacted: z.literal(true),
});

const HitlSourceSchema: z.ZodType<HitlSource> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ask_user"), sessionId: z.string(), toolCallId: z.string().optional() }),
  z.strictObject({ type: z.literal("tool_permission"), sessionId: z.string(), toolCallId: z.string(), toolName: z.string() }),
  z.strictObject({ type: z.literal("goal_approval"), goalId: z.string(), approvalPoint: z.enum(["after_plan", "before_complete"]) }),
  z.strictObject({ type: z.literal("goal_review"), goalId: z.string() }),
  z.strictObject({ type: z.literal("goal_budget"), goalId: z.string(), approvalPoint: z.string().optional() }),
  z.strictObject({ type: z.literal("goal_question"), goalId: z.string(), questionKey: z.string() }),
  z.strictObject({ type: z.literal("loop_approval"), loopId: z.string(), approvalPoint: z.string() }),
  z.strictObject({ type: z.literal("loop_blocker"), loopId: z.string(), runId: z.string().optional(), reason: z.string() }),
  z.strictObject({ type: z.literal("loop_retry"), loopId: z.string(), runId: z.string(), attempt: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal("loop_question"), loopId: z.string(), questionKey: z.string() }),
]);

const HitlResumeMetadataSchema: z.ZodType<HitlResumeMetadata> = z.strictObject({
  claimedAt: z.string().optional(),
  claimedBy: z.string().optional(),
  failedAt: z.string().optional(),
  failureReason: z.string().optional(),
  attempts: z.number().int().nonnegative().optional(),
});

const GoalArtifactNameSchema = z.enum([
  "plan.md",
  "build.md",
  "review.md",
  "spec-compliance.md",
  "approvals.md",
  "budget.md",
  "retry-log.md",
  "final-report.md",
]);

const GoalReviewCriterionSchema = z.strictObject({
  criterionId: z.string(),
  criterion: z.string(),
  compliant: z.boolean(),
  status: z.enum(["satisfied", "failed"]).optional(),
  evidence: z.array(z.string()),
  artifactNames: z.array(GoalArtifactNameSchema).optional(),
  commandRefs: z.array(z.string()).optional(),
  resultRefs: z.array(z.string()).optional(),
  fileRefs: z.array(z.string()).optional(),
  repairGuidance: z.string().optional(),
});

const GoalReviewReportSchema = z.strictObject({
  reviewerAgent: z.string(),
  outcome: z.enum(["DONE", "NOT_DONE"]),
  reviewedAt: z.string(),
  summary: z.string(),
  criteria: z.array(GoalReviewCriterionSchema),
});

const HitlResponseSchema: z.ZodType<HitlResponse> = z.union([
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
    type: z.literal("approval_decision"),
    decision: z.enum(["approved", "denied"]),
    comment: z.string().optional(),
    decidedBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("review_outcome"),
    outcome: z.enum(["DONE", "NOT_DONE"]),
    comment: z.string().optional(),
    report: GoalReviewReportSchema.optional(),
    reviewedBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("cancel"),
    reason: z.string(),
    cancelledBy: z.string().optional(),
  }),
]);

const HitlRecordSchema: z.ZodType<HitlRecord> = z.strictObject({
  hitlId: z.string().trim().min(1),
  owner: HitlOwnerKeySchema,
  blockingKey: z.string().trim().min(1),
  source: HitlSourceSchema,
  status: z.enum(["pending", "resume_claimed", "resolved", "cancelled", "resume_failed"]),
  displayPayload: HitlDisplayPayloadSchema,
  response: HitlResponseSchema.optional(),
  resume: HitlResumeMetadataSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().optional(),
});

const HitlFileSchema: z.ZodType<HitlFile> = z.strictObject({
  version: z.literal(1),
  owner: HitlOwnerKeySchema,
  pending: z.array(HitlRecordSchema),
  recentTerminal: z.array(HitlRecordSchema),
  updatedAt: z.string(),
});

export type HitlCreateResult =
  | { created: true; record: HitlRecord }
  | { created: false; record: HitlRecord; reason: "active_blocking_key_exists" };

export type HitlLookupResult =
  | { status: "found"; record: HitlRecord; file: HitlFile }
  | { status: "missing" };

export class HitlOwnerMismatchError extends Error {
  constructor(
    public readonly expected: HitlOwnerKey,
    public readonly actual: HitlOwnerKey,
  ) {
    super(`HITL file owner mismatch: expected ${ownerKey(expected)}, found ${ownerKey(actual)}`);
    this.name = "HitlOwnerMismatchError";
  }
}

export class HitlRecordStateError extends Error {
  constructor(
    public readonly hitlId: string,
    message: string,
  ) {
    super(message);
    this.name = "HitlRecordStateError";
  }
}

export class HitlOwnerStore {
  constructor(
    private readonly filePath: string,
    private readonly owner: HitlOwnerKey,
    private readonly recentTerminalLimit = HITL_RECENT_TERMINAL_LIMIT,
  ) {}

  async read(): Promise<HitlFile> {
    const file = Bun.file(this.filePath);
    if (!(await file.exists())) return emptyHitlFile(this.owner);

    const parsed = HitlFileSchema.parse(JSON.parse(await file.text()));
    assertSameOwner(this.owner, parsed.owner);
    assertUniqueHitlIds(parsed);
    return normalizeHitlFile(parsed, this.recentTerminalLimit);
  }

  async write(file: HitlFile): Promise<void> {
    assertSameOwner(this.owner, file.owner);
    const parsed = HitlFileSchema.parse(file);
    assertUniqueHitlIds(parsed);
    const normalized = normalizeHitlFile(parsed, this.recentTerminalLimit);
    assertUniqueHitlIds(normalized);
    await atomicWrite(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
  }

  async create(record: HitlRecord): Promise<HitlCreateResult> {
    assertSameOwner(this.owner, record.owner);
    const parsed = HitlRecordSchema.parse(record);
    if (!ACTIVE_HITL_STATUSES.has(parsed.status)) {
      throw new HitlRecordStateError(parsed.hitlId, `Cannot create non-active HITL record with status ${parsed.status}`);
    }

    const file = await this.read();
    const existing = file.pending.find((entry) => entry.blockingKey === parsed.blockingKey && ACTIVE_HITL_STATUSES.has(entry.status));
    if (existing !== undefined) return { created: false, record: cloneRecord(existing), reason: "active_blocking_key_exists" };

    const hitlIdCollision = [...file.pending, ...file.recentTerminal].find((entry) => entry.hitlId === parsed.hitlId);
    if (hitlIdCollision !== undefined) {
      throw new HitlRecordStateError(parsed.hitlId, `Cannot create duplicate HITL id ${parsed.hitlId}`);
    }

    await this.write({
      ...file,
      pending: [...file.pending, parsed],
      updatedAt: parsed.updatedAt,
    });
    return { created: true, record: cloneRecord(parsed) };
  }

  async list(): Promise<HitlRecord[]> {
    const file = await this.read();
    return [...file.pending, ...file.recentTerminal].map(cloneRecord);
  }

  async lookup(hitlId: string): Promise<HitlLookupResult> {
    const file = await this.read();
    const record = [...file.pending, ...file.recentTerminal].find((entry) => entry.hitlId === hitlId);
    if (record === undefined) return { status: "missing" };
    return { status: "found", record: cloneRecord(record), file };
  }

  async claim(hitlId: string, response: HitlResponse, resume: HitlResumeMetadata = {}): Promise<HitlRecord> {
    const file = await this.read();
    const index = file.pending.findIndex((entry) => entry.hitlId === hitlId);
    if (index === -1) throw new HitlRecordStateError(hitlId, "Cannot claim missing or terminal HITL record");

    const current = file.pending[index]!;
    if (!ACTIVE_HITL_STATUSES.has(current.status)) {
      throw new HitlRecordStateError(hitlId, `Cannot claim HITL record with status ${current.status}`);
    }

    const now = new Date().toISOString();
    const next = HitlRecordSchema.parse({
      ...current,
      status: "resume_claimed",
      response,
      resume: {
        ...current.resume,
        ...resume,
        claimedAt: resume.claimedAt ?? now,
        attempts: resume.attempts ?? ((current.resume?.attempts ?? 0) + 1),
      },
      updatedAt: now,
    });
    const pending = [...file.pending];
    pending[index] = next;
    await this.write({ ...file, pending, updatedAt: now });
    return cloneRecord(next);
  }

  async markResumeFailed(hitlId: string, reason: string): Promise<HitlRecord> {
    const file = await this.read();
    const index = file.pending.findIndex((entry) => entry.hitlId === hitlId);
    if (index === -1) throw new HitlRecordStateError(hitlId, "Cannot fail missing or terminal HITL record");

    const current = file.pending[index]!;
    const now = new Date().toISOString();
    const next = HitlRecordSchema.parse({
      ...current,
      status: "resume_failed",
      resume: {
        ...current.resume,
        failedAt: now,
        failureReason: reason,
      },
      updatedAt: now,
    });
    const pending = [...file.pending];
    pending[index] = next;
    await this.write({ ...file, pending, updatedAt: now });
    return cloneRecord(next);
  }

  async complete(hitlId: string, status: Extract<HitlStatus, "resolved" | "cancelled">, response?: HitlResponse): Promise<HitlRecord> {
    const file = await this.read();
    const index = file.pending.findIndex((entry) => entry.hitlId === hitlId);
    if (index === -1) throw new HitlRecordStateError(hitlId, "Cannot complete missing or terminal HITL record");

    const now = new Date().toISOString();
    const current = file.pending[index]!;
    const next = HitlRecordSchema.parse({
      ...current,
      status,
      response: response ?? current.response,
      updatedAt: now,
      resolvedAt: now,
    });
    const pending = file.pending.filter((entry) => entry.hitlId !== hitlId);
    await this.write({
      ...file,
      pending,
      recentTerminal: [...file.recentTerminal, next],
      updatedAt: now,
    });
    return cloneRecord(next);
  }

  async cancelActive(reason: string, cancelledBy?: string): Promise<HitlRecord[]> {
    const file = await this.read();
    const now = new Date().toISOString();
    const cancelled = file.pending.map((record) => HitlRecordSchema.parse({
      ...record,
      status: "cancelled",
      response: { type: "cancel", reason, cancelledBy } satisfies HitlResponse,
      updatedAt: now,
      resolvedAt: now,
    }));
    if (cancelled.length === 0) return [];

    await this.write({
      ...file,
      pending: [],
      recentTerminal: [...file.recentTerminal, ...cancelled],
      updatedAt: now,
    });
    return cancelled.map(cloneRecord);
  }
}

export function emptyHitlFile(owner: HitlOwnerKey, now = new Date().toISOString()): HitlFile {
  return { version: 1, owner, pending: [], recentTerminal: [], updatedAt: now };
}

export function isActiveHitlStatus(status: HitlStatus): boolean {
  return ACTIVE_HITL_STATUSES.has(status);
}

export function isTerminalHitlStatus(status: HitlStatus): boolean {
  return TERMINAL_HITL_STATUSES.has(status);
}

function normalizeHitlFile(file: HitlFile, recentTerminalLimit: number): HitlFile {
  const pending = file.pending.filter((record) => ACTIVE_HITL_STATUSES.has(record.status)).map(cloneRecord);
  const recentTerminal = file.recentTerminal
    .filter((record) => TERMINAL_HITL_STATUSES.has(record.status))
    .slice(-recentTerminalLimit)
    .map(cloneRecord);
  return HitlFileSchema.parse({ ...file, pending, recentTerminal });
}

function assertUniqueHitlIds(file: HitlFile): void {
  const seen = new Set<string>();
  for (const record of [...file.pending, ...file.recentTerminal]) {
    if (seen.has(record.hitlId)) {
      throw new HitlRecordStateError(record.hitlId, `Duplicate HITL id ${record.hitlId} in owner-local file`);
    }
    seen.add(record.hitlId);
  }
}

function assertSameOwner(expected: HitlOwnerKey, actual: HitlOwnerKey): void {
  if (ownerKey(expected) !== ownerKey(actual)) throw new HitlOwnerMismatchError(expected, actual);
}

function ownerKey(owner: HitlOwnerKey): string {
  return `${owner.projectSlug}:${owner.ownerType}:${owner.ownerId}`;
}

function cloneRecord(record: HitlRecord): HitlRecord {
  return HitlRecordSchema.parse(structuredClone(record));
}
