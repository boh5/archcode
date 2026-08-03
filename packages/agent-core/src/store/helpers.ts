import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { SessionStoreState, StoredMessage } from "./types";
import {
  isSessionEventPayload,
  isValidAttachmentMediaType,
  isValidAttachmentName,
  validateExecutionFinalOutputSelection,
  type FinalizedToolResult,
  type JsonObject,
  type ProjectSessionInventoryItem,
  type SessionModelSelection,
} from "@archcode/protocol";
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@archcode/protocol";
import { getSessionPath, getSessionsDir } from "./sessions-dir";
import {
  COMPRESSION_BLOCK_STATUSES,
  COMPRESSION_STRATEGIES,
  COMPRESSION_SUMMARY_SECTION_NAMES,
  COMPRESSION_TRIGGERS,
  PROTECTED_CONTENT_KINDS,
  createEmptyCompressionState,
  validateCompressionSummaryLineage,
  validateCompressionSummary,
} from "../compression";
import { AGENT_NAMES, type AgentName } from "../agents/names";
import { resolveSessionProfile } from "../agents/session-profile";
import { sessionIdentityInvariantError } from "../agents/root-session-identity";
import type { ProfileName } from "../config";
import { HitlBoundaryCodec } from "../hitl/boundary-codec";
import { atomicWrite } from "../utils/safe-file";
import { DelegationRequestSchema } from "../delegation/schema";
import { sessionGoalNoticeInvariantError } from "../session-goal/invariant";
import { GoalNoticePartSchema, SessionGoalSchema } from "../session-goal/schema";

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
    simplified: z.literal(true).optional(),
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
  mode: z.enum(["profile_default", "session_override"]),
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
  resolution: z.enum(["requested", "session_override", "profile_default"]),
  modelRuntimeRevision: z.string().trim().min(1),
});

const MessageModelAuditSchema = z.strictObject({
  requested: RequestedModelSelectionSchema,
  actual: ModelSelectionRefSchema,
  reason: z.literal("config_invalidated").optional(),
});

const NormalizedUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
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

const ExecutionSettlementSchema = z.strictObject({
  key: z.string().trim().min(1),
  goalInstanceId: z.string().trim().min(1).nullable(),
  appliedAt: z.number().int().nonnegative().optional(),
});

const ExecutionOpenRunSchema = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  binding: ExecutionModelBindingSchema,
});

const ExecutionClosedRunSchema = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  binding: ExecutionModelBindingSchema,
  usageDelta: NormalizedUsageSchema,
  settlement: ExecutionSettlementSchema,
}).superRefine((run, ctx) => {
  if (run.endedAt < run.startedAt || run.durationMs !== run.endedAt - run.startedAt) {
    ctx.addIssue({ code: "custom", path: ["durationMs"], message: "Run duration must match its active interval" });
  }
});

const SessionExecutionRunSchema = z.union([ExecutionOpenRunSchema, ExecutionClosedRunSchema]);

const HitlExecutionSuspensionSchema = z.strictObject({
  kind: z.literal("hitl"),
  toolBatchId: z.string().trim().min(1),
  blockerIds: z.array(z.string().trim().min(1)).min(1),
}).superRefine((suspension, ctx) => {
  const sorted = [...suspension.blockerIds].sort();
  if (new Set(suspension.blockerIds).size !== suspension.blockerIds.length
    || sorted.some((id, index) => id !== suspension.blockerIds[index])) {
    ctx.addIssue({ code: "custom", path: ["blockerIds"], message: "HITL blockerIds must be unique and sorted" });
  }
});

const ExecutionSuspensionSchema = z.discriminatedUnion("kind", [
  HitlExecutionSuspensionSchema,
  z.strictObject({
    kind: z.literal("child_dependency"),
    toolBatchId: z.string().trim().min(1),
    toolCallId: z.string().trim().min(1),
    childSessionId: z.string().trim().min(1),
    childExecutionId: z.string().trim().min(1),
  }),
  z.strictObject({
    kind: z.literal("resume_pending"),
    toolBatchId: z.string().trim().min(1),
    readyAt: z.number().int().nonnegative(),
  }),
]);

const SessionExecutionRecordBaseShape = {
  id: z.string().trim().min(1),
  startedAt: z.number().int().nonnegative(),
  origin: z.enum(["user_message", "tool_call", "goal_continuation"]),
  maxSteps: z.number().int().positive(),
  activeTimeoutMs: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative(),
  stopRequestedAt: z.number().int().nonnegative().optional(),
  runs: z.array(SessionExecutionRunSchema).min(1),
};

const SessionExecutionRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...SessionExecutionRecordBaseShape,
    status: z.literal("running"),
  }),
  z.strictObject({
    ...SessionExecutionRecordBaseShape,
    status: z.literal("suspended"),
    suspension: ExecutionSuspensionSchema,
  }),
  z.strictObject({
    ...SessionExecutionRecordBaseShape,
    status: z.enum(["completed", "max_steps", "failed", "aborted", "cancelled", "timed_out", "interrupted"]),
    endedAt: z.number().int().nonnegative(),
    finalOutputStepId: z.string().trim().min(1).optional(),
    error: z.string().optional(),
    terminalSettlement: ExecutionSettlementSchema,
  }),
]).superRefine((execution, ctx) => {
  let durationMs = 0;
  execution.runs.forEach((run, index) => {
    if (run.ordinal !== index) {
      ctx.addIssue({ code: "custom", path: ["runs", index, "ordinal"], message: "Run ordinals must be contiguous" });
    }
    if (index === 0 && run.startedAt !== execution.startedAt) {
      ctx.addIssue({ code: "custom", path: ["runs", index, "startedAt"], message: "First run must start with its Execution" });
    }
    const previous = execution.runs[index - 1];
    if (previous !== undefined && "endedAt" in previous && run.startedAt < previous.endedAt) {
      ctx.addIssue({ code: "custom", path: ["runs", index, "startedAt"], message: "Run intervals cannot overlap" });
    }
    if ("endedAt" in run) durationMs += run.durationMs;
  });
  if (durationMs !== execution.durationMs) {
    ctx.addIssue({ code: "custom", path: ["durationMs"], message: "Execution duration must equal its closed runs" });
  }
  const openRuns = execution.runs.filter((run) => !("endedAt" in run));
  if (execution.status === "running") {
    const lastRun = execution.runs.at(-1);
    if (openRuns.length !== 1 || lastRun === undefined || "endedAt" in lastRun) {
      ctx.addIssue({ code: "custom", path: ["runs"], message: "A running Execution must have exactly one trailing open run" });
    }
  } else if (openRuns.length !== 0) {
    ctx.addIssue({ code: "custom", path: ["runs"], message: "A suspended or terminal Execution cannot have an open run" });
  }
  if ("finalOutputStepId" in execution
    && execution.finalOutputStepId !== undefined
    && execution.status !== "completed") {
    ctx.addIssue({
      code: "custom",
      path: ["finalOutputStepId"],
      message: "Only completed Executions may select final Assistant output",
    });
  }
});

const AttachmentDescriptorSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().refine(isValidAttachmentName, "Invalid attachment display name"),
  mediaType: z.string().refine(
    isValidAttachmentMediaType,
    "Invalid attachment display media type",
  ),
  sizeBytes: z.number().int().nonnegative().max(MAX_ATTACHMENT_SIZE_BYTES),
  kind: z.enum(["image", "file"]),
});

const AttachmentDescriptorListSchema = z.array(AttachmentDescriptorSchema)
  .max(MAX_ATTACHMENTS_PER_MESSAGE)
  .refine(
    (attachments) => new Set(attachments.map((attachment) => attachment.id)).size === attachments.length,
    "attachments must not contain duplicate ids",
  );

const PendingSessionMessageSchema = z.strictObject({
  id: z.string().trim().min(1),
  clientRequestId: z.string().trim().min(1),
  content: z.string(),
  attachments: AttachmentDescriptorListSchema,
  source: z.enum(["user", "automation"]),
  state: z.enum(["queued", "steering"]),
  revision: z.number().int().nonnegative(),
  acceptedAt: z.number(),
  updatedAt: z.number(),
  targetExecutionId: z.string().trim().min(1).optional(),
  targetRunOrdinal: z.number().int().nonnegative().optional(),
  targetModelAudit: MessageModelAuditSchema.optional(),
  claimedAt: z.number().int().nonnegative().optional(),
  requestedModelSelection: RequestedModelSelectionSchema,
}).superRefine((message, ctx) => {
  if (message.content.trim().length === 0 && message.attachments.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["content"],
      message: "Pending message requires text or attachments",
    });
  }
  const targetFieldsPresent = message.targetExecutionId !== undefined
    && message.targetRunOrdinal !== undefined
    && message.targetModelAudit !== undefined
    && message.claimedAt !== undefined;
  const targetFieldsAbsent = message.targetExecutionId === undefined
    && message.targetRunOrdinal === undefined
    && message.targetModelAudit === undefined
    && message.claimedAt === undefined;
  if ((message.state === "steering" && !targetFieldsPresent)
    || (message.state === "queued" && !targetFieldsAbsent)) {
    ctx.addIssue({
      code: "custom",
      path: ["targetExecutionId"],
      message: "Steering target fields must exist exactly when state is steering",
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
  z.strictObject({
    type: z.literal("session_goal_changed"),
    notice: GoalNoticePartSchema,
  }),
]);

const ReminderSchema = z.strictObject({
  id: z.string(),
  source: ReminderSourceSchema,
  delivery: z.enum(["auto_inject", "on_demand", "model_context"]),
  sessionId: z.string().optional(),
  terminalState: z.string().optional(),
  content: z.string(),
  payload: z.unknown().optional(),
  createdAt: z.number(),
  consumedAt: z.number().nullable(),
  targetSessionId: z.string().optional(),
}).superRefine((reminder, ctx) => {
  if ((reminder.delivery === "model_context") !== (reminder.source.type === "session_goal_changed")) {
    ctx.addIssue({
      code: "custom",
      path: ["delivery"],
      message: "model_context delivery is reserved for Session Goal change notices",
    });
  }
  if (reminder.source.type === "session_goal_changed" && reminder.id !== reminder.source.notice.id) {
    ctx.addIssue({
      code: "custom",
      path: ["id"],
      message: "Goal reminder and notice ids must match",
    });
  }
});

const ToolChildSessionLinkSchema = z.strictObject({
  parentSessionId: z.string(),
  parentToolCallId: z.string(),
  toolName: z.string(),
  childSessionId: z.string(),
  childExecutionId: z.string(),
  childAgentName: z.string(),
  childProfile: z.enum(["deep", "fast"]),
  childSkillNames: z.array(z.string().trim().min(1)),
  title: z.string().trim().min(1),
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
  durationUpdatedAt: z.number().optional(),
  error: z.string().optional(),
}).superRefine((link, ctx) => {
  if ((link.durationMs === undefined) !== (link.durationUpdatedAt === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["durationUpdatedAt"],
      message: "Child link duration timestamp must be present exactly when duration is present",
    });
  }
});

