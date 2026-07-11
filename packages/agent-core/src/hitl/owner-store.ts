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
const ownerFileMutationLocks = new Map<string, Promise<void>>();

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
  questions: z.array(z.strictObject({
    question: z.string(),
    header: z.string(),
    options: z.array(z.strictObject({ label: z.string(), description: z.string() })).optional(),
    multiple: z.boolean().optional(),
    custom: z.boolean(),
  })).optional(),
  redacted: z.literal(true),
});

const HitlSourceSchema: z.ZodType<HitlSource> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ask_user"), sessionId: z.string(), toolCallId: z.string().optional() }),
  z.strictObject({ type: z.literal("tool_permission"), sessionId: z.string(), toolCallId: z.string(), toolName: z.string() }),
  z.strictObject({ type: z.literal("goal_approval"), goalId: z.string(), approvalPoint: z.string().optional(), resumeStatus: z.enum(["running", "reviewing"]) }),
  z.strictObject({ type: z.literal("goal_review"), goalId: z.string(), resumeStatus: z.literal("reviewing") }),
  z.strictObject({ type: z.literal("goal_budget"), goalId: z.string(), approvalPoint: z.string().optional(), resumeStatus: z.enum(["running", "reviewing"]) }),
  z.strictObject({ type: z.literal("goal_question"), goalId: z.string(), questionKey: z.string(), resumeStatus: z.enum(["running", "reviewing"]) }),
  z.strictObject({ type: z.literal("loop_approval"), loopId: z.string(), approvalPoint: z.string() }),
  z.strictObject({ type: z.literal("loop_blocker"), loopId: z.string(), runId: z.string().optional(), reason: z.string() }),
  z.strictObject({ type: z.literal("loop_retry"), loopId: z.string(), runId: z.string(), attempt: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal("loop_question"), loopId: z.string(), questionKey: z.string() }),
]);

const HitlResumeMetadataSchema: z.ZodType<HitlResumeMetadata> = z.strictObject({
  claimId: z.string().trim().min(1),
  claimedAt: z.string().trim().min(1),
  claimedBy: z.string().optional(),
  intent: z.enum(["respond", "cancel"]),
  attempt: z.number().int().positive(),
  lastError: z.string().optional(),
  failedAt: z.string().optional(),
  failureReason: z.string().optional(),
});

const GoalEvidenceRefSchema = z.strictObject({
  kind: z.enum(["session", "message", "tool_call", "diff", "test_output", "file", "url", "hitl"]),
  ref: z.string(),
  summary: z.string(),
  sessionId: z.string().optional(),
  messageId: z.string().optional(),
  toolCallId: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  createdAt: z.string().optional(),
});

