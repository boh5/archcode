export interface ExecutionStartEvent {
  type: "execution-start";
  executionId?: string;
}

export interface ExecutionEndEvent {
  type: "execution-end";
  status: "completed" | "max_steps" | "failed" | "aborted" | "cancelled" | "timed_out" | "interrupted" | "waiting_for_human";
  error?: string;
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

export type GlobalSSEEvent =
  | GlobalSessionEventEnvelope
  | GlobalSSEHeartbeatEvent
  | GlobalSSEResetEvent
  | GlobalSSELaggedEvent
  | GlobalSSEShutdownEvent
  | GlobalSSEMcpStatusEvent;

export interface PermissionRequestEvent {
  type: "permission.request";
  permissionId: string;
  toolName: string;
  args: unknown;
  description?: string;
}

export interface PermissionTerminalEvent {
  type: "permission.terminal";
  permissionId: string;
  status: "resolved" | "denied" | "timeout" | "cancelled";
}

export interface QuestionRequestEvent {
  type: "question.request";
  questionId: string;
  question: string;
  questionType?: "decision" | "approval" | "clarification";
  context?: Record<string, unknown>;
}

export interface PendingInteraction {
  id: string;
  type: "decision" | "approval" | "clarification";
  question: string;
  context?: Record<string, unknown>;
  askedAt: string;
  status: "pending" | "answered" | "expired";
  answer?: { content: string; answeredAt: string };
}

export interface QuestionTerminalEvent {
  type: "question.terminal";
  questionId: string;
  status: "resolved" | "denied" | "timeout" | "cancelled";
  answer?: string;
}

export interface ShutdownEvent {
  type: "shutdown";
  reason?: string;
}

export type SessionEventPayload =
  | StreamEvent
  | PermissionRequestEvent
  | PermissionTerminalEvent
  | QuestionRequestEvent
  | QuestionTerminalEvent
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
  rootSessionId: string;
  parentSessionId?: string;
  title: string | null;
  messages: SessionMessage[];
  steps: SessionStep[];
  todos: SessionTodo[];
  pendingInteractions?: PendingInteraction[];
  reminders: Reminder[];
  childSessionLinks: ToolChildSessionLink[];
  stats: SessionStats;
  executions: SessionExecutionRecord[];
  executionCount: number;
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
  lastOpened?: string;
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

export interface SessionSummary {
  sessionId: string;
  // Tree relationships derive from child session files, not childSessionIds/subAgentDescriptions caches.
  rootSessionId: string;
  parentSessionId?: string;
  agentName?: string | null;
  modelInfo?: SessionModelInfo | null;
  title?: string | null;
  /** Goal this session belongs to. */
  goalId?: string;
  /** Loop this session belongs to. */
  loopId?: string;
  createdAt: number;
  lastUpdatedAt?: number;
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
  id: string;
  sessionId?: string;
  rootSessionId: string;
  title?: string | null;
  /** Goal this session belongs to. */
  goalId?: string;
  /** Loop this session belongs to. */
  loopId?: string;
  createdAt: number;
  updatedAt?: number;
  lastUpdatedAt?: number;
  messages?: SessionMessage[];
  steps?: SessionStep[];
  todos?: SessionTodo[];
  reminders?: unknown[];
  childSessionLinks?: ToolChildSessionLink[];
  stats?: SessionStats;
  executions?: SessionExecutionRecord[];
  events?: SessionEventEnvelope[];
  parentSessionId?: string;
  eventCursor?: number;
  modelInfo?: SessionModelInfo | null;
  agentName?: string;
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

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  description: string;
  reason?: string;
  approval?: unknown;
  agentName?: string;
  currentDepth?: number;
  decisionDisplay?: string;
  ruleId?: string;
}

export interface QuestionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  questions: unknown[];
}

// ─── Goal Types ───

export type GoalStatus =
  | "draft" | "locked" | "running" | "verifying"
  | "reviewed" | "completed" | "failed" | "escalated"
  | "paused"; // paused for safe interruption

export type GoalPhase = "plan" | "build" | "review";