const TextPartSchema = z.strictObject({
  type: z.literal("text"),
  id: z.string(),
  text: z.string(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const AssistantOutputPartSchema = z.strictObject({
  type: z.literal("assistant-output"),
  id: z.string(),
  blockId: z.string().trim().min(1),
  text: z.string(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const ReasoningPartSchema = z.strictObject({
  type: z.literal("reasoning"),
  id: z.string(),
  blockId: z.string().trim().min(1),
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

const InterruptedToolPartSchema = z.strictObject({
  type: z.literal("tool"),
  state: z.literal("interrupted"),
  id: ToolLifecycleIdSchema,
  toolCallId: ToolLifecycleIdSchema,
  toolName: ToolNameSchema,
  input: z.unknown().optional(),
  createdAt: ToolLifecycleTimestampSchema,
  startedAt: ToolLifecycleTimestampSchema.optional(),
  endedAt: ToolLifecycleTimestampSchema,
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
  InterruptedToolPartSchema,
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

const AttachmentPartSchema = z.strictObject({
  type: z.literal("attachment"),
  id: z.string(),
  attachment: AttachmentDescriptorSchema,
  createdAt: z.number(),
  completedAt: z.number().optional(),
});

const UserStoredPartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  CompactionPartSchema,
  SystemNoticePartSchema,
  AttachmentPartSchema,
  GoalNoticePartSchema,
]);

const AssistantStoredPartSchema = z.discriminatedUnion("type", [
  AssistantOutputPartSchema,
  ReasoningPartSchema,
  ToolPartSchema,
  SystemNoticePartSchema,
  RecoveryNoticePartSchema,
]);

const UserStoredMessageSchema = z.strictObject({
  id: z.string(),
  role: z.literal("user"),
  parts: z.array(UserStoredPartSchema),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  executionId: z.string().optional(),
  runOrdinal: z.number().int().nonnegative().optional(),
  clientRequestId: z.string().optional(),
  stepId: z.never().optional(),
  outputPhase: z.never().optional(),
  compacted: z.boolean().optional(),
  modelAudit: MessageModelAuditSchema.optional(),
}).superRefine((message, ctx) => {
  if ((message.executionId === undefined) !== (message.runOrdinal === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["runOrdinal"],
      message: "executionId and runOrdinal must be present together",
    });
  }
  const attachmentParts = message.parts.filter((part) => part.type === "attachment");
  if (attachmentParts.length > 0) {
    if (attachmentParts.length > MAX_ATTACHMENTS_PER_MESSAGE
      || new Set(attachmentParts.map((part) => part.attachment.id)).size !== attachmentParts.length) {
      ctx.addIssue({ code: "custom", path: ["parts"], message: "Canonical attachment ids must be unique and within the message limit" });
    }
  }
  const hasCanonicalUserInput = message.parts.some((part) => part.type === "text" || part.type === "attachment");
  if (hasCanonicalUserInput) {
    if (message.executionId === undefined || message.runOrdinal === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["executionId"],
        message: "Canonical user input must carry execution provenance",
      });
    }
    if (message.modelAudit === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["modelAudit"],
        message: "Canonical user input must carry modelAudit",
      });
    }
  }
  if (message.clientRequestId !== undefined) {
    const hasText = message.parts.some((part) => part.type === "text" && part.text.trim().length > 0);
    if (!hasText && attachmentParts.length === 0) {
      ctx.addIssue({ code: "custom", path: ["parts"], message: "Canonical user input requires text or attachments" });
    }
  }
  const goalNotices = message.parts.filter((part) => part.type === "goal-notice");
  if (goalNotices.length > 0) {
    const notice = goalNotices[0]!;
    if (message.parts.length !== 1
      || message.id !== notice.id
      || message.createdAt !== notice.createdAt
      || message.completedAt !== notice.createdAt
      || message.clientRequestId !== undefined
      || message.modelAudit !== undefined
      || message.executionId !== undefined
      || message.runOrdinal !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Goal notice must be one provenance-free internal user message",
      });
    }
  }
});

const AssistantStoredMessageSchema = z.strictObject({
  id: z.string(),
  role: z.literal("assistant"),
  parts: z.array(AssistantStoredPartSchema),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  executionId: z.string().trim().min(1),
  runOrdinal: z.number().int().nonnegative(),
  stepId: z.string().trim().min(1),
  outputPhase: z.enum(["commentary", "final_answer"]),
  clientRequestId: z.never().optional(),
  modelAudit: z.never().optional(),
  compacted: z.boolean().optional(),
});

const StoredMessageSchema = z.discriminatedUnion("role", [
  UserStoredMessageSchema,
  AssistantStoredMessageSchema,
]);

const StepInfoSchema = z.strictObject({
  id: z.string(),
  step: z.number().int().nonnegative(),
  executionId: z.string().trim().min(1),
  runOrdinal: z.number().int().nonnegative(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  finishReason: z.string().optional(),
  usage: NormalizedUsageSchema.optional(),
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
}).superRefine((summary, ctx) => {
  const validation = validateCompressionSummary(summary);
  for (const message of validation.errors) ctx.addIssue({ code: "custom", message });
});

const CompressionChildBlockRefsSchema = z.array(BlockRefSchema).refine(
  (refs) => new Set(refs).size === refs.length,
  "Compression child block refs must be unique",
);

const CompressionBlockSchema = z.strictObject({
  id: z.string(),
  ref: BlockRefSchema,
  status: z.enum(COMPRESSION_BLOCK_STATUSES),
  strategy: z.enum(COMPRESSION_STRATEGIES),
  trigger: z.enum(COMPRESSION_TRIGGERS),
  range: CompressionRangeSchema,
  summary: CompressionSummarySchema,
  protectedRefs: z.array(ProtectedRefSchema),
  childBlockRefs: CompressionChildBlockRefsSchema,
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
}).superRefine((state, ctx) => {
  for (const [ref, block] of Object.entries(state.blocksByRef)) {
    const validation = validateCompressionSummaryLineage(
      block.summary,
      block.childBlockRefs,
      state.blocksByRef,
    );
    for (const message of validation.errors) {
      ctx.addIssue({
        code: "custom",
        path: ["blocksByRef", ref, "summary"],
        message,
      });
    }
  }
});

const PromptTraceSnapshotSchema = z.strictObject({
  version: z.literal("2"),
  status: z.enum(["compiled", "error"]),
  hash: z.string(),
  sections: z.array(z.strictObject({
    name: z.string(),
    source: z.string(),
    hash: z.string(),
  })),
  skills: z.strictObject({
    status: z.enum(["present", "absent", "error"]),
    active: z.array(z.strictObject({
      name: z.string(),
      source: z.string(),
    })),
  }),
  visibleTools: z.array(z.string()),
  agentsMd: z.enum(["present", "absent", "error"]),
  memory: z.enum(["present", "absent", "error"]),
  mcp: z.record(
    z.string(),
    z.enum(["pending", "ready", "ready-zero", "partial-warning", "failed"]),
  ),
  warnings: z.array(z.string()),
});

const SessionToolRecoveryFailureSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("read_retry_exhausted") }),
  z.strictObject({ kind: z.literal("effectful_outcome_unknown") }),
  z.strictObject({ kind: z.literal("effectful_cancelled_unknown") }),
]);

const SessionToolManualInspectionReasonSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("effectful_outcome_unknown"), toolCallId: ToolLifecycleIdSchema, toolName: ToolNameSchema }),
  z.strictObject({ kind: z.literal("effectful_cancelled_unknown"), toolCallId: ToolLifecycleIdSchema, toolName: ToolNameSchema }),
]);

const SessionToolChildCorrelationShape = {
  parentExecutionId: ToolLifecycleIdSchema,
  runOrdinal: z.number().int().nonnegative(),
  toolCallId: ToolLifecycleIdSchema,
  childSessionId: ToolLifecycleIdSchema,
  childExecutionId: ToolLifecycleIdSchema,
  createdAt: z.number().int().nonnegative(),
};

const SessionToolChildDependencySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("child_launch"),
    ...SessionToolChildCorrelationShape,
  }),
  z.strictObject({
    kind: z.literal("child_dependency"),
    ...SessionToolChildCorrelationShape,
    dependencyStartedAt: z.number().int().nonnegative(),
    outcome: z.strictObject({
      executionStatus: z.enum(["completed", "max_steps", "failed", "aborted", "cancelled", "timed_out", "interrupted"]),
      output: z.string().optional(),
      terminalError: z.string().optional(),
      resolvedAt: z.number().int().nonnegative(),
    }).optional(),
  }),
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
  state: z.enum(["queued", "running", "blocked", "child_launch", "child_dependency", "completed", "failed", "manual_inspection_required"]),
  attempt: z.number().int().nonnegative(),
  checkpointAt: z.number().int().nonnegative(),
  result: FinalizedToolResultSchema.optional(),
  settledAt: ToolLifecycleTimestampSchema.optional(),
  executionCompleted: z.literal(true).optional(),
  blocker: HitlBoundaryCodec.sessionToolCallBlockerSchema.optional(),
  childDependency: SessionToolChildDependencySchema.optional(),
  recoveryFailure: SessionToolRecoveryFailureSchema.optional(),
}).superRefine((call, ctx) => {
  const terminalResult = call.state === "completed" || call.state === "failed";
  if (terminalResult !== (call.result !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["result"], message: `${call.state} has invalid result presence` });
  }
  if (terminalResult !== (call.settledAt !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["settledAt"], message: `${call.state} has invalid settledAt presence` });
  }
  if (call.state === "completed" && call.result?.isError !== false) {
    ctx.addIssue({ code: "custom", path: ["result", "isError"], message: "completed result must not be an error" });
  }
  if (call.state === "failed" && call.result?.isError !== true) {
    ctx.addIssue({ code: "custom", path: ["result", "isError"], message: "failed result must be an error" });
  }
  if (call.executionCompleted === true && call.state !== "completed") {
    ctx.addIssue({ code: "custom", path: ["executionCompleted"], message: "executionCompleted requires a successful completed call" });
  }
  if ((call.state === "blocked") !== (call.blocker !== undefined && call.blocker.responseAppliedAt === undefined)) {
    ctx.addIssue({ code: "custom", path: ["blocker"], message: `${call.state} has invalid active blocker` });
  }
  if ((call.state === "child_launch") !== (call.childDependency?.kind === "child_launch")) {
    ctx.addIssue({ code: "custom", path: ["childDependency"], message: `${call.state} has invalid child launch intent` });
  }
  if ((call.state === "child_dependency") !== (call.childDependency?.kind === "child_dependency")) {
    ctx.addIssue({ code: "custom", path: ["childDependency"], message: `${call.state} has invalid child dependency` });
  }
  if (call.blocker !== undefined && call.childDependency !== undefined) {
    ctx.addIssue({ code: "custom", path: ["childDependency"], message: "A call cannot have both human and child blockers" });
  }
  if (call.childDependency !== undefined) {
    if (call.childDependency.toolCallId !== call.toolCallId) {
      ctx.addIssue({ code: "custom", path: ["childDependency", "toolCallId"], message: "Child intent must correlate to its owning call" });
    }
    if (call.childDependency.kind === "child_dependency"
      && call.childDependency.dependencyStartedAt < call.childDependency.createdAt) {
      ctx.addIssue({ code: "custom", path: ["childDependency", "dependencyStartedAt"], message: "Child dependency cannot precede launch intent" });
    }
  }
});

