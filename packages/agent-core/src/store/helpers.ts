import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { SessionEventEnvelope, SessionStoreState, StoredMessage } from "./types";
import {
  isSessionEventPayload,
  type FinalizedToolResult,
  type JsonObject,
  type SessionEventPayload,
  type SessionModelSelection,
} from "@archcode/protocol";
import { getSessionPath, getSessionsDir } from "./sessions-dir";
import type { SessionRole } from "./types";
import {
  COMPRESSION_BLOCK_STATUSES,
  COMPRESSION_STRATEGIES,
  COMPRESSION_SUMMARY_SECTION_NAMES,
  COMPRESSION_TRIGGERS,
  PROTECTED_CONTENT_KINDS,
  createEmptyCompressionState,
} from "../compression";
import { AGENT_NAMES, type AgentName } from "../agents/names";
import { HitlBoundaryCodec } from "../hitl/boundary-codec";
import { atomicWrite } from "../utils/safe-file";

const SessionRoleSchema = z.enum(["main", "plan", "build", "review", "explore", "librarian", "standalone"]);
const AgentNameSchema = z.enum(AGENT_NAMES);
const ToolLifecycleIdSchema = z.string().min(1).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 128,
  "Tool lifecycle identifier exceeds 128 UTF-8 bytes",
);
const ToolNameSchema = z.string().min(1).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 128,
  "Tool name exceeds 128 UTF-8 bytes",
);
const ToolLifecycleTimestampSchema = z.number().finite().nonnegative();
const ToolOutputCountSchema = z.strictObject({
  bytes: z.number().int().nonnegative().safe(),
  lines: z.number().int().nonnegative().safe(),
});
const ToolSourceInputSchema = z.record(z.string(), z.unknown()).refine(
  isBoundedJsonObject,
  "Source recovery input must be bounded JSON",
);
const ToolOutputRecoverySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("source"),
    toolName: ToolNameSchema,
    nextInput: ToolSourceInputSchema,
  }),
  z.strictObject({
    kind: z.literal("artifact"),
    outputRef: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    expiresAt: z.number().finite().nonnegative(),
    canRead: z.literal(true),
    canSearch: z.literal(true),
  }),
]).refine(
  (recovery) => utf8Bytes(JSON.stringify(recovery)) <= 16 * 1024,
  "Tool output recovery exceeds 16 KiB",
);
const ToolDiffLineSchema = z.strictObject({
  type: z.enum(["context", "add", "delete"]),
  content: boundedUtf8String(4 * 1024),
});
const ToolDiffHunkSchema = z.strictObject({
  header: boundedUtf8String(4 * 1024),
  oldStart: z.number().int(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(ToolDiffLineSchema),
});
const ToolDiffFileSchema = z.strictObject({
  path: boundedUtf8String(4 * 1024),
  status: z.enum(["modified", "created", "deleted"]).optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  hunks: z.array(ToolDiffHunkSchema),
});
const ToolResultPresentationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("diff"),
    files: z.array(ToolDiffFileSchema).max(20),
    truncated: z.literal(true).optional(),
  }).refine(
    (presentation) => presentation.files.reduce(
      (count, file) => count + file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0),
      0,
    ) <= 2_000,
    "Diff presentation exceeds 2,000 lines",
  ),
  z.strictObject({
    kind: z.literal("ask_user"),
    answers: z.array(z.strictObject({
      question: boundedUtf8String(2 * 1024),
      answers: z.array(boundedUtf8String(16 * 1024)),
    })).max(3),
    truncated: z.literal(true).optional(),
  }).refine(
    (presentation) => utf8Bytes(JSON.stringify(presentation.answers)) <= 64 * 1024,
    "Ask-user presentation exceeds 64 KiB",
  ),
]);
const ToolResultDetailsSchema = z.strictObject({
  error: z.strictObject({
    kind: boundedUtf8String(128),
    code: boundedUtf8String(128),
    name: boundedUtf8String(128),
    hint: boundedUtf8String(2 * 1024).optional(),
  }).optional(),
  process: z.strictObject({
    exitCode: z.number().int().nullable(),
    signal: boundedUtf8String(32).nullable(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    durationMs: z.number().finite().nonnegative(),
  }).optional(),
  unknownResult: z.literal(true).optional(),
  presentations: z.array(ToolResultPresentationSchema).max(2).optional(),
}).refine(
  (details) => utf8Bytes(JSON.stringify(details)) <= 256 * 1024,
  "Tool result details exceeds 256 KiB",
);
const FinalizedToolResultSchema: z.ZodType<FinalizedToolResult> = z.strictObject({
  isError: z.boolean(),
  output: z.strictObject({
    preview: boundedUtf8String(50 * 1024).refine(
      (value) => value.length === 0 || value.split("\n").length <= 2_000,
      "Tool preview exceeds 2,000 lines",
    ),
    completeness: z.enum(["complete", "partial"]),
    observed: ToolOutputCountSchema,
    canonical: ToolOutputCountSchema,
    stored: ToolOutputCountSchema,
    omitted: ToolOutputCountSchema,
    recovery: ToolOutputRecoverySchema,
  }),
  details: ToolResultDetailsSchema.optional(),
});

const ModelSelectionRefSchema = z.strictObject({
  model: z.string().trim().min(1),
  variant: z.string().trim().min(1).optional(),
});

const RequestedModelSelectionSchema = z.strictObject({
  mode: z.enum(["agent_default", "session_override"]),
  selection: ModelSelectionRefSchema,
});

const SessionModelSelectionSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  override: ModelSelectionRefSchema.optional(),
});

