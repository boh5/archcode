import type { ModelMessage } from "ai";
import type {
  SessionMessage,
  SessionStep,
  SessionTodo,
  Reminder,
  SessionEventEnvelope,
  SessionEventPayload,
  SessionStats,
  SessionRun,
} from "@specra/protocol";

export type {
  StreamEvent,
  RunStartEvent,
  RunEndEvent,
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
  ToolResultEvent,
  CompactEvent,
  TodoWriteEvent,
  ReminderEvent,
  ReminderConsumedEvent,
  StepStartEvent,
  StepEndEvent,
  LoopErrorEvent,
  TextPart,
  ReasoningPart,
  PendingToolPart,
  RunningToolPart,
  CompletedToolPart,
  ErrorToolPart,
  ToolPart,
  CompactionPart,
  SystemNoticePart,
  SessionPart,
  SessionMessage,
  SessionStep,
  SessionTodo,
  SessionTodoStatus,
  SessionProjection,
  SessionEventEnvelope,
  SessionEventPayload,
  PermissionRequestEvent,
  PermissionTerminalEvent,
  QuestionRequestEvent,
  QuestionTerminalEvent,
  ShutdownEvent,
  Reminder,
  ReminderSource,
  SessionPart as StoredPart,
  SessionMessage as StoredMessage,
  SessionStep as StepInfo,
  SessionTodo as StoredTodo,
  SessionTodoStatus as StoredTodoStatus,
} from "@specra/protocol";
export { MAX_EVENTS } from "@specra/protocol";

export interface SessionStoreState {
  sessionId: string;
  createdAt: number;

  // Persistent layer
  title: string | null;
  messages: SessionMessage[];
  steps: SessionStep[];
  stats: SessionStats;
  runs: SessionRun[];

  // Session-only state
  todos: SessionTodo[];
  reminders: Reminder[];
  // Identity is assigned at creation/load and treated as immutable afterwards.
  // Descendant relationships are derived from child files, not parent-side caches.
  rootSessionId: string;
  parentSessionId?: string;

  // Running state
  runCount: number;
  isRunning: boolean;
  isStreamingModel: boolean;
  currentRunId?: string;
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
  setTitle: (title: string | null) => void;
  setParentSessionId: (parentSessionId: string | undefined) => void;
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
