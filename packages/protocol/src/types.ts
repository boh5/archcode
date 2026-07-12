export interface ExecutionStartEvent {
  type: "execution-start";
  executionId?: string;
}

export interface ExecutionEndEvent {
  type: "execution-end";
  status: "completed" | "max_steps" | "failed" | "aborted" | "cancelled" | "timed_out" | "interrupted" | "waiting_for_human";
  error?: string;
  blockedByHitlIds?: string[];
  blockedToolCallId?: string;
  blockedHitl?: SessionHitlCheckpoint;
}

/** Durable Session execution-directory transition. Session storage remains at the canonical project root. */
export interface SessionCwdChangedEvent {
  type: "session.cwd_changed";
  previousCwd: string;
  cwd: string;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
}

export interface SessionStats {
  messages: { user: number; assistant: number; total: number };
  tools: { calls: number; completed: number; failed: number };
  steps: { started: number; completed: number };
  usage: NormalizedUsage;
}

export interface SessionExecutionRecord {
  id: string;
  startedAt: number;
  status: "running" | ExecutionEndEvent["status"];
  endedAt?: number;
  durationMs?: number;
  error?: string;
}

export interface SessionHitlCheckpoint {
  version: 1;
  hitlId: string;
  blockingKey?: string;
  source?: HitlSource;
  toolCallId?: string;
  toolName?: string;
  step?: number;
  assistantMessageId?: string;
  displayInput?: unknown;
  blockedAt: string;
  reason?: string;
}

export type SessionTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface SessionTodo {
  id: string;
  content: string;
  status: SessionTodoStatus;
  createdAt?: number;
  updatedAt?: number;
}

export type ReminderSource =
  | {
      type: "todo_step_reminder";
      pendingTodos: SessionTodo[];
    }
  | {
      type: "todo_loop_continuation";
      pendingTodos: SessionTodo[];
    }
  | {
      type: "subagent_completed";
      sessionId: string;
    }
  | {
      type: "subagent_failed";
      sessionId: string;
    }
  | {
      type: "subagent_timed_out";
      sessionId: string;
    }
  | {
      type: "subagent_cancelled";
      sessionId: string;
    };

export interface Reminder {
  id: string;
  source: ReminderSource;
  delivery: "auto_inject" | "on_demand";
  sessionId?: string;
  terminalState?: string;
  content: string;
  payload?: unknown;
  createdAt: number;
  consumedAt: number | null;
  targetSessionId?: string;
}

export interface UserMessageEvent {
  type: "user-message";
  content: string;
}

export interface SystemNoticeEvent {
  type: "system-notice";
  message: string;
}

export interface TextStartEvent {
  type: "text-start";
}

export interface TextDeltaEvent {
  type: "text-delta";
  text: string;
}

export interface TextEndEvent {
  type: "text-end";
}

export interface ReasoningStartEvent {
  type: "reasoning-start";
}

export interface ReasoningDeltaEvent {
  type: "reasoning-delta";
  text: string;
}

export interface ReasoningEndEvent {
  type: "reasoning-end";
}

export interface ToolInputStartEvent {
  type: "tool-input-start";
  toolCallId: string;
  toolName: string;
}