const ExecutionModelBindingSchema = z.strictObject({
  selection: ModelSelectionRefSchema,
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  providerDisplayName: z.string().trim().min(1),
  modelDisplayName: z.string().trim().min(1),
  resolution: z.enum(["requested", "session_override", "agent_default"]),
  modelRuntimeRevision: z.string().trim().min(1),
});

const MessageModelAuditSchema = z.strictObject({
  requested: RequestedModelSelectionSchema,
  actual: ModelSelectionRefSchema,
  reason: z.literal("config_invalidated").optional(),
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
  status: z.enum(["running", "completed", "max_steps", "failed", "aborted", "cancelled", "timed_out", "interrupted", "waiting_for_human"]),
  endedAt: z.number().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
  stopRequestedAt: z.number().optional(),
  binding: ExecutionModelBindingSchema,
  origin: z.enum(["user_message", "tool_call", "tool_batch", "goal_claim"]),
});

const PendingSessionMessageSchema = z.strictObject({
  id: z.string().trim().min(1),
  clientRequestId: z.string().trim().min(1),
  content: z.string(),
  source: z.enum(["user", "automation"]),
  state: z.enum(["queued", "steering"]),
  revision: z.number().int().nonnegative(),
  acceptedAt: z.number(),
  updatedAt: z.number(),
  targetExecutionId: z.string().trim().min(1).optional(),
  requestedModelSelection: RequestedModelSelectionSchema,
}).superRefine((message, ctx) => {
  if ((message.state === "steering") !== (message.targetExecutionId !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["targetExecutionId"],
      message: "targetExecutionId must exist exactly when state is steering",
    });
  }
});

const SessionInputReceiptSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("message"),
    clientRequestId: z.string().trim().min(1),
    messageId: z.string().trim().min(1),
    requestFingerprint: z.string(),
    status: z.enum(["pending", "canonical", "deleted"]),
    requestedModelSelection: RequestedModelSelectionSchema,
  }),
  z.strictObject({
    kind: z.literal("command"),
    clientRequestId: z.string().trim().min(1),
    requestFingerprint: z.string(),
    status: z.enum(["executing", "completed", "failed", "indeterminate"]),
    error: z.string().optional(),
    requestedModelSelection: RequestedModelSelectionSchema,
  }).superRefine((receipt, ctx) => {
    if ((receipt.status === "failed" || receipt.status === "indeterminate") !== (receipt.error !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "error must exist exactly when command status is failed or indeterminate",
      });
    }
  }),
]);

