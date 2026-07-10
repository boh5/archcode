import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type {
  HitlDisplayPayload,
  HitlOwnerKey,
  HitlResponse,
  HitlSource,
} from "@archcode/protocol";

import { getSessionDir } from "../store/sessions-dir";
import type { ToolExecutionOrigin } from "../tools/types";

export interface SessionHitlToolCallCheckpoint {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface SessionHitlCompletedToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: string;
  readonly isError: boolean;
  readonly meta?: Record<string, unknown>;
}

export type SessionHitlJournalPhase =
  | "preparing"
  | "paused"
  | "replaying"
  | "continuing"
  | "continued"
  | "resolving"
  | "manual_unknown";

export interface SessionHitlPreparedRequest {
  readonly owner: HitlOwnerKey;
  readonly displayPayload: HitlDisplayPayload;
  readonly createdAt: string;
}

export interface SessionHitlCheckpointRecord {
  readonly version: 1;
  /** Legacy checkpoint records without a phase are interpreted as paused. */
  readonly phase?: SessionHitlJournalPhase;
  readonly phaseUpdatedAt?: string;
  readonly hitlId: string;
  readonly blockingKey: string;
  readonly source: HitlSource;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly step: number;
  readonly assistantMessageId?: string;
  readonly rawToolInput: unknown;
  readonly displayInput: unknown;
  readonly allowedTools: string[];
  readonly agentSkills: string[];
  readonly agentName?: string;
  readonly currentDepth?: number;
  readonly origin?: ToolExecutionOrigin;
  readonly toolCalls: SessionHitlToolCallCheckpoint[];
  readonly completedToolResults: SessionHitlCompletedToolResult[];
  readonly pendingToolCalls: SessionHitlToolCallCheckpoint[];
  readonly blockedToolIndex: number;
  readonly createdAt: string;
  readonly kind: "ask_user" | "permission";
  /** Present on journal-first records so a cold repair can create the owner record. */
  readonly request?: SessionHitlPreparedRequest;
  readonly permission?: {
    readonly description: string;
    readonly reason?: string;
    readonly approval?: unknown;
    readonly decisionDisplay?: string;
    readonly ruleId?: string;
  };
}

export interface SessionHitlCheckpointFile {
  readonly version: 1;
  readonly checkpoints: SessionHitlCheckpointRecord[];
  readonly updatedAt: string;
}

const ToolExecutionOriginSchema: z.ZodType<ToolExecutionOrigin> = z.strictObject({
  kind: z.literal("loop"),
  loopId: z.string(),
  runId: z.string().optional(),
  trigger: z.union([
    z.enum(["manual", "interval", "cron"]),
    z.enum(["on_commit", "on_pr", "on_ci_fail"]),
  ]),
  approvalPolicy: z.enum(["interactive", "explicit_per_run"]),
});

const SessionHitlJournalPhaseSchema = z.enum([
  "preparing",
  "paused",
  "replaying",
  "continuing",
  "continued",
  "resolving",
  "manual_unknown",
]);

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

const PreparedRequestSchema: z.ZodType<SessionHitlPreparedRequest> = z.strictObject({
  owner: HitlOwnerKeySchema,
  displayPayload: HitlDisplayPayloadSchema,
  createdAt: z.string(),
});

const HitlSourceSchema: z.ZodType<HitlSource> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ask_user"), sessionId: z.string(), toolCallId: z.string().optional() }),
  z.strictObject({ type: z.literal("tool_permission"), sessionId: z.string(), toolCallId: z.string(), toolName: z.string() }),
  z.strictObject({ type: z.literal("goal_approval"), goalId: z.string(), approvalPoint: z.string().optional() }),
  z.strictObject({ type: z.literal("goal_review"), goalId: z.string() }),
  z.strictObject({ type: z.literal("goal_budget"), goalId: z.string(), approvalPoint: z.string().optional() }),
  z.strictObject({ type: z.literal("goal_question"), goalId: z.string(), questionKey: z.string() }),
  z.strictObject({ type: z.literal("loop_approval"), loopId: z.string(), approvalPoint: z.string() }),
  z.strictObject({ type: z.literal("loop_blocker"), loopId: z.string(), runId: z.string().optional(), reason: z.string() }),
  z.strictObject({ type: z.literal("loop_retry"), loopId: z.string(), runId: z.string(), attempt: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal("loop_question"), loopId: z.string(), questionKey: z.string() }),
]);

const ToolCallCheckpointSchema: z.ZodType<SessionHitlToolCallCheckpoint> = z.strictObject({
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
});

