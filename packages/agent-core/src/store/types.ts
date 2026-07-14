import type { ModelMessage } from "ai";
import type {
  SessionMessage,
  SessionModelInfo,
  SessionStep,
  SessionTodo,
  Reminder,
  SessionEventEnvelope,
  SessionEventPayload,
  SessionStats,
  SessionExecutionRecord,
  ToolChildSessionLink,
  HitlDisplayPayload,
  HitlSource,
} from "@archcode/protocol";
import type { CompressionState } from "../compression";
import type { AgentName } from "../agents/names";

export type {
  StreamEvent,
  ExecutionStartEvent,
  ExecutionEndEvent,
  UserMessageEvent,
  SystemNoticeEvent,
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ReasoningStartEvent,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  ToolInputStartEvent,
  ToolCallEvent,
  ToolInputResolvedEvent,
  ToolAttemptEvent,
  ToolResultEvent,
  ToolChildSessionLink,
  ToolChildSessionLinkEvent,
  ToolChildSessionLinkStatus,
  CompactEvent,
  TodoWriteEvent,
  ReminderEvent,
  ReminderConsumedEvent,
  StepStartEvent,
  StepEndEvent,
  ExecutionErrorEvent,
  LlmRetryEvent,
  LlmRecoveryEvent,
  LlmRecoveryFailedEvent,
  TextPart,
  ReasoningPart,
  PendingToolPart,
  RunningToolPart,
  CompletedToolPart,
  ErrorToolPart,
  ToolPart,
  CompactionPart,
  SystemNoticePart,
  RecoveryNoticePart,
  SessionPart,
  SessionMessage,
  SessionStep,
  SessionTodo,
  SessionTodoStatus,
  SessionProjection,
  SessionEventEnvelope,
  SessionEventPayload,
  ShutdownEvent,
  Reminder,
  ReminderSource,
  SessionPart as StoredPart,
  SessionMessage as StoredMessage,
  SessionModelInfo,
  SessionStep as StepInfo,
  SessionTodo as StoredTodo,
  SessionTodoStatus as StoredTodoStatus,
} from "@archcode/protocol";
export { MAX_EVENTS } from "@archcode/protocol";

export type SessionRole = "main" | "plan" | "build" | "review" | "explore" | "librarian" | "standalone";

export type SessionToolCallState =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "manual_inspection_required";

export interface SessionToolCallResult {
  readonly output: string;
  readonly isError: boolean;
  readonly meta?: Record<string, unknown>;
}

export interface SessionToolCallBlocker {
  readonly requestKey: string;
  readonly hitlId?: string;
  readonly source: Extract<HitlSource, { type: "ask_user" | "tool_permission" }>;
  readonly displayPayload: HitlDisplayPayload;
  readonly permission?: {
    readonly description: string;
    readonly reason?: string;
    readonly approval?: unknown;
    readonly decisionDisplay?: string;
    readonly ruleId?: string;
  };
  readonly responseAppliedAt?: string;
  readonly permissionDecision?: "approve_once" | "approve_always" | "deny";
}

export interface SessionToolBatchCall {
  readonly ordinal: number;
  readonly partitionIndex: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly traits: {
    readonly readOnly: boolean;
    readonly destructive: boolean;
    readonly concurrencySafe: boolean;
  };
  readonly state: SessionToolCallState;
  readonly attempt: number;
  readonly result?: SessionToolCallResult;
  readonly blocker?: SessionToolCallBlocker;
  readonly recoveryFailure?: string;
}

export interface SessionToolBatchPartition {
  readonly type: "parallel" | "serial";
  readonly callIds: string[];
}

/** Canonical durable checkpoint for one model-produced tool-call batch. */
export interface SessionToolBatch {
  readonly batchId: string;
  readonly executionId: string;
  readonly assistantMessageId?: string;
  readonly step: number;
  readonly agentName: AgentName;
  readonly allowedTools: string[];
  readonly agentSkills: string[];
  readonly currentDepth?: number;
  readonly partitions: SessionToolBatchPartition[];
  readonly calls: SessionToolBatchCall[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly continuationStartedAt?: string;
  readonly continuationCompletedAt?: string;
  readonly archivedAt?: string;
  readonly manualInspectionReason?: string;
}

export interface SessionStoreState {
  sessionId: string;
  createdAt: number;
  updatedAt: number;

  // Persistent layer
  /** Current execution directory. Session files remain owned by the canonical project root. */
  cwd: string;
  agentName: AgentName;
  modelInfo: SessionModelInfo | null;
  title: string | null;
  messages: SessionMessage[];
  steps: SessionStep[];
  stats: SessionStats;
  executions: SessionExecutionRecord[];
  compression: CompressionState;

  // Session-only state
  todos: SessionTodo[];
  reminders: Reminder[];
  childSessionLinks: ToolChildSessionLink[];
  /** Complete tool-batch audit history; at most one entry may be active (no archivedAt). */
  toolBatches: SessionToolBatch[];
  // Identity is assigned at creation/load and treated as immutable afterwards.
  // Descendant relationships are derived from child files, not parent-side caches.
  rootSessionId: string;
  parentSessionId?: string;
  goalId?: string;
  sessionRole?: SessionRole;

  // Running state
  executionCount: number;
  isRunning: boolean;
  isStreamingModel: boolean;
  currentExecutionId?: string;
  currentAssistantMessageId?: string;

  // Todo continuation tracking (persistent across loops)
  lastTodoWriteStepIndex: number | null;
  lastTodoReminderStepIndex: number | null;
  todoStepReminderCount: number;
  todoLoopContinuationCount: number;
  todoContinuationStagnationCount: number;
  lastTodoContinuationPendingCount: number | null;

  // Memory extraction cursor tracking
  lastExtractionIndex: number;
  lastExtractionTime: number;

  readSnapshots: Map<string, number>;

  // Unified event log (transient)
  events: SessionEventEnvelope[];
  eventOffset: number;
  nextEventId: number;

  // Methods
  append: (event: SessionEventPayload) => void;
  setCwd: (cwd: string) => void;
  setTitle: (title: string | null) => void;
  setParentSessionId: (parentSessionId: string | undefined) => void;
  setGoalId: (goalId: string | undefined) => void;
  setSessionRole: (sessionRole: SessionRole | undefined) => void;
  toModelMessages: () => ModelMessage[];
}

export class BusyError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" is already running`);
    this.name = "BusyError";
  }
}

export class InvalidTodoStateError extends Error {
  constructor(public readonly reason: string) {
    super(`Invalid todo state: ${reason}`);
    this.name = "InvalidTodoStateError";
  }
}