const StoredTodoSchema = z.strictObject({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
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
  title: z.string().trim().min(1),
  description: z.string().optional(),
  depth: z.number(),
  background: z.boolean(),
  status: z.enum([
    "linked",
    "running",
    "waiting_for_human",
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
  id: ToolLifecycleIdSchema,
  toolCallId: ToolLifecycleIdSchema,
  toolName: ToolNameSchema,
  createdAt: ToolLifecycleTimestampSchema,
  attemptId: ToolLifecycleIdSchema.optional(),
  attemptTimestamp: ToolLifecycleTimestampSchema.optional(),
  attemptDestructive: z.boolean().optional(),
});

const RunningToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("running"),
  id: ToolLifecycleIdSchema,
  toolCallId: ToolLifecycleIdSchema,
  toolName: ToolNameSchema,
  input: z.unknown(),
  createdAt: ToolLifecycleTimestampSchema,
  startedAt: ToolLifecycleTimestampSchema,
  attemptId: ToolLifecycleIdSchema.optional(),
  attemptTimestamp: ToolLifecycleTimestampSchema.optional(),
  attemptDestructive: z.boolean().optional(),
});

const CompletedToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("completed"),
  id: ToolLifecycleIdSchema,
  toolCallId: ToolLifecycleIdSchema,
  toolName: ToolNameSchema,
  input: z.unknown(),
  result: FinalizedToolResultSchema,
  createdAt: ToolLifecycleTimestampSchema,
  startedAt: ToolLifecycleTimestampSchema,
  endedAt: ToolLifecycleTimestampSchema,
  attemptId: ToolLifecycleIdSchema.optional(),
  attemptTimestamp: ToolLifecycleTimestampSchema.optional(),
  attemptDestructive: z.boolean().optional(),
});

const ErrorToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("error"),
  id: ToolLifecycleIdSchema,
  toolCallId: ToolLifecycleIdSchema,
  toolName: ToolNameSchema,
  input: z.unknown(),
  result: FinalizedToolResultSchema,
  createdAt: ToolLifecycleTimestampSchema,
  startedAt: ToolLifecycleTimestampSchema,
  endedAt: ToolLifecycleTimestampSchema,
  attemptId: ToolLifecycleIdSchema.optional(),
  attemptTimestamp: ToolLifecycleTimestampSchema.optional(),
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
  clientRequestId: z.string().optional(),
  compacted: z.boolean().optional(),
  modelAudit: MessageModelAuditSchema.optional(),
}).superRefine((message, ctx) => {
  if (message.role === "assistant" && message.modelAudit !== undefined) {
    ctx.addIssue({ code: "custom", path: ["modelAudit"], message: "Assistant messages cannot carry modelAudit" });
  }
  if (message.role === "user" && message.clientRequestId !== undefined && message.modelAudit === undefined) {
    ctx.addIssue({ code: "custom", path: ["modelAudit"], message: "Canonical user input must carry modelAudit" });
  }
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
  payload: z.custom<SessionEventPayload>(isSessionEventPayload, "Expected a Session event payload with a current type"),
}).transform((value) => value as SessionEventEnvelope);

const SessionToolRecoveryFailureSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("read_retry_exhausted") }),
  z.strictObject({ kind: z.literal("effectful_outcome_unknown") }),
  z.strictObject({ kind: z.literal("effectful_cancelled_unknown") }),
]);

const SessionToolManualInspectionReasonSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("continuation_interrupted"), batchId: ToolLifecycleIdSchema }),
  z.strictObject({ kind: z.literal("effectful_outcome_unknown"), toolCallId: ToolLifecycleIdSchema, toolName: ToolNameSchema }),
  z.strictObject({ kind: z.literal("effectful_cancelled_unknown"), toolCallId: ToolLifecycleIdSchema, toolName: ToolNameSchema }),
]);

