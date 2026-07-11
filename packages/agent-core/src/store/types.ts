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
  SessionHitlCheckpoint,
  ToolChildSessionLink,
} from "@archcode/protocol";
import type { CompressionState } from "../compression";

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
  LoopErrorEvent,
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
  SessionHitlCheckpoint,
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

export interface SessionStoreState {
  sessionId: string;
  createdAt: number;
  updatedAt: number;

  // Persistent layer
  /** Current execution directory. Session files remain owned by the canonical project root. */
  cwd: string;
  agentName: string;
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
  // Identity is assigned at creation/load and treated as immutable afterwards.
  // Descendant relationships are derived from child files, not parent-side caches.
  rootSessionId: string;
  parentSessionId?: string;
  goalId?: string;
  loopId?: string;
  sessionRole?: SessionRole;
  blockedHitl?: SessionHitlCheckpoint;
  blockedByHitlIds?: string[];

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
  setLoopId: (loopId: string | undefined) => void;
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
