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
  | ToolResultEvent
  | ToolChildSessionLinkEvent
  | TodoWriteEvent
  | ReminderEvent
  | ReminderConsumedEvent
  | StepStartEvent
  | StepEndEvent
  | LoopErrorEvent
  | CompactEvent;

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

export type GlobalSSEEvent =
  | GlobalSessionEventEnvelope
  | GlobalSSEHeartbeatEvent
  | GlobalSSEResetEvent
  | GlobalSSELaggedEvent
  | GlobalSSEShutdownEvent;

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

export interface QuestionTerminalEvent {
  type: "question.terminal";
  questionId: string;
  status: "resolved" | "denied" | "timeout" | "cancelled";
  answer?: string;
}

export interface WorkflowStateChangeEvent {
  type: "workflow.state_change";
  workflowId: string;
  changed: Array<"stage" | "status" | "artifacts" | "stageCompletions" | "sessionIds" | "derivedFrom" | "derivedWorkflows">;
  updatedAt: string;
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
  | WorkflowStateChangeEvent
  | ShutdownEvent;

export interface TextPart {
  type: "text";
  id: string;
  text: string;
  createdAt: number;
  completedAt?: number;
}

export interface ReasoningPart {
  type: "reasoning";
  id: string;
  text: string;
  createdAt: number;
  completedAt?: number;
}

export interface PendingToolPart {
  type: "tool";
  id: string;
  state: "pending";
  toolCallId: string;
  toolName: string;
  createdAt: number;
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
  meta?: Record<string, unknown>;
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

export type SessionPart = TextPart | ReasoningPart | ToolPart | CompactionPart | SystemNoticePart;

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

export interface SessionProjection {
  sessionId: string;
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
  isRunning: boolean;
  isStreamingModel: boolean;
  currentExecutionId?: string;
  currentAssistantMessageId?: string;
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
  title?: string | null;
  workflowId?: string;
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
  workflowId?: string;
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
  parentSessionId?: string;
  eventCursor?: number;
}

export interface WorkflowState {
  id: string;
  type: "research_only" | "quick_fix" | "full_feature" | string;
  stage: string;
  status: "active" | "paused" | "completed" | "failed" | string;
  sessionIds: Record<string, string>;
  artifacts?: Record<string, string | string[] | undefined>;
  stageCompletions?: Record<string, {
    stage: string;
    completedAt: string;
    criticPassed?: boolean;
    evidence?: string[];
  }>;
  derivedFrom?: {
    workflowId: string;
    reason: "upgrade" | "branch" | string;
    handoffSummaryId?: string;
    triggeredAt: string;
    triggerMessageId?: string;
  };
  derivedWorkflows?: Array<{
    workflowId: string;
    reason: "upgrade" | "branch" | string;
    createdAt: string;
  }>;
  createdAt?: string;
  updatedAt?: string;
  retryCount?: number;
  maxRetries?: number;
  lastError?: string;
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

export interface CommandResult {
  success: boolean;
  message: string;
}

export type PermissionDecision = "approve_once" | "approve_always" | "deny";

export type QuestionAnswerBody =
  | { answers: string[][] }
  | { isError: true; reason: string };