const SessionToolBatchCallSchema = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  partitionIndex: z.number().int().nonnegative(),
  toolCallId: ToolLifecycleIdSchema,
  toolName: ToolNameSchema,
  input: z.unknown(),
  traits: z.strictObject({
    readOnly: z.boolean(),
    destructive: z.boolean(),
    concurrencySafe: z.boolean(),
  }),
  state: z.enum(["queued", "running", "blocked", "completed", "failed", "manual_inspection_required"]),
  attempt: z.number().int().nonnegative(),
  result: FinalizedToolResultSchema.optional(),
  blocker: HitlBoundaryCodec.sessionToolCallBlockerSchema.optional(),
  recoveryFailure: SessionToolRecoveryFailureSchema.optional(),
}).superRefine((call, ctx) => {
  const terminalResult = call.state === "completed" || call.state === "failed";
  if (terminalResult !== (call.result !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["result"], message: `${call.state} has invalid result presence` });
  }
  if (call.state === "completed" && call.result?.isError !== false) {
    ctx.addIssue({ code: "custom", path: ["result", "isError"], message: "completed result must not be an error" });
  }
  if (call.state === "failed" && call.result?.isError !== true) {
    ctx.addIssue({ code: "custom", path: ["result", "isError"], message: "failed result must be an error" });
  }
  if ((call.state === "blocked") !== (call.blocker !== undefined && call.blocker.responseAppliedAt === undefined)) {
    ctx.addIssue({ code: "custom", path: ["blocker"], message: `${call.state} has invalid active blocker` });
  }
});

const SessionToolBatchSchema = z.strictObject({
  batchId: z.string().trim().min(1),
  executionId: z.string().trim().min(1),
  assistantMessageId: z.string().optional(),
  step: z.number().int().nonnegative(),
  agentName: AgentNameSchema,
  allowedTools: z.array(z.string()),
  agentSkills: z.array(z.string()),
  partitions: z.array(z.strictObject({ type: z.enum(["parallel", "serial"]), callIds: z.array(z.string().trim().min(1)).min(1) })),
  calls: z.array(SessionToolBatchCallSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  continuationStartedAt: z.string().optional(),
  continuationCompletedAt: z.string().optional(),
  archivedAt: z.string().optional(),
  manualInspectionReason: SessionToolManualInspectionReasonSchema.optional(),
}).superRefine((batch, ctx) => {
  const ids = batch.calls.map((call) => call.toolCallId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["calls"], message: "Duplicate toolCallId in batch" });
  const partitionIds = batch.partitions.flatMap((partition) => partition.callIds);
  if (JSON.stringify(partitionIds) !== JSON.stringify(ids)) {
    ctx.addIssue({ code: "custom", path: ["partitions"], message: "Partitions must cover calls exactly once in model order" });
  }
  batch.partitions.forEach((partition, partitionIndex) => {
    if (partition.type === "serial" && partition.callIds.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["partitions", partitionIndex, "callIds"], message: "Serial partition must contain one call" });
    }
    for (const callId of partition.callIds) {
      const call = batch.calls.find((candidate) => candidate.toolCallId === callId);
      if (call?.partitionIndex !== partitionIndex) ctx.addIssue({ code: "custom", path: ["partitions", partitionIndex], message: "Call partitionIndex mismatch" });
    }
  });
});

