import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod/v4";
import type { SessionEventEnvelope, SessionStoreState, StoredMessage } from "./types";
import type { SessionModelInfo } from "@archcode/protocol";
import { getRootSessionDir, getRootSessionPath, getSessionPath, getSessionsDir } from "./sessions-dir";
import type { SessionRole } from "./types";
import {
  COMPRESSION_BLOCK_STATUSES,
  COMPRESSION_STATE_VERSION,
  COMPRESSION_STRATEGIES,
  COMPRESSION_SUMMARY_FORMAT_VERSION,
  COMPRESSION_SUMMARY_SECTION_NAMES,
  COMPRESSION_TRIGGERS,
  PROTECTED_CONTENT_KINDS,
  createEmptyCompressionState,
} from "../compression";

const SessionRoleSchema = z.enum(["main", "plan", "build", "review", "explore", "librarian", "standalone"]);

const SessionModelInfoSchema = z.strictObject({
  displayName: z.string(),
  modelId: z.string(),
  providerId: z.string(),
  qualifiedId: z.string(),
});

const NormalizedUsageSchema = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  reasoningTokens: z.number(),
  cachedInputTokens: z.number(),
});

const SessionStatsSchema = z.strictObject({
  messages: z.strictObject({
    user: z.number(),
    assistant: z.number(),
    total: z.number(),
  }),
  tools: z.strictObject({
    calls: z.number(),
    completed: z.number(),
    failed: z.number(),
  }),
  steps: z.strictObject({
    started: z.number(),
    completed: z.number(),
  }),
  usage: NormalizedUsageSchema,
});

const SessionExecutionRecordSchema = z.strictObject({
  id: z.string(),
  startedAt: z.number(),
  status: z.enum(["running", "completed", "max_steps", "failed", "aborted", "cancelled", "timed_out", "interrupted"]),
  endedAt: z.number().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
});

const StoredTodoSchema = z.strictObject({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

const PendingInteractionSchema = z.strictObject({
  id: z.string(),
  type: z.enum(["decision", "approval", "clarification"]),
  question: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
  askedAt: z.string(),
  status: z.enum(["pending", "answered", "expired"]),
  answer: z.strictObject({
    content: z.string(),
    answeredAt: z.string(),
  }).optional(),
});

const ReminderSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("todo_step_reminder"),
    pendingTodos: z.array(StoredTodoSchema),
  }),
  z.strictObject({
    type: z.literal("todo_loop_continuation"),
    pendingTodos: z.array(StoredTodoSchema),
  }),
  z.strictObject({
    type: z.literal("subagent_completed"),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal("subagent_failed"),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal("subagent_timed_out"),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal("subagent_cancelled"),
    sessionId: z.string(),
  }),
]);

const ReminderSchema = z.strictObject({
  id: z.string(),
  source: ReminderSourceSchema,
  delivery: z.enum(["auto_inject", "on_demand"]),
  sessionId: z.string().optional(),
  terminalState: z.string().optional(),
  content: z.string(),
  payload: z.unknown().optional(),
  createdAt: z.number(),
  consumedAt: z.number().nullable(),
  targetSessionId: z.string().optional(),
});

const ToolChildSessionLinkSchema = z.strictObject({
  parentSessionId: z.string(),
  parentToolCallId: z.string(),
  toolName: z.string(),
  childSessionId: z.string(),
  childAgentName: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  depth: z.number(),
  background: z.boolean(),
  status: z.enum([
    "linked",
    "running",
    "cancelling",
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "interrupted",
  ]),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  durationMs: z.number().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
});