export type DoneConditionKind =
  // Layer 1: machine-checkable (7 kinds)
  | "tests_pass" | "typecheck_pass" | "lsp_clean"
  | "file_exists" | "grep_contains" | "grep_empty"
  | "command_succeeds"
  // Layer 1: HITL (1 kind, non-machine check)
  | "user_confirmed"
  // Layer 2: Reviewer-owned structured per-criterion evidence
  | "spec_compliance";

// DoneCondition: discriminated union by kind (type-safe params)
export type DoneCondition =
  | { id: string; kind: "tests_pass"; params: { command?: string }; required?: boolean }
  | { id: string; kind: "typecheck_pass"; params: { command?: string }; required?: boolean }
  | { id: string; kind: "lsp_clean"; params: { paths?: string[]; severity?: "error" | "warning" }; required?: boolean }
  | { id: string; kind: "file_exists"; params: { path: string }; required?: boolean }
  | { id: string; kind: "grep_contains"; params: { pattern: string; path?: string; minMatches?: number }; required?: boolean }
  | { id: string; kind: "grep_empty"; params: { pattern: string; path?: string }; required?: boolean }
  | { id: string; kind: "command_succeeds"; params: { command: string; timeoutMs?: number }; required?: boolean }
  | { id: string; kind: "user_confirmed"; params: { prompt: string }; required?: boolean }
  | { id: string; kind: "spec_compliance"; params: { specPath: string; focusAreas?: string[] }; required?: boolean };
// required defaults true; false = soft hint

export interface DoneResult {
  conditionId: string;
  passed: boolean;
  evidence: string;   // machine output or Reviewer evidence summary
  checkedAt: string;
  specCompliance?: GoalSpecComplianceEvidence;
  review?: GoalReviewReport;
}

export type GoalArtifactName =
  | "plan.md"
  | "build.md"
  | "review.md"
  | "spec-compliance.md"
  | "approvals.md"
  | "budget.md"
  | "retry-log.md"
  | "final-report.md";

export interface GoalArtifactFile {
  name: GoalArtifactName;
  path: string;
  mediaType: "text/markdown";
  updatedAt?: string;
  sizeBytes?: number;
  sha256?: string;
}

export type GoalReviewOutcome = "DONE" | "NOT_DONE";

export interface GoalSpecComplianceCriterionEvidence {
  criterionId: string;
  criterion: string;
  compliant: boolean;
  status?: "satisfied" | "failed";
  evidence: string[];
  artifactNames?: GoalArtifactName[];
  commandRefs?: string[];
  resultRefs?: string[];
  fileRefs?: string[];
  repairGuidance?: string;
}

export interface GoalSpecComplianceEvidence {
  checkedAt: string;
  specPath?: string;
  summary: string;
  criteria: GoalSpecComplianceCriterionEvidence[];
}

export interface GoalReviewReport {
  reviewerAgent: string;
  outcome: GoalReviewOutcome;
  reviewedAt: string;
  summary: string;
  criteria: GoalSpecComplianceCriterionEvidence[];
}

export interface GoalRepairIssue {
  conditionId: string;
  evidenceSummary: string;
  repairGuidance: string;
  repairTarget?: string;
  implicatedFiles?: string[];
  failingCommands?: string[];
  resultSummaries?: string[];
}

export interface GoalRepairContext {
  generatedAt: string;
  summary: string;
  issues: GoalRepairIssue[];
}

export type GoalTokenBudgetStatus = "ok" | "warning" | "exceeded" | "paused";

export interface GoalTokenBudgetState {
  status: GoalTokenBudgetStatus;
  maxTokens?: number;
  warningThresholdTokens?: number;
  warningApprovalPoint?: string;
  warningApprovalThresholdTokens?: number;
  warningApprovedAt?: string;
  warningApprovedTotalTokens?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens: number;
  updatedAt: string;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  escalateOnFailure: boolean; // true = retries exhausted → escalated, not failed
}

export type GoalRetryAttemptStatus = "scheduled" | "running" | "failed" | "succeeded" | "escalated";

export interface GoalRetryFailureMetadata {
  failedAt: string;
  errorKind: string;
  message: string;
  phase?: GoalPhase;
}

export interface GoalRetryAttemptMetadata {
  attempt: number;
  status: GoalRetryAttemptStatus;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  nextRetryAt?: string;
  failure?: GoalRetryFailureMetadata;
}