export const SessionFileSchema = z.strictObject({
  sessionId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  cwd: z.string(),
  agentName: AgentNameSchema,
  activeSkillNames: z.array(z.string().trim().min(1)).refine(
    (names) => new Set(names).size === names.length,
    "activeSkillNames must not contain duplicates",
  ),
  modelSelection: SessionModelSelectionSchema,
  title: z.string().nullable(),
  messages: z.array(StoredMessageSchema),
  pendingMessages: z.array(PendingSessionMessageSchema).superRefine((messages, ctx) => {
    const ids = messages.map((message) => message.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "pendingMessages must have unique message ids" });
    }
    const requestIds = messages.map((message) => message.clientRequestId);
    if (new Set(requestIds).size !== requestIds.length) {
      ctx.addIssue({ code: "custom", message: "pendingMessages must have unique clientRequestIds" });
    }
  }),
  queueDispatchBarrierAt: z.number().optional(),
  inputRequestReceipts: z.array(SessionInputReceiptSchema).superRefine((receipts, ctx) => {
    const requestIds = receipts.map((receipt) => receipt.clientRequestId);
    if (new Set(requestIds).size !== requestIds.length) {
      ctx.addIssue({ code: "custom", message: "inputRequestReceipts must have unique clientRequestIds" });
    }
  }),
  steps: z.array(StepInfoSchema),
  stats: SessionStatsSchema,
  executions: z.array(SessionExecutionRecordSchema),
  compression: CompressionStateSchema,
  events: z.array(SessionEventEnvelopeSchema).optional(),
  todos: z.array(StoredTodoSchema)
    .refine(
      (todos) => todos.filter((todo) => todo.status === "in_progress").length <= 1,
      "Only one todo can be in_progress",
    ),
  reminders: z.array(ReminderSchema),
  childSessionLinks: z.array(ToolChildSessionLinkSchema),
  toolBatches: z.array(SessionToolBatchSchema).superRefine((batches, ctx) => {
    if (batches.filter((batch) => batch.archivedAt === undefined).length > 1) {
      ctx.addIssue({ code: "custom", message: "At most one tool batch may be active" });
    }
  }),
  // Tree edges are read from each child file; parent files intentionally keep no child cache.
  rootSessionId: z.string(),
  parentSessionId: z.string().optional(),
  goalId: z.string().uuid().optional(),
  sessionRole: SessionRoleSchema.optional(),
  eventCursor: z.number().optional(),
}).superRefine((session, ctx) => {
  const canonicalById = new Map(session.messages.map((message) => [message.id, message]));
  const pendingById = new Map(session.pendingMessages.map((message) => [message.id, message]));
  const messageReceipts = session.inputRequestReceipts.filter((receipt) => receipt.kind === "message");
  const receiptsByMessageId = new Map(messageReceipts.map((receipt) => [receipt.messageId, receipt]));

  for (const pending of session.pendingMessages) {
    if (canonicalById.has(pending.id)) {
      ctx.addIssue({ code: "custom", path: ["pendingMessages"], message: `Message ${pending.id} is both pending and canonical` });
    }
    const receipt = receiptsByMessageId.get(pending.id);
    if (receipt?.status !== "pending" || receipt.clientRequestId !== pending.clientRequestId) {
      ctx.addIssue({ code: "custom", path: ["inputRequestReceipts"], message: `Pending message ${pending.id} has no matching pending receipt` });
    }
  }

  for (const receipt of session.inputRequestReceipts) {
    if (receipt.kind === "command") continue;
    const pending = pendingById.get(receipt.messageId);
    const canonical = canonicalById.get(receipt.messageId);
    const requested = pending?.requestedModelSelection ?? canonical?.modelAudit?.requested;
    if (requested !== undefined
      && JSON.stringify(requested) !== JSON.stringify(receipt.requestedModelSelection)) {
      ctx.addIssue({ code: "custom", path: ["inputRequestReceipts"], message: `Receipt ${receipt.clientRequestId} model selection mismatch` });
    }
    if (receipt.status === "pending" && pending === undefined) {
      ctx.addIssue({ code: "custom", path: ["inputRequestReceipts"], message: `Pending receipt ${receipt.clientRequestId} has no message` });
    }
    if (receipt.status === "canonical"
      && (canonical === undefined || canonical.clientRequestId !== receipt.clientRequestId)) {
      ctx.addIssue({ code: "custom", path: ["inputRequestReceipts"], message: `Canonical receipt ${receipt.clientRequestId} has no matching message` });
    }
    if (receipt.status === "deleted" && (pending !== undefined || canonical !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["inputRequestReceipts"], message: `Deleted receipt ${receipt.clientRequestId} still has a message` });
    }
  }

  const executionById = new Map(session.executions.map((execution) => [execution.id, execution]));
  for (const message of session.messages) {
    if (message.modelAudit === undefined || message.executionId === undefined) continue;
    const execution = executionById.get(message.executionId);
    if (execution === undefined
      || JSON.stringify(message.modelAudit.actual) !== JSON.stringify(execution.binding.selection)) {
      ctx.addIssue({ code: "custom", path: ["messages"], message: `Message ${message.id} model audit has no matching execution binding` });
    }
  }
});