const GoalReviewReceiptSchema = z.strictObject({
  verdict: z.enum(["DONE", "NOT_DONE"]),
  summary: z.string(),
  evidenceRefs: z.array(GoalEvidenceRefSchema).max(20),
  unresolvedItems: z.array(z.string()).optional(),
  reviewerSessionId: z.string(),
  decidedAt: z.string(),
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
    receipt: GoalReviewReceiptSchema.optional(),
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
}).superRefine((record, ctx) => {
  if (record.status !== "resume_claimed" && record.status !== "resume_failed") return;
  if (record.response === undefined) {
    ctx.addIssue({ code: "custom", path: ["response"], message: `${record.status} requires a response` });
  }
  if (record.resume === undefined) {
    ctx.addIssue({ code: "custom", path: ["resume"], message: `${record.status} requires complete resume metadata` });
  }
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
    // Bun.file().text() can otherwise observe a concurrent commit before the
    // replacement payload is fully readable, so readers share the RMW lock.
    return await withOwnerFileMutationLock(this.filePath, async () => await this.#readUnlocked());
  }

  async #readUnlocked(): Promise<HitlFile> {
    const file = Bun.file(this.filePath);
    if (!(await file.exists())) return emptyHitlFile(this.owner);

    const parsed = HitlFileSchema.parse(JSON.parse(await file.text()));
    assertSameOwner(this.owner, parsed.owner);
    assertFileRecordIdentities(parsed);
    assertUniqueHitlIds(parsed);
    assertHitlBuckets(parsed, this.recentTerminalLimit);
    return cloneFile(parsed);
  }

  async write(file: HitlFile): Promise<void> {
    await withOwnerFileMutationLock(this.filePath, async () => await this.#writeUnlocked(file));
  }

  async #writeUnlocked(file: HitlFile): Promise<void> {
    assertSameOwner(this.owner, file.owner);
    const parsed = HitlFileSchema.parse(file);
    assertFileRecordIdentities(parsed);
    assertUniqueHitlIds(parsed);
    assertHitlBuckets(parsed);
    const retained = HitlFileSchema.parse({
      ...parsed,
      recentTerminal: parsed.recentTerminal.slice(-this.recentTerminalLimit),
    });
    assertUniqueHitlIds(retained);
    await atomicWrite(this.filePath, `${JSON.stringify(retained, null, 2)}\n`);
  }

  async create(record: HitlRecord): Promise<HitlCreateResult> {
    return await withOwnerFileMutationLock(this.filePath, async () => {
      assertSameOwner(this.owner, record.owner);
      const parsed = HitlRecordSchema.parse(record);
      assertRecordIdentity(this.owner, parsed);
      if (!ACTIVE_HITL_STATUSES.has(parsed.status)) {
        throw new HitlRecordStateError(parsed.hitlId, `Cannot create non-active HITL record with status ${parsed.status}`);
      }

      const file = await this.#readUnlocked();
      const existing = file.pending.find((entry) => entry.blockingKey === parsed.blockingKey && ACTIVE_HITL_STATUSES.has(entry.status));
      if (existing !== undefined) return { created: false, record: cloneRecord(existing), reason: "active_blocking_key_exists" };

      const hitlIdCollision = [...file.pending, ...file.recentTerminal].find((entry) => entry.hitlId === parsed.hitlId);
      if (hitlIdCollision !== undefined) {
        throw new HitlRecordStateError(parsed.hitlId, `Cannot create duplicate HITL id ${parsed.hitlId}`);
      }

      await this.#writeUnlocked({
        ...file,
        pending: [...file.pending, parsed],
        updatedAt: parsed.updatedAt,
      });
      return { created: true, record: cloneRecord(parsed) };
    });
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

  async claim(hitlId: string, response: HitlResponse, resume: HitlResumeMetadata): Promise<HitlRecord> {
    return await withOwnerFileMutationLock(this.filePath, async () => {
      const file = await this.#readUnlocked();
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
        },
        updatedAt: now,
      });
      const pending = [...file.pending];
      pending[index] = next;
      await this.#writeUnlocked({ ...file, pending, updatedAt: now });
      return cloneRecord(next);
    });
  }

  async markResumeFailed(hitlId: string, reason: string): Promise<HitlRecord> {
    return await withOwnerFileMutationLock(this.filePath, async () => {
      const file = await this.#readUnlocked();
      const index = file.pending.findIndex((entry) => entry.hitlId === hitlId);
      if (index === -1) throw new HitlRecordStateError(hitlId, "Cannot fail missing or terminal HITL record");

      const current = file.pending[index]!;
      if (current.status !== "resume_claimed") {
        throw new HitlRecordStateError(hitlId, `Cannot fail HITL record with status ${current.status}`);
      }
      const now = new Date().toISOString();
      const next = HitlRecordSchema.parse({
        ...current,
        status: "resume_failed",
        resume: {
          ...current.resume,
          failedAt: now,
          failureReason: reason,
          lastError: reason,
        },
        updatedAt: now,
      });
      const pending = [...file.pending];
      pending[index] = next;
      await this.#writeUnlocked({ ...file, pending, updatedAt: now });
      return cloneRecord(next);
    });
  }

  async complete(hitlId: string, status: Extract<HitlStatus, "resolved" | "cancelled">, response?: HitlResponse): Promise<HitlRecord> {
    return await withOwnerFileMutationLock(this.filePath, async () => {
      const file = await this.#readUnlocked();
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
      await this.#writeUnlocked({
        ...file,
        pending,
        recentTerminal: [...file.recentTerminal, next],
        updatedAt: now,
      });
      return cloneRecord(next);
    });
  }

  async cancelActive(reason: string, cancelledBy?: string): Promise<HitlRecord[]> {
    return await withOwnerFileMutationLock(this.filePath, async () => {
      const file = await this.#readUnlocked();
      const now = new Date().toISOString();
      const cancelled = file.pending.map((record) => HitlRecordSchema.parse({
        ...record,
        status: "cancelled",
        response: { type: "cancel", reason, cancelledBy } satisfies HitlResponse,
        updatedAt: now,
        resolvedAt: now,
      }));
      if (cancelled.length === 0) return [];

      await this.#writeUnlocked({
        ...file,
        pending: [],
        recentTerminal: [...file.recentTerminal, ...cancelled],
        updatedAt: now,
      });
      return cancelled.map(cloneRecord);
    });
  }
}