export interface ToolCallEvent {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolInputResolvedEvent {
  type: "tool-input-resolved";
  toolCallId: string;
  toolName: string;
  /** The full input after Zod safeParse — includes defaults filled in. Already redacted. */
  input: unknown;
}

export interface ToolAttemptEvent {
  type: "tool-attempt";
  toolCallId: string;
  toolName: string;
  attemptId: string;
  timestamp: number;
  destructive: boolean;
}

export interface ToolResultEvent {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
  meta?: Record<string, unknown>;
}

export type ToolChildSessionLinkStatus =
  | "linked"
  | "running"
  | "waiting_for_human"
  | "cancelling"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted";

export interface ToolChildSessionLink {
  parentSessionId: string;
  parentToolCallId: string;
  toolName: string;
  childSessionId: string;
  childAgentName: string;
  title?: string;
  description?: string;
  depth: number;
  background: boolean;
  status: ToolChildSessionLinkStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  summary?: string;
  error?: string;
}

export interface ToolChildSessionLinkEvent {
  type: "tool-child-session-link";
  link: ToolChildSessionLink;
}

export interface CompactEvent {
  type: "compact";
  summary: string;
  tailStartId: string;
}

export type CompressionMessageRef = `m${string}`;
export type CompressionBlockRef = `b${number}`;
export type CompressionStrategy = "dynamic-range";
export type CompressionTrigger =
  | "model_tool_call"
  | "soft_nudge_response"
  | "strong_nudge_response";
export type CompressionBlockStatus = "active" | "inactive" | "superseded";

export interface CompressionRefMapSnapshot {
  messageRefsById: Record<string, CompressionMessageRef>;
  messageIdsByRef: Record<CompressionMessageRef, string>;
  blockRefsById: Record<string, CompressionBlockRef>;
  blockIdsByRef: Record<CompressionBlockRef, string>;
  nextMessageIndex: number;
  nextBlockIndex: number;
}

export interface CompressionRangeSnapshot {
  startMessageId: string;
  endMessageId: string;
  startRef: CompressionMessageRef;
  endRef: CompressionMessageRef;
  startIndex: number;
  endIndex: number;
}

export interface CompressionTokenEstimateSnapshot {
  originalTokens: number;
  summaryTokens: number;
  savedTokens: number;
  estimatedAt: number;
}

export interface CompressionBlockSnapshot {
  id: string;
  ref: CompressionBlockRef;
  status: CompressionBlockStatus;
  strategy: CompressionStrategy;
  trigger: CompressionTrigger;
  range: CompressionRangeSnapshot;
  summary: string;
  childBlockRefs: CompressionBlockRef[];
  protectedRefs: Array<CompressionMessageRef | CompressionBlockRef>;
  tokenEstimate?: CompressionTokenEstimateSnapshot;
  createdAt: number;
  updatedAt: number;
  deactivatedAt?: number;
  supersededBy?: CompressionBlockRef;
}

export interface CompressionFailureSnapshot {
  id: string;
  reason: string;
  startRef?: CompressionMessageRef;
  endRef?: CompressionMessageRef;
  strategy?: CompressionStrategy;
  failedAt: number;
}

export interface CompressionStateSnapshot {
  version: 1;
  refMap: CompressionRefMapSnapshot;
  blocksByRef: Record<CompressionBlockRef, CompressionBlockSnapshot>;
  activeBlockRefs: CompressionBlockRef[];
  inactiveBlockRefs: CompressionBlockRef[];
  supersededBlockRefs: CompressionBlockRef[];
  failures: CompressionFailureSnapshot[];
  updatedAt?: number;
}

export interface CompressionBlockCommittedEvent {
  type: "compression.block_committed";
  block: CompressionBlockSnapshot;
  state?: CompressionStateSnapshot;
}

export interface CompressionBlockFailedEvent {
  type: "compression.block_failed";
  failure: CompressionFailureSnapshot;
  state?: CompressionStateSnapshot;
}

export interface CompressionRefMapUpdatedEvent {
  type: "compression.ref_map_updated";
  refMap: CompressionRefMapSnapshot;
  updatedAt?: number;
}

export type CompressionStreamEvent =
  | CompressionBlockCommittedEvent
  | CompressionBlockFailedEvent
  | CompressionRefMapUpdatedEvent;

export interface TodoWriteEvent {
  type: "todo-write";
  todos: SessionTodo[];
}

export interface ReminderEvent {
  type: "reminder";
  reminder: Reminder;
}

export interface ReminderConsumedEvent {
  type: "reminder-consumed";
  reminderIds: string[];
}

export interface StepStartEvent {
  type: "step-start";
  step: number;
}

export interface StepEndEvent {
  type: "step-end";
  step: number;
  finishReason: string;
  usage?: unknown;
}

export interface LoopErrorEvent {
  type: "loop-error";
  step?: number;
  error: string;
}

export type LlmRecoveryScope = "short" | "session";
export type LlmRecoveryVisibility = "internal" | "session";

export interface LlmRetryEvent {
  type: "llm-retry";
  scope: LlmRecoveryScope;
  visibility: LlmRecoveryVisibility;
  profile?: string;
  attempt: number;
  errorKind: string;
  message: string;
  nextRetryAt?: number;
  stepId?: string;
  messageId?: string;
  toolCallId?: string;
}

export interface LlmRecoveryEvent {
  type: "llm-recovery";
  scope: LlmRecoveryScope;
  visibility: LlmRecoveryVisibility;
  profile?: string;
  errorKind?: string;
  attempt: number;
  message: string;
  stepId?: string;
  messageId?: string;
  toolCallId?: string;
}

export interface LlmRecoveryFailedEvent {
  type: "llm-recovery-failed";
  scope: "session";
  visibility: "session";
  profile?: string;
  attempt: number;
  errorKind: string;
  message: string;
  statusCode?: number;
  stepId?: string;
  messageId?: string;
  toolCallId?: string;
}

export type StreamEvent =
  | ExecutionStartEvent
  | ExecutionEndEvent
  | SessionCwdChangedEvent
  | UserMessageEvent
  | SystemNoticeEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ReasoningStartEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | ToolInputStartEvent
  | ToolCallEvent
  | ToolInputResolvedEvent
  | ToolAttemptEvent
  | ToolResultEvent
  | ToolChildSessionLinkEvent
  | TodoWriteEvent
  | ReminderEvent
  | ReminderConsumedEvent
  | StepStartEvent
  | StepEndEvent
  | LoopErrorEvent
  | LlmRetryEvent
  | LlmRecoveryEvent
  | LlmRecoveryFailedEvent
  | CompactEvent
  | CompressionStreamEvent
  | GoalStreamEvent
  | HitlStreamEvent
  | LoopStreamEvent;

export const MAX_EVENTS = 10000;

export interface SessionEventEnvelope<P extends SessionEventPayload = SessionEventPayload> {
  id: number;
  createdAt: number;
  kind: P["type"];
  payload: P;
}

// Global SSE wire protocol events.
export interface GlobalSessionEventEnvelope<P extends SessionEventPayload = SessionEventPayload> {
  type: "event";
  slug: string;
  sessionId: string;
  eventId: number;
  createdAt: number;
  kind: P["type"];
  payload: P;
  agentName: string;
}

export interface GlobalSSEHeartbeatEvent {
  type: "heartbeat";
  createdAt: number;
}

export interface GlobalSSEResetEvent {
  type: "reset";
  slug: string;
  sessionId: string;
  reason: "stale_cursor" | "store_unavailable" | "lagged";
}

export interface GlobalSSELaggedEvent {
  type: "lagged";
  dropped: number;
  reason: "client_backpressure";
}

export interface GlobalSSEShutdownEvent {
  type: "shutdown";
  reason?: string;
}

export type McpServerStatus =
  | { state: "pending" }
  | { state: "ready"; toolCount: number }
  | { state: "failed"; error: string }
  | { state: "disabled" };

export interface GlobalSSEMcpStatusEvent {
  type: "mcp_status";
  serverName: string;
  status: McpServerStatus;
  createdAt: number;
}

/** Live ownership of one root Session and every descendant execution. */
export type SessionFamilyActivity = "idle" | "running" | "stopping";

export interface SessionFamilyRuntimeProjection {
  projectSlug: string;
  rootSessionId: string;
  activity: SessionFamilyActivity;
}

/** Authoritative reset for every project listed in projectSlugs. */
export interface GlobalSSESessionRuntimeSnapshotEvent {
  type: "session.runtime.snapshot";
  projectSlugs: string[];
  /** Idle families are omitted; consumers clear listed projects before applying these rows. */
  families: SessionFamilyRuntimeProjection[];
  createdAt: number;
}

export interface GlobalSSESessionRuntimeChangedEvent extends SessionFamilyRuntimeProjection {
  type: "session.runtime_changed";
  createdAt: number;
}

export interface GlobalSSEHitlSnapshotEvent {
  type: "hitl.snapshot";
  projectSlugs: string[];
  /** Complete active HITL projection set for the listed projects. */
  projections: HitlProjection[];
  createdAt: number;
}

export type GlobalSSEHitlEventPayload =
  | { type: "hitl.request"; status: Extract<HitlStatus, "pending"> }
  | { type: "hitl.updated"; status: HitlStatus }
  | { type: "hitl.resolved"; status: Extract<HitlStatus, "resolved" | "cancelled" | "resume_failed"> };

export interface GlobalSSEHitlRealtimeEvent {
  type: "hitl.event";
  projectSlug: string;
  owner: HitlOwnerKey;
  hitlId: string;
  createdAt: number;
  payload: GlobalSSEHitlEventPayload;
  projection: HitlProjection;
}

export interface GlobalSSEResourceChangedEvent {
  type: "resource.changed";
  projectSlug: string;
  resourceType: "goal" | "loop";
  resourceId: string;
  reason: "created" | "title_generated";
  createdAt: number;
}

export type GlobalSSEEvent =
  | GlobalSessionEventEnvelope
  | GlobalSSEHeartbeatEvent
  | GlobalSSEResetEvent
  | GlobalSSELaggedEvent
  | GlobalSSEShutdownEvent
  | GlobalSSEMcpStatusEvent
  | GlobalSSESessionRuntimeSnapshotEvent
  | GlobalSSESessionRuntimeChangedEvent
  | GlobalSSEHitlSnapshotEvent
  | GlobalSSEHitlRealtimeEvent
  | GlobalSSEResourceChangedEvent;

export interface ShutdownEvent {
  type: "shutdown";
  reason?: string;
}

export type SessionEventPayload =
  | StreamEvent
  | ShutdownEvent;

export interface TextPart {
  type: "text";
  id: string;
  text: string;
  createdAt: number;
  completedAt?: number;
  /** Set when a partial model stream was persisted for UI/history but must not be trusted as completed context. */
  meta?: Record<string, unknown>;
}

export interface ReasoningPart {
  type: "reasoning";
  id: string;
  text: string;
  createdAt: number;
  completedAt?: number;
  /** Set when partial reasoning was persisted for UI/history but must not be trusted as completed context. */
  meta?: Record<string, unknown>;
}

export interface PendingToolPart {
  type: "tool";
  id: string;
  state: "pending";
  toolCallId: string;
  toolName: string;
  createdAt: number;
  attemptId?: string;
  attemptTimestamp?: number;
  attemptDestructive?: boolean;
  meta?: Record<string, unknown>;
}

export interface RunningToolPart {
  type: "tool";
  id: string;
  state: "running";
  toolCallId: string;
  toolName: string;
  input: unknown;
  createdAt: number;
  startedAt: number;
  attemptId?: string;
  attemptTimestamp?: number;
  attemptDestructive?: boolean;
  meta?: Record<string, unknown>;
}

export interface CompletedToolPart {
  type: "tool";
  id: string;
  state: "completed";
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: string;
  createdAt: number;
  startedAt: number;
  endedAt: number;
  meta?: Record<string, unknown>;
  attemptId?: string;
  attemptTimestamp?: number;
  attemptDestructive?: boolean;
}

export interface ErrorToolPart {
  type: "tool";
  id: string;
  state: "error";
  toolCallId: string;
  toolName: string;
  input: unknown;
  errorMessage: string;
  createdAt: number;
  startedAt: number;
  endedAt: number;
  /** Set meta.unknownResult=true when an attempted effectful tool was interrupted before a durable result. */
  meta?: Record<string, unknown>;
  attemptId?: string;
  attemptTimestamp?: number;
  attemptDestructive?: boolean;
}

export type ToolPart = PendingToolPart | RunningToolPart | CompletedToolPart | ErrorToolPart;

export interface CompactionPart {
  type: "compaction";
  id: string;
  summary: string;
  tailStartId: string;
  compactedAt: number;
}

export interface CompressionBlockPart {
  type: "compression-block";
  id: string;
  blockRef: CompressionBlockRef;
  status: CompressionBlockStatus;
  strategy: CompressionStrategy;
  trigger: CompressionTrigger;
  summary: string;
  startRef: CompressionMessageRef;
  endRef: CompressionMessageRef;
  childBlockRefs: CompressionBlockRef[];
  committedAt: number;
}

export interface SystemNoticePart {
  type: "system-notice";
  id: string;
  notice: string;
  createdAt: number;
  completedAt?: number;
}

export interface RecoveryNoticePart {
  type: "recovery-notice";
  id: string;
  status: "scheduled" | "retrying" | "recovered" | "failed";
  message: string;
  attempt: number;
  nextRetryAt?: number;
  errorKind?: string;
  statusCode?: number;
  createdAt: number;
  completedAt?: number;
}

export type SessionPart = TextPart | ReasoningPart | ToolPart | CompactionPart | SystemNoticePart | RecoveryNoticePart;

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  parts: SessionPart[];
  createdAt: number;
  completedAt?: number;
  executionId?: string;
  compacted?: boolean;
}