const CompletedToolResultSchema: z.ZodType<SessionHitlCompletedToolResult> = z.strictObject({
  toolCallId: z.string(),
  toolName: z.string(),
  output: z.string(),
  isError: z.boolean(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const CheckpointRecordSchema: z.ZodType<SessionHitlCheckpointRecord> = z.strictObject({
  version: z.literal(1),
  phase: SessionHitlJournalPhaseSchema.optional(),
  phaseUpdatedAt: z.string().optional(),
  hitlId: z.string().trim().min(1),
  blockingKey: z.string().trim().min(1),
  source: HitlSourceSchema,
  toolCallId: z.string(),
  toolName: z.string(),
  step: z.number(),
  assistantMessageId: z.string().optional(),
  rawToolInput: z.unknown(),
  displayInput: z.unknown(),
  allowedTools: z.array(z.string()),
  agentSkills: z.array(z.string()),
  agentName: z.string().optional(),
  currentDepth: z.number().optional(),
  origin: ToolExecutionOriginSchema.optional(),
  toolCalls: z.array(ToolCallCheckpointSchema),
  completedToolResults: z.array(CompletedToolResultSchema),
  pendingToolCalls: z.array(ToolCallCheckpointSchema),
  blockedToolIndex: z.number().int().nonnegative(),
  createdAt: z.string(),
  kind: z.enum(["ask_user", "permission"]),
  request: PreparedRequestSchema.optional(),
  permission: z.strictObject({
    description: z.string(),
    reason: z.string().optional(),
    approval: z.unknown().optional(),
    decisionDisplay: z.string().optional(),
    ruleId: z.string().optional(),
  }).optional(),
});

const CheckpointFileSchema: z.ZodType<SessionHitlCheckpointFile> = z.strictObject({
  version: z.literal(1),
  checkpoints: z.array(CheckpointRecordSchema),
  updatedAt: z.string(),
});

export function getSessionHitlCheckpointPath(workspaceRoot: string, sessionId: string): string {
  return join(getSessionDir(workspaceRoot, sessionId), "hitl-checkpoints.json");
}

export async function readSessionHitlCheckpointFile(workspaceRoot: string, sessionId: string): Promise<SessionHitlCheckpointFile> {
  const path = getSessionHitlCheckpointPath(workspaceRoot, sessionId);
  return await withCheckpointFileMutationLock(path, async () => (
    readSessionHitlCheckpointFileUnlocked(workspaceRoot, sessionId)
  ));
}

async function readSessionHitlCheckpointFileUnlocked(workspaceRoot: string, sessionId: string): Promise<SessionHitlCheckpointFile> {
  const path = getSessionHitlCheckpointPath(workspaceRoot, sessionId);
  const file = Bun.file(path);
  if (!(await file.exists())) return emptyCheckpointFile();
  return CheckpointFileSchema.parse(JSON.parse(await file.text()));
}

export async function writeSessionHitlCheckpoint(record: SessionHitlCheckpointRecord, workspaceRoot: string, sessionId: string): Promise<void> {
  await withCheckpointFileMutationLock(getSessionHitlCheckpointPath(workspaceRoot, sessionId), async () => {
    const current = await readSessionHitlCheckpointFileUnlocked(workspaceRoot, sessionId);
    const checkpoints = current.checkpoints.filter((entry) => entry.hitlId !== record.hitlId);
    checkpoints.push(CheckpointRecordSchema.parse(record));
    await writeCheckpointFile({ version: 1, checkpoints, updatedAt: new Date().toISOString() }, workspaceRoot, sessionId);
  });
}

export async function readSessionHitlCheckpoint(workspaceRoot: string, sessionId: string, hitlId: string): Promise<SessionHitlCheckpointRecord | undefined> {
  const file = await readSessionHitlCheckpointFile(workspaceRoot, sessionId);
  return file.checkpoints.find((entry) => entry.hitlId === hitlId);
}

export async function readSessionHitlCheckpointByBlockingKey(
  workspaceRoot: string,
  sessionId: string,
  blockingKey: string,
): Promise<SessionHitlCheckpointRecord | undefined> {
  const file = await readSessionHitlCheckpointFile(workspaceRoot, sessionId);
  return file.checkpoints.find((entry) => entry.blockingKey === blockingKey);
}

export async function deleteSessionHitlCheckpoint(workspaceRoot: string, sessionId: string, hitlId: string): Promise<void> {
  await withCheckpointFileMutationLock(getSessionHitlCheckpointPath(workspaceRoot, sessionId), async () => {
    const current = await readSessionHitlCheckpointFileUnlocked(workspaceRoot, sessionId);
    const checkpoints = current.checkpoints.filter((entry) => entry.hitlId !== hitlId);
    if (checkpoints.length === current.checkpoints.length) return;
    await writeCheckpointFile({ version: 1, checkpoints, updatedAt: new Date().toISOString() }, workspaceRoot, sessionId);
  });
}

export function sessionHitlJournalPhase(record: SessionHitlCheckpointRecord): SessionHitlJournalPhase {
  return record.phase ?? "paused";
}

export class SessionHitlJournalPhaseError extends Error {
  constructor(
    public readonly hitlId: string,
    public readonly current: SessionHitlJournalPhase,
    public readonly requested: SessionHitlJournalPhase,
  ) {
    super(`Cannot transition Session HITL ${hitlId} from ${current} to ${requested}`);
    this.name = "SessionHitlJournalPhaseError";
  }
}

export async function transitionSessionHitlJournalPhase(
  workspaceRoot: string,
  sessionId: string,
  hitlId: string,
  phase: SessionHitlJournalPhase,
): Promise<SessionHitlCheckpointRecord> {
  return await withCheckpointFileMutationLock(getSessionHitlCheckpointPath(workspaceRoot, sessionId), async () => {
    const current = await readSessionHitlCheckpointFileUnlocked(workspaceRoot, sessionId);
    const index = current.checkpoints.findIndex((entry) => entry.hitlId === hitlId);
    if (index === -1) throw new Error(`Missing Session HITL journal entry ${hitlId}`);
    const record = current.checkpoints[index]!;
    const currentPhase = sessionHitlJournalPhase(record);
    if (currentPhase === phase) return record;
    if (!allowedJournalTransitions[currentPhase].has(phase)) {
      throw new SessionHitlJournalPhaseError(hitlId, currentPhase, phase);
    }
    const updated = CheckpointRecordSchema.parse({
      ...record,
      phase,
      phaseUpdatedAt: new Date().toISOString(),
    });
    const checkpoints = [...current.checkpoints];
    checkpoints[index] = updated;
    await writeCheckpointFile({ version: 1, checkpoints, updatedAt: updated.phaseUpdatedAt! }, workspaceRoot, sessionId);
    return updated;
  });
}

export async function replaceSessionHitlCheckpoint(
  workspaceRoot: string,
  sessionId: string,
  previousHitlId: string,
  replacement: SessionHitlCheckpointRecord,
): Promise<SessionHitlCheckpointRecord> {
  return await withCheckpointFileMutationLock(getSessionHitlCheckpointPath(workspaceRoot, sessionId), async () => {
    const current = await readSessionHitlCheckpointFileUnlocked(workspaceRoot, sessionId);
    const index = current.checkpoints.findIndex((entry) => entry.hitlId === previousHitlId);
    if (index === -1) throw new Error(`Missing Session HITL journal entry ${previousHitlId}`);
    const parsed = CheckpointRecordSchema.parse(replacement);
    const collision = current.checkpoints.find((entry, candidateIndex) => (
      candidateIndex !== index && entry.hitlId === parsed.hitlId
    ));
    if (collision !== undefined) throw new Error(`Duplicate Session HITL journal entry ${parsed.hitlId}`);
    const checkpoints = [...current.checkpoints];
    checkpoints[index] = parsed;
    await writeCheckpointFile({ version: 1, checkpoints, updatedAt: new Date().toISOString() }, workspaceRoot, sessionId);
    return parsed;
  });
}

export function isResponseForSessionCheckpoint(checkpoint: SessionHitlCheckpointRecord, response: HitlResponse): boolean {
  if (checkpoint.kind === "ask_user") return response.type === "question_answer" || response.type === "cancel";
  return checkpoint.kind === "permission" && (response.type === "permission_decision" || response.type === "cancel");
}

async function writeCheckpointFile(file: SessionHitlCheckpointFile, workspaceRoot: string, sessionId: string): Promise<void> {
  const dir = getSessionDir(workspaceRoot, sessionId);
  await mkdir(dir, { recursive: true });
  const finalPath = getSessionHitlCheckpointPath(workspaceRoot, sessionId);
  const tmpPath = join(dir, `hitl-checkpoints.${crypto.randomUUID()}.json.tmp`);
  await Bun.write(tmpPath, `${JSON.stringify(CheckpointFileSchema.parse(file), null, 2)}\n`);
  await rename(tmpPath, finalPath);
}

function emptyCheckpointFile(): SessionHitlCheckpointFile {
  return { version: 1, checkpoints: [], updatedAt: new Date().toISOString() };
}

export async function deleteSessionHitlCheckpointFile(workspaceRoot: string, sessionId: string): Promise<void> {
  const path = getSessionHitlCheckpointPath(workspaceRoot, sessionId);
  await withCheckpointFileMutationLock(path, async () => {
    await rm(path, { force: true });
  });
}

const allowedJournalTransitions: Record<SessionHitlJournalPhase, ReadonlySet<SessionHitlJournalPhase>> = {
  preparing: new Set(["paused"]),
  paused: new Set(["replaying", "continued", "resolving"]),
  replaying: new Set(["continuing", "continued", "resolving"]),
  continuing: new Set(["continued", "manual_unknown", "resolving"]),
  continued: new Set(["resolving"]),
  resolving: new Set(),
  manual_unknown: new Set(["resolving"]),
};

const checkpointFileMutationLocks = new Map<string, Promise<void>>();

async function withCheckpointFileMutationLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = checkpointFileMutationLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  const tail = previous.then(() => current, () => current);
  checkpointFileMutationLocks.set(filePath, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (checkpointFileMutationLocks.get(filePath) === tail) checkpointFileMutationLocks.delete(filePath);
  }
}