/**
 * Serializes owner-file read/modify/write sequences across store instances in
 * this process. Deployments with multiple ArchCode processes still require an
 * OS/distributed file lock.
 */
async function withOwnerFileMutationLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const previous = ownerFileMutationLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const tail = previous.then(() => current, () => current);
  ownerFileMutationLocks.set(filePath, tail);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (ownerFileMutationLocks.get(filePath) === tail) ownerFileMutationLocks.delete(filePath);
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

function assertHitlBuckets(file: HitlFile, recentTerminalLimit?: number): void {
  for (const record of file.pending) {
    if (!ACTIVE_HITL_STATUSES.has(record.status)) {
      throw new HitlRecordStateError(record.hitlId, `Terminal HITL record ${record.hitlId} cannot be stored in pending`);
    }
  }
  for (const record of file.recentTerminal) {
    if (!TERMINAL_HITL_STATUSES.has(record.status)) {
      throw new HitlRecordStateError(record.hitlId, `Active HITL record ${record.hitlId} cannot be stored in recentTerminal`);
    }
  }
  if (recentTerminalLimit !== undefined && file.recentTerminal.length > recentTerminalLimit) {
    throw new HitlRecordStateError(
      file.recentTerminal[recentTerminalLimit]?.hitlId ?? "recentTerminal",
      `recentTerminal exceeds retention limit ${recentTerminalLimit}`,
    );
  }
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

function assertFileRecordIdentities(file: HitlFile): void {
  for (const record of [...file.pending, ...file.recentTerminal]) {
    assertRecordIdentity(file.owner, record);
  }
}

function assertRecordIdentity(owner: HitlOwnerKey, record: HitlRecord): void {
  assertSameOwner(owner, record.owner);
  const source = record.source;
  const matches = owner.ownerType === "session"
    ? (source.type === "ask_user" || source.type === "tool_permission") && source.sessionId === owner.ownerId
    : owner.ownerType === "goal"
      ? (source.type === "goal_approval" || source.type === "goal_review" || source.type === "goal_budget" || source.type === "goal_question")
        && source.goalId === owner.ownerId
      : (source.type === "loop_approval" || source.type === "loop_blocker" || source.type === "loop_retry" || source.type === "loop_question")
        && source.loopId === owner.ownerId;
  if (!matches) {
    throw new HitlRecordStateError(
      record.hitlId,
      `HITL source ${source.type} does not match owner ${ownerKey(owner)}`,
    );
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

function cloneFile(file: HitlFile): HitlFile {
  return HitlFileSchema.parse(structuredClone(file));
}
