import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type {
  HitlDisplayPayload,
  HitlOwnerKey,
  HitlResponse,
  HitlSource,
} from "@archcode/protocol";

import { getSessionDir } from "../store/sessions-dir";
import { atomicWrite } from "../utils/safe-file";

export interface SessionHitlToolCallEntry {
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

type SessionHitlSource = Extract<HitlSource, { readonly type: "ask_user" | "tool_permission" }>;

export interface SessionHitlJournalEntry {
  readonly phase: SessionHitlJournalPhase;
  readonly phaseUpdatedAt: string;
  readonly hitlId: string;
  readonly blockingKey: string;
  readonly source: SessionHitlSource;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly step: number;
  readonly assistantMessageId?: string;
  readonly rawToolInput: unknown;
  readonly displayInput: unknown;
  readonly allowedTools: string[];
  readonly agentSkills: string[];
  readonly agentName: string;
  readonly currentDepth?: number;
  readonly toolCalls: SessionHitlToolCallEntry[];
  readonly completedToolResults: SessionHitlCompletedToolResult[];
  readonly pendingToolCalls: SessionHitlToolCallEntry[];
  readonly blockedToolIndex: number;
  readonly createdAt: string;
  /** Durable request data lets cold repair recreate the owner record. */
  readonly request: SessionHitlPreparedRequest;
  readonly permission?: {
    readonly description: string;
    readonly reason?: string;
    readonly approval?: unknown;
    readonly decisionDisplay?: string;
    readonly ruleId?: string;
  };
}

export interface SessionHitlJournalFile {
  readonly entries: SessionHitlJournalEntry[];
  readonly updatedAt: string;
}

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
  ownerType: z.enum(["session", "goal"]),
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

const HitlSourceSchema: z.ZodType<SessionHitlSource> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ask_user"), sessionId: z.string(), toolCallId: z.string().optional() }),
  z.strictObject({ type: z.literal("tool_permission"), sessionId: z.string(), toolCallId: z.string(), toolName: z.string() }),
]);