const TextPartSchema = z.strictObject({
  type: z.literal("text"),
  id: z.string(),
  text: z.string(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const ReasoningPartSchema = z.strictObject({
  type: z.literal("reasoning"),
  id: z.string(),
  text: z.string(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const PendingToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("pending"),
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  createdAt: z.number(),
  attemptId: z.string().optional(),
  attemptTimestamp: z.number().optional(),
  attemptDestructive: z.boolean().optional(),
});

const RunningToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("running"),
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  createdAt: z.number(),
  startedAt: z.number(),
  attemptId: z.string().optional(),
  attemptTimestamp: z.number().optional(),
  attemptDestructive: z.boolean().optional(),
});

const CompletedToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("completed"),
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  output: z.string(),
  createdAt: z.number(),
  startedAt: z.number(),
  endedAt: z.number(),
  meta: z.record(z.string(), z.unknown()).optional(),
  attemptId: z.string().optional(),
  attemptTimestamp: z.number().optional(),
  attemptDestructive: z.boolean().optional(),
});

const ErrorToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("error"),
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  errorMessage: z.string(),
  createdAt: z.number(),
  startedAt: z.number(),
  endedAt: z.number(),
  meta: z.record(z.string(), z.unknown()).optional(),
  attemptId: z.string().optional(),
  attemptTimestamp: z.number().optional(),
  attemptDestructive: z.boolean().optional(),
});

const ToolPartSchema = z.discriminatedUnion("state", [
  PendingToolPartSchema,
  RunningToolPartSchema,
  CompletedToolPartSchema,
  ErrorToolPartSchema,
]);

const CompactionPartSchema = z.strictObject({
  type: z.literal("compaction"),
  id: z.string(),
  summary: z.string(),
  tailStartId: z.string(),
  compactedAt: z.number(),
});

const SystemNoticePartSchema = z.strictObject({
  type: z.literal("system-notice"),
  id: z.string(),
  notice: z.string(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
});

const RecoveryNoticePartSchema = z.strictObject({
  type: z.literal("recovery-notice"),
  id: z.string(),
  status: z.enum(["scheduled", "retrying", "recovered", "failed"]),
  message: z.string(),
  attempt: z.number(),
  nextRetryAt: z.number().optional(),
  errorKind: z.string().optional(),
  statusCode: z.number().optional(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
});

const StoredPartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ReasoningPartSchema,
  ToolPartSchema,
  CompactionPartSchema,
  SystemNoticePartSchema,
  RecoveryNoticePartSchema,
]);

const StoredMessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(StoredPartSchema),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  executionId: z.string().optional(),
  compacted: z.boolean().optional(),
});

const StepInfoSchema = z.strictObject({
  id: z.string(),
  step: z.number(),
  executionId: z.string().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  finishReason: z.string().optional(),
  usage: z.unknown().optional(),
  error: z.string().optional(),
});

const MessageRefSchema = z.custom<`m${string}`>(
  (value) => typeof value === "string" && /^m\d+$/.test(value),
  "Expected compression message ref like m0001",
);

const BlockRefSchema = z.custom<`b${number}`>(
  (value) => typeof value === "string" && /^b\d+$/.test(value),
  "Expected compression block ref like b1",
);

const CompressionRefMapSchema = z.strictObject({
  messageRefsById: z.record(z.string(), MessageRefSchema),
  messageIdsByRef: z.record(MessageRefSchema, z.string()),
  blockRefsById: z.record(z.string(), BlockRefSchema),
  blockIdsByRef: z.record(BlockRefSchema, z.string()),
  nextMessageIndex: z.number(),
  nextBlockIndex: z.number(),
});

const CompressionRangeSchema = z.strictObject({
  startMessageId: z.string(),
  endMessageId: z.string(),
  startRef: MessageRefSchema,
  endRef: MessageRefSchema,
  startIndex: z.number(),
  endIndex: z.number(),
});

const CompressionTokenEstimateSchema = z.strictObject({
  originalTokens: z.number(),
  summaryTokens: z.number(),
  savedTokens: z.number(),
  estimatedAt: z.number(),
});

const ProtectedRefSchema = z.strictObject({
  ref: z.union([MessageRefSchema, BlockRefSchema]),
  kind: z.enum(PROTECTED_CONTENT_KINDS),
  reason: z.string(),
  messageId: z.string().optional(),
  partId: z.string().optional(),
});