export interface SessionStep {
  id: string;
  step: number;
  executionId?: string;
  startedAt: number;
  completedAt?: number;
  finishReason?: string;
  usage?: unknown;
  error?: string;
}

export interface SessionModelInfo {
  displayName: string;
  modelId: string;
  providerId: string;
  qualifiedId: string;
}

export interface SessionProjection {
  sessionId: string;
  /** Current execution directory when the projection is used for a Session surface. */
  cwd: string;
  rootSessionId: string;
  parentSessionId?: string;
  title: string | null;
  messages: SessionMessage[];
  steps: SessionStep[];
  todos: SessionTodo[];
  reminders: Reminder[];
  childSessionLinks: ToolChildSessionLink[];
  stats: SessionStats;
  executions: SessionExecutionRecord[];
  executionCount: number;
  blockedHitl?: SessionHitlCheckpoint;
  blockedByHitlIds?: string[];
  isRunning: boolean;
  isStreamingModel: boolean;
  currentExecutionId?: string;
  currentAssistantMessageId?: string;
  modelInfo?: SessionModelInfo | null;
  /** Goal states indexed by goalId. Populated by goal.state_change events. */
  goals?: Record<string, GoalState>;
  /** Owner-local HITL records projected from hitl.request/hitl.resolved stream events. */
  hitlRequests?: HitlRecord[];
  /** Loop states indexed by loopId. Populated by loop.state_change events. */
  loops?: Record<string, LoopState>;
  /** DCP-like dynamic compression state. Cleared when hard compact emits a compact event. */
  compression?: CompressionStateSnapshot;
  /** Projection-only compression block display parts. Canonical messages remain unchanged. */
  compressionBlocks?: CompressionBlockPart[];
}