const SessionToolBatchSchema = z.strictObject({
  batchId: z.string().trim().min(1),
  executionId: z.string().trim().min(1),
  stepId: z.string().trim().min(1),
  assistantMessageId: z.string().trim().min(1),
  step: z.number().int().nonnegative(),
  runOrdinal: z.number().int().nonnegative(),
  agentName: AgentNameSchema,
  allowedTools: z.array(z.string()),
  agentSkills: z.array(z.string()),
  partitions: z.array(z.strictObject({ type: z.enum(["parallel", "serial"]), callIds: z.array(z.string().trim().min(1)).min(1) })),
  calls: z.array(SessionToolBatchCallSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
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
  for (const call of batch.calls) {
    if (call.childDependency !== undefined
      && (call.childDependency.parentExecutionId !== batch.executionId
        || call.childDependency.runOrdinal !== batch.runOrdinal)) {
      ctx.addIssue({
        code: "custom",
        path: ["calls", call.ordinal, "childDependency"],
        message: "Child intent must correlate to its owning Execution run",
      });
    }
  }
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
  promptTraces: z.array(PromptTraceSnapshotSchema),
  compression: CompressionStateSchema,
  todos: z.array(StoredTodoSchema)
    .refine(
      (todos) => todos.filter((todo) => todo.status === "in_progress").length <= 1,
      "Only one todo can be in_progress",
    ),
  reminders: z.array(ReminderSchema),
  childSessionLinks: z.array(ToolChildSessionLinkSchema),
  delegationRequest: DelegationRequestSchema.optional(),
  toolBatches: z.array(SessionToolBatchSchema).superRefine((batches, ctx) => {
    if (batches.filter((batch) => batch.archivedAt === undefined).length > 1) {
      ctx.addIssue({ code: "custom", message: "At most one tool batch may be active" });
    }
  }),
  // Tree edges are read from each child file; parent files intentionally keep no child cache.
  rootSessionId: z.string(),
  parentSessionId: z.string().optional(),
  goal: SessionGoalSchema.optional(),
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("direct") }),
    z.strictObject({
      kind: z.literal("todo"),
      todoId: z.uuid(),
      entry: z.enum(["discussion", "work", "automation"]),
    }),
    z.strictObject({
      kind: z.literal("automation"),
      automationId: z.uuid(),
      invocationId: z.uuid(),
    }),
  ]).optional(),
  eventCursor: z.number().int().min(-1),
}).superRefine((session, ctx) => {
  const isChild = session.parentSessionId !== undefined;
  if (isChild !== (session.delegationRequest !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["delegationRequest"], message: "delegationRequest must exist exactly for child Sessions" });
  }
  if (session.delegationRequest !== undefined && session.delegationRequest.agent_type !== session.agentName) {
    ctx.addIssue({ code: "custom", path: ["delegationRequest", "agent_type"], message: "delegationRequest agent_type must match the Session agentName" });
  }
  if (session.delegationRequest !== undefined) {
    const delegatedSkillNames = [...new Set(session.delegationRequest.skills)];
    if (delegatedSkillNames.length !== session.activeSkillNames.length
      || delegatedSkillNames.some((name, index) => name !== session.activeSkillNames[index])) {
      ctx.addIssue({
        code: "custom",
        path: ["activeSkillNames"],
        message: "Child activeSkillNames must match the canonical delegated Skills",
      });
    }
  }
  if (isChild && (session.modelSelection.revision !== 0 || session.modelSelection.override !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["modelSelection"],
      message: "Child modelSelection must remain initial; delegated Profile is the only child model identity",
    });
  }
  if (session.goal !== undefined
    && (session.parentSessionId !== undefined
      || session.rootSessionId !== session.sessionId
      || session.agentName !== "lead")) {
    ctx.addIssue({ code: "custom", path: ["goal"], message: "Only root Lead Sessions may own a Goal" });
  }
  const identityError = sessionIdentityInvariantError(session);
  if (identityError !== undefined) {
    ctx.addIssue({ code: "custom", path: ["agentName"], message: identityError });
  }
  const goalNoticeError = sessionGoalNoticeInvariantError(session);
  if (goalNoticeError !== undefined) {
    ctx.addIssue({ code: "custom", path: ["goal"], message: goalNoticeError });
  }
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
    const requested = pending?.requestedModelSelection
      ?? (canonical?.role === "user" ? canonical.modelAudit?.requested : undefined);
    if (requested !== undefined
      && JSON.stringify(requested) !== JSON.stringify(receipt.requestedModelSelection)) {
      ctx.addIssue({ code: "custom", path: ["inputRequestReceipts"], message: `Receipt ${receipt.clientRequestId} model selection mismatch` });
    }
    if (receipt.status === "pending" && pending === undefined) {
      ctx.addIssue({ code: "custom", path: ["inputRequestReceipts"], message: `Pending receipt ${receipt.clientRequestId} has no message` });
    }
    if (receipt.status === "canonical"
      && (canonical?.role !== "user" || canonical.clientRequestId !== receipt.clientRequestId)) {
      ctx.addIssue({ code: "custom", path: ["inputRequestReceipts"], message: `Canonical receipt ${receipt.clientRequestId} has no matching message` });
    }
    if (receipt.status === "deleted" && (pending !== undefined || canonical !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["inputRequestReceipts"], message: `Deleted receipt ${receipt.clientRequestId} still has a message` });
    }
  }

  const executionById = new Map(session.executions.map((execution) => [execution.id, execution]));
  if (executionById.size !== session.executions.length) {
    ctx.addIssue({ code: "custom", path: ["executions"], message: "Execution ids must be unique" });
  }
  if (session.executions.filter((execution) =>
    execution.status === "running" || execution.status === "suspended"
  ).length > 1) {
    ctx.addIssue({ code: "custom", path: ["executions"], message: "At most one Execution may be nonterminal" });
  }
  for (const execution of session.executions) {
    for (const run of execution.runs) {
      if ("endedAt" in run
        && run.settlement.key !== `run:${session.sessionId}:${execution.id}:${run.ordinal}`) {
        ctx.addIssue({
          code: "custom",
          path: ["executions"],
          message: `Execution ${execution.id} run ${run.ordinal} has an invalid settlement key`,
        });
      }
    }
    if (execution.status !== "running"
      && execution.status !== "suspended"
      && execution.terminalSettlement.key !== `terminal:${session.sessionId}:${execution.id}`) {
      ctx.addIssue({
        code: "custom",
        path: ["executions"],
        message: `Execution ${execution.id} has an invalid terminal settlement key`,
      });
    }
  }
  for (const message of session.messages) {
    if (message.role !== "user" || message.modelAudit === undefined || message.executionId === undefined) continue;
    const execution = executionById.get(message.executionId);
    const run = message.runOrdinal === undefined ? undefined : execution?.runs[message.runOrdinal];
    if (run === undefined
      || JSON.stringify(message.modelAudit.actual) !== JSON.stringify(run.binding.selection)) {
      ctx.addIssue({ code: "custom", path: ["messages"], message: `Message ${message.id} model audit has no matching execution binding` });
    }
  }
  const stepById = new Map(session.steps.map((step) => [step.id, step]));
  if (stepById.size !== session.steps.length) {
    ctx.addIssue({ code: "custom", path: ["steps"], message: "Step ids must be unique" });
  }
  const assistantByStepId = new Map<string, (typeof session.messages)[number]>();
  for (const message of session.messages) {
    if (message.role !== "assistant") continue;
    const step = stepById.get(message.stepId);
    if (step === undefined
      || step.executionId !== message.executionId
      || step.runOrdinal !== message.runOrdinal) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: `Assistant message ${message.id} has no exact persisted Step`,
      });
    }
    if (assistantByStepId.has(message.stepId)) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: `Step ${message.stepId} has more than one Assistant message`,
      });
    }
    assistantByStepId.set(message.stepId, message);
    for (const channel of ["assistant-output", "reasoning"] as const) {
      const blockIds = message.parts.flatMap((part) =>
        part.type === channel ? [part.blockId] : []
      );
      if (new Set(blockIds).size !== blockIds.length) {
        ctx.addIssue({
          code: "custom",
          path: ["messages"],
          message: `Assistant message ${message.id} has duplicate ${channel} block ids`,
        });
      }
    }
  }
  for (const step of session.steps) {
    const execution = executionById.get(step.executionId);
    if (execution?.runs[step.runOrdinal] === undefined) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: `Step ${step.id} has no matching Execution run` });
    }
    if (execution !== undefined && step.step >= execution.maxSteps) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: `Step ${step.id} exceeds Execution ${step.executionId} maxSteps`,
      });
    }
    if (!assistantByStepId.has(step.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: `Step ${step.id} has no model-step Assistant message`,
      });
    }
  }
  const runOrdinalByStepCursor = new Map<string, number>();
  for (const step of session.steps) {
    const cursor = `${step.executionId}:${step.step}`;
    const priorRunOrdinal = runOrdinalByStepCursor.get(cursor);
    if (priorRunOrdinal !== undefined && priorRunOrdinal !== step.runOrdinal) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: `Execution ${step.executionId} reuses step ${step.step} across runs`,
      });
    }
    runOrdinalByStepCursor.set(cursor, step.runOrdinal);
  }
  for (const batch of session.toolBatches) {
    if (executionById.get(batch.executionId)?.runs[batch.runOrdinal] === undefined) {
      ctx.addIssue({ code: "custom", path: ["toolBatches"], message: `Tool Batch ${batch.batchId} has no matching Execution run` });
    }
    const step = stepById.get(batch.stepId);
    if (step === undefined
      || step.executionId !== batch.executionId
      || step.step !== batch.step
      || step.runOrdinal !== batch.runOrdinal) {
      ctx.addIssue({
        code: "custom",
        path: ["toolBatches"],
        message: `Tool Batch ${batch.batchId} has no matching persisted Step`,
      });
    }
    if (assistantByStepId.get(batch.stepId)?.id !== batch.assistantMessageId) {
      ctx.addIssue({
        code: "custom",
        path: ["toolBatches"],
        message: `Tool Batch ${batch.batchId} has no matching Assistant message`,
      });
    }
  }
  for (const execution of session.executions) {
    const finalMessages = session.messages.filter(
      (message) => message.role === "assistant"
        && message.executionId === execution.id
        && message.outputPhase === "final_answer",
    );
    if (execution.status === "running" || execution.status === "suspended") {
      if (finalMessages.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["executions"],
          message: `Nonterminal Execution ${execution.id} has final output`,
        });
      }
      continue;
    }
    if (execution.finalOutputStepId === undefined) {
      if (finalMessages.length > 0) {
        ctx.addIssue({ code: "custom", path: ["executions"], message: `Execution ${execution.id} has unselected final output` });
      }
      continue;
    }
    const finalMessage = assistantByStepId.get(execution.finalOutputStepId);
    if (execution.status !== "completed"
      || finalMessages.length !== 1
      || finalMessage !== finalMessages[0]) {
      ctx.addIssue({ code: "custom", path: ["executions"], message: `Execution ${execution.id} final output selection is inconsistent` });
    }
    const selection = validateExecutionFinalOutputSelection(session, {
      executionId: execution.id,
      terminalStatus: execution.status,
      finalOutputStepId: execution.finalOutputStepId,
    });
    if (selection.outcome === "invalid") {
      ctx.addIssue({
        code: "custom",
        path: ["executions"],
        message: `Execution ${execution.id} final output selection is invalid: ${selection.reason}`,
      });
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
  delegationRequest?: z.output<typeof DelegationRequestSchema>;
  goal?: z.output<typeof SessionGoalSchema>;
  source?: z.output<typeof SessionFileSchema>["source"];
  agentName: string;
  profile: ProfileName;
  activeSkillNames: string[];
  modelSelection: SessionModelSelection;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

type PersistableSessionState = Pick<
  SessionStoreState,
  "sessionId" | "createdAt" | "updatedAt" | "cwd" | "agentName" | "activeSkillNames" | "modelSelection" | "title" | "messages" | "pendingMessages" | "inputRequestReceipts" | "steps" | "stats" | "executions" | "promptTraces" | "compression" | "todos" | "reminders" | "childSessionLinks" | "delegationRequest" | "toolBatches" | "rootSessionId" | "nextEventId"
> & Partial<Pick<
  SessionStoreState,
  "parentSessionId" | "goal" | "source" | "queueDispatchBarrierAt"
>>;

export function getAssistantText(messages: StoredMessage[]): string {
  let text = "";

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    for (const part of message.parts) {
      if (part.type === "assistant-output" && part.completedAt !== undefined) {
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
    messages: persistedMessages(state.messages),
    pendingMessages: state.pendingMessages,
    ...(state.queueDispatchBarrierAt === undefined ? {} : {
      queueDispatchBarrierAt: state.queueDispatchBarrierAt,
    }),
    inputRequestReceipts: state.inputRequestReceipts,
    steps: state.steps,
    stats: state.stats,
    executions: state.executions,
    promptTraces: state.promptTraces,
    compression: state.compression,
    todos: state.todos,
    reminders: state.reminders,
    childSessionLinks: state.childSessionLinks,
    ...(state.delegationRequest === undefined ? {} : { delegationRequest: state.delegationRequest }),
    toolBatches: state.toolBatches,
    rootSessionId: state.rootSessionId,
    eventCursor: state.nextEventId > 0 ? state.nextEventId - 1 : -1,
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
    ...(state.goal === undefined ? {} : { goal: state.goal }),
    ...(state.source === undefined ? {} : { source: state.source }),
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
    messages: persistedMessages(state.messages),
    pendingMessages: state.pendingMessages,
    ...(state.queueDispatchBarrierAt === undefined ? {} : {
      queueDispatchBarrierAt: state.queueDispatchBarrierAt,
    }),
    inputRequestReceipts: state.inputRequestReceipts,
    steps: state.steps,
    stats: state.stats,
    executions: state.executions,
    promptTraces: state.promptTraces,
    compression: state.compression,
    todos: state.todos,
    reminders: state.reminders,
    childSessionLinks: state.childSessionLinks,
    ...(state.delegationRequest === undefined ? {} : { delegationRequest: state.delegationRequest }),
    toolBatches: state.toolBatches,
    rootSessionId: state.rootSessionId,
    eventCursor: state.nextEventId > 0 ? state.nextEventId - 1 : -1,
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
    ...(state.goal === undefined ? {} : { goal: state.goal }),
    ...(state.source === undefined ? {} : { source: state.source }),
  };
}

function persistedMessages(messages: readonly StoredMessage[]): StoredMessage[] {
  let changed = false;
  const projected = messages.map((message) => {
    let messageChanged = false;
    const parts = message.parts.map((part) => {
      if (
        part.type !== "tool"
        || part.state !== "running"
        || part.liveOutput === undefined
      ) return part;
      const { liveOutput: _liveOutput, ...persisted } = part;
      changed = true;
      messageChanged = true;
      return persisted;
    });
    return messageChanged ? { ...message, parts } as StoredMessage : message;
  });
  return changed ? projected : [...messages];
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
        ...(parsed.delegationRequest === undefined ? {} : { delegationRequest: parsed.delegationRequest }),
        ...(parsed.goal === undefined ? {} : { goal: parsed.goal }),
        ...(parsed.source === undefined ? {} : { source: parsed.source }),
        agentName: parsed.agentName,
        profile: resolveSessionProfile(parsed),
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

async function listSessionInventory(workspaceRoot: string): Promise<ProjectSessionInventoryItem[]> {
  const dir = getSessionsDir(workspaceRoot);
  const names = await readTopLevelSessionDirNames(dir);
  const sessions: Array<{ item: ProjectSessionInventoryItem; sortKey: number }> = [];

  for (const name of names) {
    const parsed = await readSessionFile(name, workspaceRoot);
    if (parsed.parentSessionId !== undefined || parsed.rootSessionId !== parsed.sessionId) continue;
    if (parsed.source === undefined) throw new Error(`Root Session is missing source: ${parsed.sessionId}`);
    const summary = {
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      rootSessionId: parsed.rootSessionId,
      source: parsed.source,
      ...(parsed.goal === undefined ? {} : { goal: parsed.goal }),
      agentName: parsed.agentName,
      profile: resolveSessionProfile(parsed),
      activeSkillNames: parsed.activeSkillNames,
      modelSelection: parsed.modelSelection,
      title: parsed.title,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
    const latest = parsed.executions.at(-1);
    sessions.push({
      item: {
        session: { ...summary, source: summary.source },
        latestExecution: latest === undefined
          ? null
          : {
            id: latest.id,
            status: latest.status,
            startedAt: latest.startedAt,
            ...("endedAt" in latest ? { endedAt: latest.endedAt } : {}),
          },
      },
      sortKey: parsed.updatedAt,
    });
  }

  return sessions
    .sort((left, right) => right.sortKey - left.sortKey)
    .map(({ item }) => item);
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
      ...(parsed.goal === undefined ? {} : { goal: parsed.goal }),
      ...(parsed.source === undefined ? {} : { source: parsed.source }),
      agentName: parsed.agentName,
      profile: resolveSessionProfile(parsed),
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
  listSessionInventory,
  scanAllSessionSummaries,
  scanDescendants,
  readTopLevelSessionDirNames,
};