const CompressionSummarySchema = z.strictObject({
  version: z.literal(COMPRESSION_SUMMARY_FORMAT_VERSION),
  sections: z.strictObject(Object.fromEntries(
    COMPRESSION_SUMMARY_SECTION_NAMES.map((section) => [section, z.string()]),
  ) as Record<(typeof COMPRESSION_SUMMARY_SECTION_NAMES)[number], z.ZodString>),
  childBlockRefs: z.array(BlockRefSchema),
});

const CompressionBlockSchema = z.strictObject({
  id: z.string(),
  ref: BlockRefSchema,
  status: z.enum(COMPRESSION_BLOCK_STATUSES),
  strategy: z.enum(COMPRESSION_STRATEGIES),
  trigger: z.enum(COMPRESSION_TRIGGERS),
  range: CompressionRangeSchema,
  summary: CompressionSummarySchema,
  protectedRefs: z.array(ProtectedRefSchema),
  childBlockRefs: z.array(BlockRefSchema),
  tokenEstimate: CompressionTokenEstimateSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  deactivatedAt: z.number().optional(),
  supersededBy: BlockRefSchema.optional(),
});

const CompressionFailureSchema = z.strictObject({
  id: z.string(),
  reason: z.string(),
  startRef: MessageRefSchema.optional(),
  endRef: MessageRefSchema.optional(),
  strategy: z.enum(COMPRESSION_STRATEGIES).optional(),
  failedAt: z.number(),
});

const CompressionStateSchema = z.strictObject({
  version: z.literal(COMPRESSION_STATE_VERSION),
  refMap: CompressionRefMapSchema,
  blocksByRef: z.record(BlockRefSchema, CompressionBlockSchema),
  activeBlockRefs: z.array(BlockRefSchema),
  inactiveBlockRefs: z.array(BlockRefSchema),
  supersededBlockRefs: z.array(BlockRefSchema),
  protectedRefs: z.array(ProtectedRefSchema),
  failures: z.array(CompressionFailureSchema),
  updatedAt: z.number().optional(),
});

const SessionEventEnvelopeSchema = z.strictObject({
  id: z.number(),
  createdAt: z.number(),
  kind: z.string(),
  payload: z.unknown(),
}).transform((value) => value as SessionEventEnvelope);

export const SessionFileSchema = z.strictObject({
  sessionId: z.string(),
  createdAt: z.number(),
  agentName: z.string(),
  modelInfo: SessionModelInfoSchema.nullable().optional(),
  title: z.string().nullable().optional(),
  messages: z.array(StoredMessageSchema),
  steps: z.array(StepInfoSchema),
  stats: SessionStatsSchema,
  executions: z.array(SessionExecutionRecordSchema),
  compression: CompressionStateSchema.default(() => createEmptyCompressionState()),
  events: z.array(SessionEventEnvelopeSchema).optional(),
  todos: z.array(StoredTodoSchema)
    .refine(
      (todos) => todos.filter((todo) => todo.status === "in_progress").length <= 1,
      "Only one todo can be in_progress",
    )
    .optional(),
  pendingInteractions: z.array(PendingInteractionSchema).default([]),
  reminders: z.array(ReminderSchema).default([]),
  childSessionLinks: z.array(ToolChildSessionLinkSchema).default([]),
  // Tree edges are read from each child file; parent files intentionally keep no child cache.
  rootSessionId: z.string(),
  parentSessionId: z.string().optional(),
  goalId: z.string().uuid().optional(),
  loopId: z.string().uuid().optional(),
  sessionRole: SessionRoleSchema.optional(),
  eventCursor: z.number().optional(),
});

export type HydratedSessionFile = z.output<typeof SessionFileSchema>;
export type SessionFile = Omit<HydratedSessionFile, "compression"> & {
  readonly compression?: HydratedSessionFile["compression"];
};