const ToolCallEntrySchema: z.ZodType<SessionHitlToolCallEntry> = z.strictObject({
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

const EntryRecordSchema: z.ZodType<SessionHitlJournalEntry> = z.strictObject({
  phase: SessionHitlJournalPhaseSchema,
  phaseUpdatedAt: z.string(),
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
  agentName: z.string().trim().min(1),
  currentDepth: z.number().optional(),
  toolCalls: z.array(ToolCallEntrySchema),
  completedToolResults: z.array(CompletedToolResultSchema),
  pendingToolCalls: z.array(ToolCallEntrySchema),
  blockedToolIndex: z.number().int().nonnegative(),
  createdAt: z.string(),
  request: PreparedRequestSchema,
  permission: z.strictObject({
    description: z.string(),
    reason: z.string().optional(),
    approval: z.unknown().optional(),
    decisionDisplay: z.string().optional(),
    ruleId: z.string().optional(),
  }).optional(),
}).superRefine((record, ctx) => {
  const owner = record.request.owner;
  if (owner.ownerType !== "session") {
    ctx.addIssue({ code: "custom", path: ["request", "owner", "ownerType"], message: "Session HITL owner must be a Session" });
  }

  if (record.source.type === "ask_user") {
    if (record.source.sessionId !== owner.ownerId) {
      ctx.addIssue({ code: "custom", path: ["source", "sessionId"], message: "Entry source must match its Session owner" });
    }
    if (record.source.toolCallId !== undefined && record.source.toolCallId !== record.toolCallId) {
      ctx.addIssue({ code: "custom", path: ["source", "toolCallId"], message: "Entry source tool call must match the blocked tool call" });
    }
    if (record.permission !== undefined) {
      ctx.addIssue({ code: "custom", path: ["permission"], message: "ask_user entries cannot contain permission metadata" });
    }
    return;
  }

  if (record.source.sessionId !== owner.ownerId) {
    ctx.addIssue({ code: "custom", path: ["source", "sessionId"], message: "Entry source must match its Session owner" });
  }
  if (record.source.toolCallId !== record.toolCallId) {
    ctx.addIssue({ code: "custom", path: ["source", "toolCallId"], message: "Entry source tool call must match the blocked tool call" });
  }
  if (record.source.toolName !== record.toolName) {
    ctx.addIssue({ code: "custom", path: ["source", "toolName"], message: "Entry source tool name must match the blocked tool" });
  }
  if (record.permission === undefined) {
    ctx.addIssue({ code: "custom", path: ["permission"], message: "permission entries require permission metadata" });
  }
});

const EntryFileSchema: z.ZodType<SessionHitlJournalFile> = z.strictObject({
  entries: z.array(EntryRecordSchema),
  updatedAt: z.string(),
}).superRefine((file, ctx) => {
  const hitlIds = new Set<string>();
  const blockingKeys = new Set<string>();
  file.entries.forEach((entry, index) => {
    if (hitlIds.has(entry.hitlId)) {
      ctx.addIssue({ code: "custom", path: ["entries", index, "hitlId"], message: `Duplicate Session HITL id: ${entry.hitlId}` });
    }
    hitlIds.add(entry.hitlId);
    if (blockingKeys.has(entry.blockingKey)) {
      ctx.addIssue({ code: "custom", path: ["entries", index, "blockingKey"], message: `Duplicate Session HITL blocking key: ${entry.blockingKey}` });
    }
    blockingKeys.add(entry.blockingKey);
  });
});

export function getSessionHitlJournalPath(workspaceRoot: string, sessionId: string): string {
  return join(getSessionDir(workspaceRoot, sessionId), "hitl-journal.json");
}

export async function readSessionHitlJournalFile(workspaceRoot: string, sessionId: string): Promise<SessionHitlJournalFile> {
  const path = getSessionHitlJournalPath(workspaceRoot, sessionId);
  return await withEntryFileMutationLock(path, async () => (
    readSessionHitlJournalFileUnlocked(workspaceRoot, sessionId)
  ));
}

async function readSessionHitlJournalFileUnlocked(workspaceRoot: string, sessionId: string): Promise<SessionHitlJournalFile> {
  const path = getSessionHitlJournalPath(workspaceRoot, sessionId);
  const file = Bun.file(path);
  if (!(await file.exists())) return emptyEntryFile();
  return parseEntryFile(JSON.parse(await file.text()), sessionId);
}

export async function writeSessionHitlJournalEntry(record: SessionHitlJournalEntry, workspaceRoot: string, sessionId: string): Promise<void> {
  await withEntryFileMutationLock(getSessionHitlJournalPath(workspaceRoot, sessionId), async () => {
    const current = await readSessionHitlJournalFileUnlocked(workspaceRoot, sessionId);
    const entries = current.entries.filter((entry) => entry.hitlId !== record.hitlId);
    entries.push(EntryRecordSchema.parse(record));
    await writeEntryFile({ entries, updatedAt: new Date().toISOString() }, workspaceRoot, sessionId);
  });
}

export async function readSessionHitlJournalEntry(workspaceRoot: string, sessionId: string, hitlId: string): Promise<SessionHitlJournalEntry | undefined> {
  const file = await readSessionHitlJournalFile(workspaceRoot, sessionId);
  return file.entries.find((entry) => entry.hitlId === hitlId);
}

export async function readSessionHitlJournalEntryByBlockingKey(
  workspaceRoot: string,
  sessionId: string,
  blockingKey: string,
): Promise<SessionHitlJournalEntry | undefined> {
  const file = await readSessionHitlJournalFile(workspaceRoot, sessionId);
  return file.entries.find((entry) => entry.blockingKey === blockingKey);
}

export async function deleteSessionHitlJournalEntry(workspaceRoot: string, sessionId: string, hitlId: string): Promise<void> {
  await withEntryFileMutationLock(getSessionHitlJournalPath(workspaceRoot, sessionId), async () => {
    const current = await readSessionHitlJournalFileUnlocked(workspaceRoot, sessionId);
    const entries = current.entries.filter((entry) => entry.hitlId !== hitlId);
    if (entries.length === current.entries.length) return;
    await writeEntryFile({ entries, updatedAt: new Date().toISOString() }, workspaceRoot, sessionId);
  });
}

export function sessionHitlJournalPhase(record: SessionHitlJournalEntry): SessionHitlJournalPhase {
  return record.phase;
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
): Promise<SessionHitlJournalEntry> {
  return await withEntryFileMutationLock(getSessionHitlJournalPath(workspaceRoot, sessionId), async () => {
    const current = await readSessionHitlJournalFileUnlocked(workspaceRoot, sessionId);
    const index = current.entries.findIndex((entry) => entry.hitlId === hitlId);
    if (index === -1) throw new Error(`Missing Session HITL journal entry ${hitlId}`);
    const record = current.entries[index]!;
    const currentPhase = sessionHitlJournalPhase(record);
    if (currentPhase === phase) return record;
    if (!allowedJournalTransitions[currentPhase].has(phase)) {
      throw new SessionHitlJournalPhaseError(hitlId, currentPhase, phase);
    }
    const updated = EntryRecordSchema.parse({
      ...record,
      phase,
      phaseUpdatedAt: new Date().toISOString(),
    });
    const entries = [...current.entries];
    entries[index] = updated;
    await writeEntryFile({ entries, updatedAt: updated.phaseUpdatedAt }, workspaceRoot, sessionId);
    return updated;
  });
}

export async function replaceSessionHitlJournalEntry(
  workspaceRoot: string,
  sessionId: string,
  previousHitlId: string,
  replacement: SessionHitlJournalEntry,
): Promise<SessionHitlJournalEntry> {
  return await withEntryFileMutationLock(getSessionHitlJournalPath(workspaceRoot, sessionId), async () => {
    const current = await readSessionHitlJournalFileUnlocked(workspaceRoot, sessionId);
    const index = current.entries.findIndex((entry) => entry.hitlId === previousHitlId);
    if (index === -1) throw new Error(`Missing Session HITL journal entry ${previousHitlId}`);
    const parsed = EntryRecordSchema.parse(replacement);
    const collision = current.entries.find((entry, candidateIndex) => (
      candidateIndex !== index && entry.hitlId === parsed.hitlId
    ));
    if (collision !== undefined) throw new Error(`Duplicate Session HITL journal entry ${parsed.hitlId}`);
    const entries = [...current.entries];
    entries[index] = parsed;
    await writeEntryFile({ entries, updatedAt: new Date().toISOString() }, workspaceRoot, sessionId);
    return parsed;
  });
}

export function isResponseForSessionHitlJournalEntry(entry: SessionHitlJournalEntry, response: HitlResponse): boolean {
  if (entry.source.type === "ask_user") return response.type === "question_answer" || response.type === "cancel";
  return response.type === "permission_decision" || response.type === "cancel";
}

async function writeEntryFile(file: SessionHitlJournalFile, workspaceRoot: string, sessionId: string): Promise<void> {
  const finalPath = getSessionHitlJournalPath(workspaceRoot, sessionId);
  await atomicWrite(finalPath, `${JSON.stringify(parseEntryFile(file, sessionId), null, 2)}\n`);
}

function parseEntryFile(file: unknown, sessionId: string): SessionHitlJournalFile {
  const parsed = EntryFileSchema.parse(file);
  parsed.entries.forEach((entry, index) => {
    if (entry.request.owner.ownerId !== sessionId) {
      throw new Error(`Session HITL entry ${index} owner does not match Session ${sessionId}`);
    }
  });
  return parsed;
}

function emptyEntryFile(): SessionHitlJournalFile {
  return { entries: [], updatedAt: new Date().toISOString() };
}

export async function deleteSessionHitlJournalFile(workspaceRoot: string, sessionId: string): Promise<void> {
  const path = getSessionHitlJournalPath(workspaceRoot, sessionId);
  await withEntryFileMutationLock(path, async () => {
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

const entryFileMutationLocks = new Map<string, Promise<void>>();

async function withEntryFileMutationLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = entryFileMutationLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  const tail = previous.then(() => current, () => current);
  entryFileMutationLocks.set(filePath, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (entryFileMutationLocks.get(filePath) === tail) entryFileMutationLocks.delete(filePath);
  }
}