export interface GoalRetryState {
  retryCount: number;
  nextRetryAt?: string;
  lastFailure?: GoalRetryFailureMetadata;
  lastAttempt?: GoalRetryAttemptMetadata;
}

export type HitlAttentionStatus = "clear" | "waiting_for_human";

export interface GoalHitlCheckpoint {
  version: 1;
  hitlId: string;
  blockedAt: string;
  phase?: GoalPhase;
  reason?: string;
}

export type ApprovalPoint = "after_plan" | "before_complete";

export interface GoalState {
  id: string;
  projectId: string;  // slug
  title: string;
  status: GoalStatus;
  phase: GoalPhase;    // current phase (plan/build/review), persisted
  doneConditions: DoneCondition[];  // locked and immutable after lock
  doneResults: Record<string, DoneResult>;  // conditionId → latest result
  reviewerAgent: string;  // must ≠ executor, default "reviewer"
  retryPolicy: RetryPolicy;
  retryCount: number;
  retryState?: GoalRetryState;
  tokenBudget?: GoalTokenBudgetState;
  artifacts?: GoalArtifactFile[];
  reviewReport?: GoalReviewReport;
  repairContext?: GoalRepairContext;
  approvalPoints: ApprovalPoint[];
  author: string;      // done condition author (orchestrator/plan/user)
  lockedBy?: string;   // locker (user id)
  mainSessionId?: string;  // orchestrator session
  loopId?: string; // parent Loop, when a Loop creates or owns this Goal
  childSessionIds: string[];  // plan/build/review/explore/librarian
  attentionStatus?: HitlAttentionStatus;
  blockedByHitlIds?: string[];
  resumeCheckpoint?: GoalHitlCheckpoint;
  lockedAt?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

// ─── Goal Stream Events ───

export type GoalStreamEvent =
  | { type: "goal.state_change"; goalId: string; status: GoalStatus; state: GoalState }
  | { type: "goal.done_check"; goalId: string; results: DoneResult[]; review?: GoalReviewReport }
  | { type: "goal.escalation"; goalId: string; reason: string };

// ─── HITL Types ───

export const HITL_RECENT_TERMINAL_LIMIT = 20;

export type HitlOwnerType = "session" | "goal" | "loop";

export interface HitlOwnerKey {
  projectSlug: string;
  ownerType: HitlOwnerType;
  ownerId: string;
  workspaceRoot?: never;
}

export type HitlStatus = "pending" | "resume_claimed" | "resolved" | "cancelled" | "resume_failed";

export type HitlSource =
  | { type: "ask_user"; sessionId: string; toolCallId?: string }
  | { type: "tool_permission"; sessionId: string; toolCallId: string; toolName: string }
  | { type: "goal_approval"; goalId: string; approvalPoint: ApprovalPoint }
  | { type: "goal_review"; goalId: string }
  | { type: "goal_budget"; goalId: string; approvalPoint?: string }
  | { type: "goal_question"; goalId: string; questionKey: string }
  | { type: "loop_approval"; loopId: string; approvalPoint: string }
  | { type: "loop_blocker"; loopId: string; runId?: string; reason: string }
  | { type: "loop_retry"; loopId: string; runId: string; attempt: number }
  | { type: "loop_question"; loopId: string; questionKey: string };

export interface HitlDisplayPayload {
  title: string;
  summary?: string;
  fields?: Array<{ label: string; value: string }>;
  redacted: true;
}

export interface HitlResumeMetadata {
  claimedAt?: string;
  claimedBy?: string;
  failedAt?: string;
  failureReason?: string;
  attempts?: number;
}

export type HitlResponse =
  | { type: "question_answer"; answers: string[]; comment?: string; answeredBy?: string }
  | { type: "permission_decision"; decision: "approve_once" | "approve_always" | "deny"; comment?: string; decidedBy?: string }
  | { type: "approval_decision"; decision: "approved" | "denied"; comment?: string; decidedBy?: string }
  | { type: "review_outcome"; outcome: GoalReviewOutcome; comment?: string; report?: GoalReviewReport; reviewedBy?: string }
  | { type: "cancel"; reason: string; cancelledBy?: string };

export interface HitlRecord {
  hitlId: string;
  owner: HitlOwnerKey;
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
  | { kind: "on_commit"; branch?: string; cadenceMs?: number }
  | { kind: "on_pr"; branch?: string; baseBranch?: string; prScope?: LoopPullRequestScope; cadenceMs?: number }
  | { kind: "on_ci_fail"; branch?: string; baseBranch?: string; checkName?: string; workflowName?: string; cadenceMs?: number };

export interface LoopCoordinatorConfig {
  maxConcurrent: number;
}

export interface LoopProjectConfig {
  coordinator: LoopCoordinatorConfig;
}

export type LoopRunKind = "session" | "goal";

export type LoopMode = "report" | "act";

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

export type LoopLimits = LoopBudgetConfig | { maxIterationsPerRun: number };

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

export type LoopToolProfileId =
  | "loop_local_report"
  | "loop_local_maintenance"
  | "loop_github_pr_watch"
  | "loop_ci_watch"
  | "loop_goal_action";

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
  budget?: LoopBudgetConfig;
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
  title: string;
  author: string;
  doneConditions: DoneCondition[];
  retryPolicy: RetryPolicy;
  approvalPoints: ApprovalPoint[];
  reviewerAgent: string;
  prompt?: string;
  instructions?: string;
}

export interface LoopConfig {
  title: string;
  description?: string;
  schedule: LoopScheduleSpec;
  runKind: LoopRunKind;
  mode: LoopMode;
  approvalPolicy: LoopApprovalPolicy;
  limits: LoopLimits;
  budget?: LoopBudgetConfig;
  toolProfileId?: LoopToolProfileId;
  collisionTargets?: CollisionTarget[];
  taskPrompt?: string;
  instructions?: string;
  goalTemplate?: LoopGoalTemplate;
  sourcePreset?: string;
  triggers?: LoopTriggerSpec[];
  cleanupPolicy?: LoopCleanupPolicy;
}

export type LoopRunReportStatus = "running" | "succeeded" | "failed" | "skipped" | "cancelled" | "budget_exceeded" | "needs_user";

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
  enabled?: boolean;
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

export interface LoopJobSummary {
  jobId: string;
  loopId: string;
  status: LoopJobStatus;
  triggerKind: LoopRunTrigger;
  subjectKey: string;
  dedupeKey: string;
  branchKey?: string;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  attempts: number;
  rerunAfterCurrent?: boolean;
  blockedReason?: string;
  blockedByHitlIds?: string[];
  attentionStatus?: HitlAttentionStatus;
  worktreePath?: string;
  baseSha?: string;
  resolvedHeadSha?: string;
  missedCount?: number;
  cleanupState?: LoopCleanupState;
  observedArtifacts?: LoopWorktreeArtifact[];
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
  toolProfileId?: LoopToolProfileId;
  sessionId?: string;
  goalId?: string;
  summary?: string;
  error?: string;
  skippedReason?: string;
  jobId?: string;
  triggerKind?: LoopRunTrigger;
  subjectKey?: string;
  dedupeKey?: string;
  branchKey?: string;
  worktreePath?: string;
  baseSha?: string;
  resolvedHeadSha?: string;
  missedCount?: number;
  blockedReason?: string;
  blockedByHitlIds?: string[];
  attentionStatus?: HitlAttentionStatus;
  cleanupState?: LoopCleanupState;
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
  readinessScore?: null;
  latestBudget?: LoopBudgetSnapshot;
  latestCollisions?: LoopCollisionSnapshot;
  latestIntegrations?: LoopIntegrationSnapshot;
  currentJob?: LoopJobSummary;
  queuedJobs?: LoopJobSummary[];
  blockedByHitlIds?: string[];
  attentionStatus?: HitlAttentionStatus;
  triggerHealth?: LoopTriggerHealth[];
  cleanupState?: LoopCleanupState;
}

// ─── Loop Stream Events ───

export type LoopStreamEvent =
  | { type: "loop.state_change"; loopId: string; status: LoopStatus; state: LoopState }
  | { type: "loop.run_appended"; loopId: string; report: LoopRunReport };

export interface CommandResult {
  success: boolean;
  message: string;
}

export type PermissionDecision = "approve_once" | "approve_always" | "deny";

export type QuestionAnswerBody =
  | { answers: string[][] }
  | { isError: true; reason: string };