export type HydratedSessionFile = z.output<typeof SessionFileSchema>;
export type SessionFile = HydratedSessionFile;

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  rootSessionId: string;
  parentSessionId?: string;
  goalId?: string;
  sessionRole?: SessionRole;
  agentName: string;
  activeSkillNames: string[];
  modelSelection: SessionModelSelection;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

type PersistableSessionState = Pick<
  SessionStoreState,
  "sessionId" | "createdAt" | "updatedAt" | "cwd" | "agentName" | "activeSkillNames" | "modelSelection" | "title" | "messages" | "pendingMessages" | "inputRequestReceipts" | "steps" | "stats" | "executions" | "compression" | "todos" | "reminders" | "childSessionLinks" | "toolBatches" | "rootSessionId"
> & Partial<Pick<
  SessionStoreState,
  "parentSessionId" | "goalId" | "sessionRole" | "events" | "queueDispatchBarrierAt"
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

function boundedUtf8String(maxBytes: number) {
  return z.string().refine(
    (value) => utf8Bytes(value) <= maxBytes,
    `String exceeds ${maxBytes} UTF-8 bytes`,
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBoundedJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return isBoundedJsonValue(value, 1, { keys: 0, items: 0 });
}

function isBoundedJsonValue(
  value: unknown,
  depth: number,
  budget: { keys: number; items: number },
): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return utf8Bytes(value) <= 8 * 1024;
  if (Array.isArray(value)) {
    budget.items += value.length;
    return budget.items <= 256
      && value.every((item) => isBoundedJsonValue(item, depth + 1, budget));
  }
  if (typeof value !== "object") return false;
  const entries = Object.entries(value);
  budget.keys += entries.length;
  return budget.keys <= 64
    && entries.every(([key, item]) => utf8Bytes(key) <= 128
      && isBoundedJsonValue(item, depth + 1, budget));
}

async function saveSessionTranscript(
  state: PersistableSessionState,
  workspaceRoot: string,
): Promise<void> {
  const finalPath = getSessionPath(workspaceRoot, state.sessionId);

  const data: HydratedSessionFile = {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    cwd: state.cwd,
    agentName: state.agentName,
    activeSkillNames: state.activeSkillNames,
    modelSelection: state.modelSelection,
    title: state.title,
    messages: state.messages,
    pendingMessages: state.pendingMessages,
    ...(state.queueDispatchBarrierAt === undefined ? {} : {
      queueDispatchBarrierAt: state.queueDispatchBarrierAt,
    }),
    inputRequestReceipts: state.inputRequestReceipts,
    steps: state.steps,
    stats: state.stats,
    executions: state.executions,
    compression: state.compression,
    todos: state.todos,
    reminders: state.reminders,
    childSessionLinks: state.childSessionLinks,
    toolBatches: state.toolBatches,
    rootSessionId: state.rootSessionId,
    ...((state.events?.length ?? 0) === 0 ? {} : { events: state.events }),
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
    ...(state.goalId === undefined ? {} : { goalId: state.goalId }),
    ...(state.sessionRole === undefined ? {} : { sessionRole: state.sessionRole }),
  };

  const json = JSON.stringify(data, null, 2);
  await atomicWrite(finalPath, json);
}