export interface SessionSummary {
  sessionId: string;
  rootSessionId: string;
  parentSessionId?: string;
  goalId?: string;
  loopId?: string;
  sessionRole?: SessionRole;
  agentName?: string | null;
  modelInfo?: SessionModelInfo | null;
  title?: string | null;
  createdAt: number;
  lastUpdatedAt?: number;
}

type PersistableSessionState = Pick<
  SessionStoreState,
  "sessionId" | "createdAt" | "agentName" | "modelInfo" | "title" | "messages" | "steps" | "stats" | "executions" | "todos" | "rootSessionId"
> & Partial<Pick<
  SessionStoreState,
  "compression" | "pendingInteractions" | "reminders" | "childSessionLinks" | "parentSessionId" | "goalId" | "loopId" | "sessionRole" | "events"
>>;

export function getAssistantText(messages: StoredMessage[]): string {
  let text = "";

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    for (const part of message.parts) {
      if (part.type === "text" && part.completedAt !== undefined) {
        if (part.meta?.interrupted === true || part.meta?.discardedFromContext === true) continue;
        text += part.text;
      }
    }
  }

  return text;
}

async function saveSessionTranscript(
  state: PersistableSessionState,
  workspaceRoot: string,
): Promise<void> {
  const finalPath = getSessionPath(workspaceRoot, state.rootSessionId, state.sessionId);
  const dir = state.rootSessionId === state.sessionId
    ? getSessionsDir(workspaceRoot)
    : getRootSessionDir(workspaceRoot, state.rootSessionId);

  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create sessions directory "${dir}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const data: HydratedSessionFile = {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    agentName: state.agentName,
    title: state.title ?? null,
    messages: state.messages,
    steps: state.steps,
    stats: state.stats,
    executions: state.executions,
    compression: state.compression ?? createEmptyCompressionState(),
    todos: state.todos,
    pendingInteractions: state.pendingInteractions ?? [],
    reminders: state.reminders ?? [],
    childSessionLinks: state.childSessionLinks ?? [],
    rootSessionId: state.rootSessionId,
    ...((state.events?.length ?? 0) === 0 ? {} : { events: state.events }),
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
    ...(state.goalId === undefined ? {} : { goalId: state.goalId }),
    ...(state.loopId === undefined ? {} : { loopId: state.loopId }),
    ...(state.sessionRole === undefined ? {} : { sessionRole: state.sessionRole }),
    ...(state.modelInfo === undefined ? {} : { modelInfo: state.modelInfo }),
  };

  const json = JSON.stringify(data, null, 2);
  const tmpPath = join(dir, `${state.sessionId}.${randomUUID()}.json.tmp`);

  try {
    await Bun.write(tmpPath, json);
  } catch (err) {
    throw new Error(`Failed to write session transcript to "${tmpPath}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    throw new Error(`Failed to rename session transcript from "${tmpPath}" to "${finalPath}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

async function readSessionFile(
  sessionId: string,
  workspaceRoot: string,
  rootSessionId?: string,
): Promise<HydratedSessionFile> {
  const filePath = rootSessionId === undefined
    ? getRootSessionPath(workspaceRoot, sessionId)
    : getSessionPath(workspaceRoot, rootSessionId, sessionId);
  const parsed = await readValidatedSessionFile(filePath);

  if (parsed.sessionId !== sessionId) {
    throw new Error(
      `Session ID mismatch: expected "${sessionId}", found "${parsed.sessionId}" in file`,
    );
  }

  return parsed;
}

function toSessionFile(state: PersistableSessionState & Pick<SessionStoreState, "nextEventId">): HydratedSessionFile {
  return {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    agentName: state.agentName,
    title: state.title ?? null,
    messages: state.messages,
    steps: state.steps,
    stats: state.stats,
    executions: state.executions,
    compression: state.compression ?? createEmptyCompressionState(),
    todos: state.todos,
    pendingInteractions: state.pendingInteractions ?? [],
    reminders: state.reminders ?? [],
    childSessionLinks: state.childSessionLinks ?? [],
    rootSessionId: state.rootSessionId,
    eventCursor: state.nextEventId > 0 ? state.nextEventId - 1 : -1,
    ...((state.events?.length ?? 0) === 0 ? {} : { events: state.events }),
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
    ...(state.goalId === undefined ? {} : { goalId: state.goalId }),
    ...(state.loopId === undefined ? {} : { loopId: state.loopId }),
    ...(state.sessionRole === undefined ? {} : { sessionRole: state.sessionRole }),
    ...(state.modelInfo === undefined ? {} : { modelInfo: state.modelInfo }),
  };
}

async function listSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
  const dir = getSessionsDir(workspaceRoot);
  const names = await readTopLevelSessionFileNames(dir);
  const sessions: Array<{ summary: SessionSummary; sortKey: number }> = [];

  for (const name of names) {
    try {
      const parsed = await readSessionFile(basename(name, ".json"), workspaceRoot);
      const timestamps = readSessionTimestamps(parsed);
      sessions.push({
        summary: {
          sessionId: parsed.sessionId,
          rootSessionId: parsed.rootSessionId,
          ...(parsed.parentSessionId === undefined ? {} : { parentSessionId: parsed.parentSessionId }),
          ...(parsed.goalId === undefined ? {} : { goalId: parsed.goalId }),
          ...(parsed.loopId === undefined ? {} : { loopId: parsed.loopId }),
          ...(parsed.sessionRole === undefined ? {} : { sessionRole: parsed.sessionRole }),
          agentName: parsed.agentName,
          ...(parsed.modelInfo === undefined ? {} : { modelInfo: parsed.modelInfo }),
          title: parsed.title ?? null,
          createdAt: parsed.createdAt,
          ...(timestamps.lastUpdatedAt === undefined ? {} : { lastUpdatedAt: timestamps.lastUpdatedAt }),
        },
        sortKey: timestamps.lastUpdatedAt ?? timestamps.updatedAt ?? parsed.createdAt,
      });
    } catch (err) {
      console.warn(
        `Skipping invalid session file "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return sessions
    .sort((left, right) => right.sortKey - left.sortKey)
    .map((session) => session.summary);
}

async function scanDescendants(workspaceRoot: string, rootSessionId: string): Promise<Map<string, string>> {
  const dir = getRootSessionDir(workspaceRoot, rootSessionId);
  const names = await readTopLevelSessionFileNames(dir);
  const descendants = new Map<string, string>();

  for (const name of names) {
    const filePath = join(dir, name);
    try {
      const parsed = await readValidatedSessionFile(filePath);
      if (parsed.rootSessionId !== rootSessionId) {
        throw new Error(
          `Root session ID mismatch: expected "${rootSessionId}", found "${parsed.rootSessionId}" in file`,
        );
      }
      if (parsed.sessionId === rootSessionId) continue;
      descendants.set(parsed.sessionId, parsed.rootSessionId);
    } catch (err) {
      console.warn(
        `Skipping invalid descendant session file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return descendants;
}

async function readTopLevelSessionFileNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function readTopLevelSessionDirNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function readValidatedSessionFile(filePath: string): Promise<HydratedSessionFile> {
  const raw = await Bun.file(filePath).text();
  return SessionFileSchema.parse(JSON.parse(raw));
}

function readSessionTimestamps(value: unknown): { lastUpdatedAt?: number; updatedAt?: number } {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.lastUpdatedAt === "number" ? { lastUpdatedAt: record.lastUpdatedAt } : {}),
    ...(typeof record.updatedAt === "number" ? { updatedAt: record.updatedAt } : {}),
  };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const sessionFileInternals = {
  saveSessionTranscript,
  readSessionFile,
  toSessionFile,
  listSessionSummaries,
  scanDescendants,
  readTopLevelSessionDirNames,
};