export interface Project {
  slug: string;
  name: string;
  workspaceRoot: string;
  addedAt: string;
  lastOpenedAt?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: "directory";
}

export interface DirectoryListResponse {
  entries: DirectoryEntry[];
  truncated: boolean;
}

export interface DirectorySearchResponse {
  entries: DirectoryEntry[];
  truncated: boolean;
}

/** Public, presentation-safe metadata for a configured Agent role. */
export interface AgentDescriptor {
  name: string;
  displayName: string;
}

export interface SessionSummary {
  sessionId: string;
  /** Current execution directory. */
  cwd: string;
  // Tree relationships derive from child session files, not childSessionIds/subAgentDescriptions caches.
  rootSessionId: string;
  parentSessionId?: string;
  agentName: string;
  modelInfo: SessionModelInfo | null;
  title: string | null;
  /** Goal this session belongs to. */
  goalId?: string;
  /** Loop this session belongs to. */
  loopId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionTreeNode {
  session: SessionSummary;
  children: SessionTreeNode[];
}

export type SessionTreeDiagnosticType =
  | "invalid_json"
  | "session_id_mismatch"
  | "root_mismatch"
  | "missing_parent"
  | "cycle"
  | "duplicate_session"
  | "not_root";

export interface SessionTreeDiagnostic {
  type: SessionTreeDiagnosticType;
  sessionId?: string;
  filePath?: string;
  message: string;
}

export interface SessionTreeResponse {
  root: SessionTreeNode;
  diagnostics: SessionTreeDiagnostic[];
}

export interface Session {
  schemaVersion: 1;
  sessionId: string;
  cwd: string;
  rootSessionId: string;
  title: string | null;
  /** Goal this session belongs to. */
  goalId?: string;
  /** Loop this session belongs to. */
  loopId?: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
  steps: SessionStep[];
  todos: SessionTodo[];
  reminders: Reminder[];
  childSessionLinks: ToolChildSessionLink[];
  stats: SessionStats;
  executions: SessionExecutionRecord[];
  events?: SessionEventEnvelope[];
  parentSessionId?: string;
  eventCursor?: number;
  modelInfo: SessionModelInfo | null;
  agentName: string;
  blockedHitl?: SessionHitlCheckpoint;
  blockedByHitlIds?: string[];
}

export type DiffLineType = "context" | "add" | "delete";

export interface DiffLine {
  type: DiffLineType;
  content: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  status?: "modified" | "created" | "deleted";
  additions?: number;
  deletions?: number;
  hunks: DiffHunk[];
}

export type ToolDiffUnsupportedReason = "binary" | "too_large" | "not_text" | "no_change" | "diff_error";

export interface ToolDiffMetadata {
  version: 1;
  files: DiffFile[];
  truncated?: boolean;
  unsupportedReason?: ToolDiffUnsupportedReason;
  warning?: string;
}

export interface ToolResultMeta {
  /** True when an effectful tool attempt was durably recorded but execution stopped before a result was known. */
  unknownResult?: boolean;
  diffs?: ToolDiffMetadata;
  [key: string]: unknown;
}

// ─── Goal Types ───

export type GoalStatus =
  | "draft"
  | "running"
  | "blocked"
  | "reviewing"
  | "done"
  | "not_done"
  | "failed"
  | "cancelled";

export type GoalBlockerKind = "approval" | "question" | "budget" | "permission" | "tool_error";

export type GoalEvidenceRefKind =
  | "session"
  | "message"
  | "tool_call"
  | "diff"
  | "test_output"
  | "file"
  | "url"
  | "hitl";

export type GoalReviewVerdict = "DONE" | "NOT_DONE";

export interface GoalEvidenceRef {
  kind: GoalEvidenceRefKind;
  ref: string;
  summary: string;
  sessionId?: string;
  messageId?: string;
  toolCallId?: string;
  path?: string;
  url?: string;
  createdAt?: string;
}

export interface GoalReviewReceipt {
  reviewGeneration: number;
  verdict: GoalReviewVerdict;
  summary: string;
  evidenceRefs: GoalEvidenceRef[];
  unresolvedItems?: string[];
  reviewerSessionId: string;
  decidedAt: string;
}

export interface GoalBlocker {
  kind: GoalBlockerKind;
  summary: string;
  hitlId?: string;
  source?: string;
  resumeStatus: "running" | "reviewing";
  createdAt: string;
}

export interface GoalBudgetSummary {
  status: "ok" | "warning" | "blocked";
  usedTokens?: number;
  maxTokens?: number;
  reason?: string;
  updatedAt: string;
}

export interface GoalWorktree {
  path: string;
  branchName: string;
  baseSha: string;
  createdAt: string;
}

export interface GoalState {
  version: 2;
  id: string;
  projectId: string;
  title: string | null;
  objective: string;
  acceptanceCriteria: string;
  useWorktree: boolean;
  worktree?: GoalWorktree;
  status: GoalStatus;
  blocker?: GoalBlocker;
  attempt: number;
  reviewGeneration: number;
  lastFailureSummary?: string;
  budget?: GoalBudgetSummary;
  pendingHitlIds: string[];
  /** Durable attachment refs. Every attached HITL contributes its hitlId; an external approval ref may also be present. */
  approvalRefs: string[];
  /** HITL ids whose Goal-side effect committed, even if owner-record terminalization is still pending. */
  appliedHitlIds: string[];
  mainSessionId?: string;
  childSessionIds: string[];
  loopId?: string;
  review?: GoalReviewReceipt;
  finalSummary?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  lastError?: {
    name: string;
    message: string;
    at: string;
  };
}

export type HitlAttentionStatus = "clear" | "waiting_for_human";

// ─── Goal Stream Events ───

export type GoalStreamEvent = { type: "goal.state_change"; goalId: string; status: GoalStatus; state: GoalState };

// ─── HITL Types ───

export const HITL_RECENT_TERMINAL_LIMIT = 20;

export type HitlOwnerType = "session" | "goal" | "loop";

export interface HitlOwnerKey {
  projectSlug: string;
  ownerType: HitlOwnerType;
  ownerId: string;
  workspaceRoot?: never;
}

export interface HitlIdentity {
  owner: HitlOwnerKey;
  hitlId: string;
}

export function hitlIdentityKey(identity: HitlIdentity): string {
  return JSON.stringify([
    identity.owner.projectSlug,
    identity.owner.ownerType,
    identity.owner.ownerId,
    identity.hitlId,
  ]);
}

export type HitlStatus = "pending" | "resume_claimed" | "resolved" | "cancelled" | "resume_failed";

export type HitlSource =
  | { type: "ask_user"; sessionId: string; toolCallId?: string }
  | { type: "tool_permission"; sessionId: string; toolCallId: string; toolName: string }
  | { type: "goal_approval"; goalId: string; approvalPoint?: string; resumeStatus: "running" | "reviewing" }
  | { type: "goal_review"; goalId: string; resumeStatus: "reviewing" }
  | { type: "goal_budget"; goalId: string; approvalPoint?: string; resumeStatus: "running" | "reviewing" }
  | { type: "goal_question"; goalId: string; questionKey: string; resumeStatus: "running" | "reviewing" }
  | { type: "loop_approval"; loopId: string; approvalPoint: string }
  | { type: "loop_blocker"; loopId: string; runId?: string; reason: string }
  | { type: "loop_retry"; loopId: string; runId: string; attempt: number }
  | { type: "loop_question"; loopId: string; questionKey: string };

export interface HitlQuestionDisplayOption {
  label: string;
  description: string;
}

export interface HitlQuestionDisplayItem {
  question: string;
  header: string;
  options?: HitlQuestionDisplayOption[];
  multiple?: boolean;
  custom: boolean;
}

export interface HitlDisplayPayload {
  title: string;
  summary?: string;
  fields?: Array<{ label: string; value: string }>;
  questions?: HitlQuestionDisplayItem[];
  redacted: true;
}

export interface HitlResumeMetadata {
  claimId: string;
  claimedAt: string;
  claimedBy?: string;
  intent: "respond" | "cancel";
  attempt: number;
  lastError?: string;
  failedAt?: string;
  failureReason?: string;
}

export type HitlResponse =
  | { type: "question_answer"; answers: string[]; comment?: string; answeredBy?: string }
  | { type: "permission_decision"; decision: "approve_once" | "approve_always" | "deny"; comment?: string; decidedBy?: string }
  | { type: "approval_decision"; decision: "approved" | "denied"; comment?: string; decidedBy?: string }
  | { type: "review_outcome"; outcome: GoalReviewVerdict; comment?: string; receipt?: GoalReviewReceipt; reviewedBy?: string }
  | { type: "cancel"; reason: string; cancelledBy?: string };

export interface HitlRecord {
  hitlId: string;
  owner: HitlOwnerKey;
  /** Canonical root identity required exactly when owner.ownerType is session. */
  sessionRootId?: string;
  blockingKey: string;
  source: HitlSource;
  status: HitlStatus;
  displayPayload: HitlDisplayPayload;
  response?: HitlResponse;
  resume?: HitlResumeMetadata;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface HitlFile {
  version: 1;
  owner: HitlOwnerKey;
  pending: HitlRecord[];
  recentTerminal: HitlRecord[];
  updatedAt: string;
}

export type HitlAllowedAction = "answer" | "approve" | "deny" | "cancel" | "retry_resume";

export interface HitlProjectionContext {
  rootSessionId?: string;
  parentSessionId?: string;
  ancestorSessionIds?: string[];
  goalId?: string;
  loopId?: string;
  projectionPath?: string[];
}

export interface HitlProjection {
  hitlId: string;
  project: { slug: string; name?: string };
  owner: HitlOwnerKey;
  ancestry?: HitlProjectionContext;
  source: HitlSource;
  status: HitlStatus;
  displayPayload: HitlDisplayPayload;
  allowedActions: HitlAllowedAction[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

// ─── HITL Stream Events ───

export type HitlStreamEvent =
  | { type: "hitl.request"; request: HitlRecord }
  | { type: "hitl.updated"; record: HitlRecord }
  | { type: "hitl.resolved"; hitlId: string; status: Extract<HitlStatus, "resolved" | "cancelled" | "resume_failed">; response?: HitlResponse };

// ─── Loop Types ───

export type LoopId = string;

export type LoopStatus = "active" | "paused" | "disabled" | "error";

export type LoopScheduleSpec =
  | { kind: "manual" }
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expression: string };

export type LoopPullRequestScope = "open" | "authored" | "assigned" | "review_requested";

export type LoopTriggerSpec =
  | { kind: "on_commit"; branch?: string; cadenceMs: number }
  | { kind: "on_pr"; branch?: string; baseBranch?: string; prScope?: LoopPullRequestScope; cadenceMs: number }
  | { kind: "on_ci_fail"; branch?: string; baseBranch?: string; checkName?: string; workflowName?: string; cadenceMs: number };

export interface LoopCoordinatorConfig {
  maxConcurrent: number;
}

export interface LoopProjectConfig {
  coordinator: LoopCoordinatorConfig;
}

export type LoopRunKind = "session" | "goal";

export type LoopTemplateId = "watch_report" | "maintain_fix" | "pr_babysitter" | "goal_runner";

export type LoopApprovalPolicy = "interactive" | "explicit_per_run";

export interface LoopBudgetConfig {
  maxIterationsPerRun: number;
  maxTokensPerRun?: number;
  maxEstimatedUsdPerRun?: number;
  maxWallClockMsPerRun?: number;
  maxRunsPerDay?: number;
  softThresholdRatio: number;
  hardThresholdRatio: number;
}

export type LoopLimits = LoopBudgetConfig;

export interface LoopBudgetUsage {
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens: number;
  estimatedUsd?: number;
  wallClockMs: number;
  runsToday: number;
  resetDateUtc: string;
  pricingUnavailable?: boolean;
}

export type LoopRunReason =
  | "completed"
  | "soft_budget_blocked"
  | "hard_budget_exceeded"
  | "collision_conflict"
  | "cancelled_by_user"
  | "global_kill_active"
  | "loop_paused"
  | "integration_auth_missing"
  | "integration_rate_limited"
  | "execution_failed"
  | "max_steps_reached"
  | "scheduler_overlap";

export type CollisionTarget =
  | { type: "pr"; owner: string; repo: string; number: number }
  | { type: "issue"; owner: string; repo: string; number: number }
  | { type: "branch"; owner: string; repo: string; branch: string }
  | { type: "file"; path: string };

export interface CollisionLease {
  targetKey: string;
  target: CollisionTarget;
  loopId: string;
  runId: string;
  actionId?: string;
  toolCallId?: string;
  priority: number;
  createdAt: number;
  expiresAt: number;
}

export interface CollisionConflict {
  targetKey: string;
  target: CollisionTarget;
  conflictingLease: CollisionLease;
  detectedAt: number;
}

export type LoopIntegrationId = "github" | "github_actions";

export interface LoopIntegrationError {
  integrationId: LoopIntegrationId;
  reason: Extract<LoopRunReason, "integration_auth_missing" | "integration_rate_limited">;
  message: string;
  retryAfterMs?: number;
  occurredAt: number;
}

export interface LoopBudgetSnapshot {
  budget: LoopBudgetConfig;
  usage: LoopBudgetUsage;
  updatedAt: number;
}

export interface LoopCollisionSnapshot {
  targets: CollisionTarget[];
  activeLeases: CollisionLease[];
  conflicts: CollisionConflict[];
  updatedAt: number;
}

export interface LoopIntegrationSnapshot {
  errors: LoopIntegrationError[];
  updatedAt: number;
}

export interface LoopGoalTemplate {
  title: string | null;
  objective: string;
  acceptanceCriteria: string;
}

export interface LoopConfig {
  templateId: LoopTemplateId;
  title: string | null;
  schedule: LoopScheduleSpec;
  approvalPolicy: LoopApprovalPolicy;
  limits: LoopLimits;
  collisionTargets?: CollisionTarget[];
  taskPrompt?: string;
  goalTemplate?: LoopGoalTemplate;
  triggers?: LoopTriggerSpec[];
  useWorktree: boolean;
  cleanupPolicy?: LoopCleanupPolicy;
}

export type LoopRunReportStatus = "running" | "succeeded" | "failed" | "skipped" | "cancelled" | "budget_exceeded" | "needs_user";

export interface LoopHitlCheckpoint {
  version: 1;
  hitlId: string;
  loopId: string;
  runId: string;
  jobId?: string;
  trigger: LoopRunTrigger;
  subjectKey?: string;
  worktreePath?: string;
  worktreeBranchName?: string;
  baseSha?: string;
  resolvedHeadSha?: string;
  intendedContinuation: "rerun_job" | "resume_run";
}

export type LoopRunTrigger = "manual" | "interval" | "cron" | LoopTriggerSpec["kind"];

export type LoopJobStatus =
  | "pending"
  | "queued"
  | "running"
  | "blocked"
  | "needs_user"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped"
  | "expired";

export type LoopCleanupState =
  | "not_started"
  | "in_progress"
  | "cleaned"
  | "preserved"
  | "failed"
  | "skipped"
  | "cleanup_candidate"
  | "auto_paused"
  | "cleanup_failed"
  | "expired_needs_review";

export interface LoopCleanupPolicy {
  enabled: boolean;
  action?: "mark" | "pause";
  deleteUnchangedWorktrees?: boolean;
  preserveChangedArtifacts?: true;
  maxPreservedWorktrees?: number;
  noFindingRuns?: number;
  quietDays?: number;
  requiresNoPendingQueue?: boolean;
}

export interface LoopWorktreeArtifact {
  path: string;
  status: "observed" | "unchanged" | "created" | "modified" | "deleted";
  sizeBytes?: number;
  sha?: string;
}

export interface LoopTriggerHealth {
  triggerKind: LoopRunTrigger;
  status: "healthy" | "degraded" | "blocked" | "disabled";
  cadenceMs?: number;
  lastCheckedAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  retryAfterMs?: number;
  missedCount?: number;
}

export interface LoopRunReport {
  runId: string;
  loopId: string;
  status: LoopRunReportStatus;
  trigger: LoopRunTrigger;
  startedAt: number;
  endedAt?: number;
  reason?: LoopRunReason;
  budgetUsage?: LoopBudgetUsage;
  collisionTargets?: CollisionTarget[];
  collisionConflicts?: CollisionConflict[];
  integrationErrors?: LoopIntegrationError[];
  sessionId?: string;
  goalId?: string;
  summary?: string;
  error?: string;
  skippedReason?: string;
  jobId?: string;
  subjectKey?: string;
  dedupeKey?: string;
  branchKey?: string;
  worktreePath?: string;
  /** Exact managed Git branch owning worktreePath; never stored in lossy evidence artifacts. */
  worktreeBranchName?: string;
  baseSha?: string;
  resolvedHeadSha?: string;
  missedCount?: number;
  blockedReason?: string;
  blockedByHitlIds?: string[];
  attentionStatus?: HitlAttentionStatus;
  resumeCheckpoint?: LoopHitlCheckpoint;
  cleanupState?: LoopCleanupState;
  cleanupWarning?: string;
  observedArtifacts?: LoopWorktreeArtifact[];
}

export interface LoopState {
  loopId: string;
  projectId: string;
  config: LoopConfig;
  status: LoopStatus;
  createdAt: number;
  updatedAt: number;
  lastRun?: LoopRunReport;
  currentRun?: LoopRunReport;
  nextRunAt?: number;
  lastScheduledAt?: number;
  nextScheduledAt?: number;
  lastEnqueuedAt?: number;
  missedCount?: number;
  runCount: number;
  stateVersion: number;
  generatedStateSummary?: string;
  latestBudget?: LoopBudgetSnapshot;
  latestCollisions?: LoopCollisionSnapshot;
  latestIntegrations?: LoopIntegrationSnapshot;
  blockedByHitlIds?: string[];
  attentionStatus?: HitlAttentionStatus;
  resumeCheckpoint?: LoopHitlCheckpoint;
  triggerHealth?: LoopTriggerHealth[];
  cleanupState?: LoopCleanupState;
}

// ─── Loop Stream Events ───

export type LoopStreamEvent =
  | { type: "loop.state_change"; loopId: string; status: LoopStatus; state: LoopState }
  | { type: "loop.run_appended"; loopId: string; report: LoopRunReport };

export interface ApiCommandResult {
  success: boolean;
  message: string;
}