async function readSessionFile(
  sessionId: string,
  workspaceRoot: string,
  _rootSessionId?: string,
): Promise<HydratedSessionFile> {
  const filePath = getSessionPath(workspaceRoot, sessionId);
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
    updatedAt: state.updatedAt,
    cwd: state.cwd,
    agentName: state.agentName,
    activeSkillNames: state.activeSkillNames,
    modelSelection: state.modelSelection,
    title: state.title,
    messages: state.messages,
    pendingMessages: state.pendingMessages,
    ...(state.queueDispatchBarrierAt === undefined ? {} : {
      queueDispatchBarrierAt: state.queueDispatchBarrierAt,
    }),
    inputRequestReceipts: state.inputRequestReceipts,
    steps: state.steps,
    stats: state.stats,
    executions: state.executions,
    compression: state.compression,
    todos: state.todos,
    reminders: state.reminders,
    childSessionLinks: state.childSessionLinks,
    toolBatches: state.toolBatches,
    rootSessionId: state.rootSessionId,
    eventCursor: state.nextEventId > 0 ? state.nextEventId - 1 : -1,
    ...((state.events?.length ?? 0) === 0 ? {} : { events: state.events }),
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
    ...(state.goalId === undefined ? {} : { goalId: state.goalId }),
    ...(state.sessionRole === undefined ? {} : { sessionRole: state.sessionRole }),
  };
}

async function listSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
  const dir = getSessionsDir(workspaceRoot);
  const names = await readTopLevelSessionDirNames(dir);
  const sessions: Array<{ summary: SessionSummary; sortKey: number }> = [];

  for (const name of names) {
    const parsed = await readSessionFile(name, workspaceRoot);
    if (parsed.parentSessionId !== undefined || parsed.rootSessionId !== parsed.sessionId) continue;
    sessions.push({
      summary: {
        sessionId: parsed.sessionId,
        cwd: parsed.cwd,
        rootSessionId: parsed.rootSessionId,
        ...(parsed.parentSessionId === undefined ? {} : { parentSessionId: parsed.parentSessionId }),
        ...(parsed.goalId === undefined ? {} : { goalId: parsed.goalId }),
        ...(parsed.sessionRole === undefined ? {} : { sessionRole: parsed.sessionRole }),
        agentName: parsed.agentName,
        activeSkillNames: parsed.activeSkillNames,
        modelSelection: parsed.modelSelection,
        title: parsed.title,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      },
      sortKey: parsed.updatedAt,
    });
  }

  return sessions
    .sort((left, right) => right.sortKey - left.sortKey)
    .map((session) => session.summary);
}

async function scanDescendants(workspaceRoot: string, rootSessionId: string): Promise<Map<string, string>> {
  const dir = getSessionsDir(workspaceRoot);
  const names = await readTopLevelSessionDirNames(dir);
  const descendants = new Map<string, string>();

  for (const name of names) {
    const filePath = getSessionPath(workspaceRoot, name);
    const parsed = await readValidatedSessionFile(filePath);
    if (parsed.sessionId === rootSessionId) continue;
    if (parsed.rootSessionId !== rootSessionId) {
      continue;
    }
    if (parsed.parentSessionId === undefined) {
      throw new Error(
        `Descendant session "${parsed.sessionId}" is missing parentSessionId`,
      );
    }
    descendants.set(parsed.sessionId, parsed.rootSessionId);
  }

  return descendants;
}

async function scanAllSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
  const dir = getSessionsDir(workspaceRoot);
  const names = await readTopLevelSessionDirNames(dir);
  const sessions: SessionSummary[] = [];

  for (const name of names) {
    const parsed = await readSessionFile(name, workspaceRoot);
    sessions.push({
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      rootSessionId: parsed.rootSessionId,
      ...(parsed.parentSessionId === undefined ? {} : { parentSessionId: parsed.parentSessionId }),
      ...(parsed.goalId === undefined ? {} : { goalId: parsed.goalId }),
      ...(parsed.sessionRole === undefined ? {} : { sessionRole: parsed.sessionRole }),
      agentName: parsed.agentName,
      activeSkillNames: parsed.activeSkillNames,
      modelSelection: parsed.modelSelection,
      title: parsed.title,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    });
  }

  return sessions;
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

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const sessionFileInternals = {
  saveSessionTranscript,
  readSessionFile,
  toSessionFile,
  listSessionSummaries,
  scanAllSessionSummaries,
  scanDescendants,
  readTopLevelSessionDirNames,
};
