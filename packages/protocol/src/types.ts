export interface ExecutionStartEvent {
  type: "execution-start";
  executionId?: string;
}

export interface ExecutionEndEvent {
  type: "execution-end";
  status: "completed" | "max_steps" | "failed" | "aborted" | "cancelled" | "timed_out" | "interrupted";
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
  | GoalStreamEvent
  | HitlStreamEvent;

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
  /** Pending HITL requests. Append-only via hitl.request, updated via hitl.resolved. */
  hitlRequests?: HitlRequest[];
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
  childSessionIds: string[];  // plan/build/review/explore/librarian
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
// 3 kinds: question (with options) / approval (tool gate) / review (bulk artifact review)
// No separate "decision" kind: structurally same as question, semantic difference at prompt layer

export type HitlKind = "question" | "approval" | "review";

export type HitlTrigger = "approval_point" | "agent_request";

export type HitlStatus = "pending" | "resolved" | "cancelled" | "timeout";

export interface HitlDisplayPayload {
  title: string;
  summary?: string;
  fields?: Array<{ label: string; value: string }>;
  redacted: true;
}

export interface HitlRequest {
  id: string;
  sessionId: string;   // originating session
  goalId?: string;
  loopId?: string;     // Phase 2: loop integration
  kind: HitlKind;
  prompt: string;
  payload: HitlPayload;  // kind-specific
  displayPayload?: HitlDisplayPayload;
  trigger: HitlTrigger;  // hard constraint vs soft request
  decisionKey?: string;
  status: HitlStatus;
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  response?: HitlResponse;
}

export type HitlPayload =
  // question: may have no options (free text) or options (structured choice). When options exist, may include recommendedOption + rationale.
  | { kind: "question"; options?: Array<{ label: string; description?: string }>; multiple?: boolean; custom?: boolean; recommendedOption?: string; rationale?: string }
  // approval: permission module needs human review. HITL presents yes/no and returns decision.
  // deny → tool not executed; approve_always → persisted — these are permission module's responsibility, not HITL.
  | { kind: "approval"; action: string; context: Record<string, unknown> }
  // review: architect batch-review of artifacts. Verdict drives Goal state machine.
  | { kind: "review"; artifacts: GoalArtifactFile[] };

export type HitlResponse =
  // question: answer flows back into conversation context. No options → free text; with options → selected label(s).
  | { kind: "question"; answers: string[]; comment?: string }
  // approval: user decision. HITL returns approved/approveAlways/comment;
  // permission module decides based on this value whether to allow/deny/persist scope.
  | { kind: "approval"; approved: boolean; approveAlways?: boolean; comment?: string }
  // review: DONE completes the Goal; NOT_DONE drives retry/escalation.
  | { kind: "review"; outcome: GoalReviewOutcome; comment?: string; report?: GoalReviewReport };

export interface HitlRecord {
  id: string;
  projectId: string;
  sessionId: string;
  goalId?: string;
  loopId?: string;
  kind: HitlKind;
  trigger: HitlTrigger;
  decisionKey: string;
  status: HitlStatus;
  prompt: string;
  displayPayload: HitlDisplayPayload;
  payload: HitlPayload;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  response?: HitlResponse;
}

// ─── HITL Stream Events ───

export type HitlStreamEvent =
  | { type: "hitl.request"; request: HitlRequest }
  | { type: "hitl.resolved"; hitlId: string; status: Extract<HitlStatus, "resolved" | "cancelled" | "timeout">; response?: HitlResponse };

export interface CommandResult {
  success: boolean;
  message: string;
}

export type PermissionDecision = "approve_once" | "approve_always" | "deny";

export type QuestionAnswerBody =
  | { answers: string[][] }
  | { isError: true; reason: string };
