import type { ModelMessage } from "ai";

export interface RunStartEvent {
  type: "run-start";
  runId?: string;
}

export interface RunEndEvent {
  type: "run-end";
  status: "completed" | "max_steps" | "failed" | "aborted" | "cancelled" | "timed_out";
  error?: string;
}

export type ReminderSource =
  | {
      type: "todo_step_reminder";
      pendingTodos: StoredTodo[];
    }
  | {
      type: "todo_loop_continuation";
      pendingTodos: StoredTodo[];
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

export interface ToolResultEvent {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
  meta?: Record<string, unknown>;
}

export interface CompactEvent {
  type: "compact";
  summary: string;
  tailStartId: string;
}

export interface TodoWriteEvent {
  type: "todo-write";
  todos: StoredTodo[];
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
  | RunStartEvent
  | RunEndEvent
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
  | ToolResultEvent
  | TodoWriteEvent
  | ReminderEvent
  | ReminderConsumedEvent
  | StepStartEvent
  | StepEndEvent
  | LoopErrorEvent
  | CompactEvent;

export type StoredTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface StoredTodo {
  id: string;
  content: string;
  status: StoredTodoStatus;
  createdAt?: number;
  updatedAt?: number;
}

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

export type ToolPart =
  | PendingToolPart
  | RunningToolPart
  | CompletedToolPart
  | ErrorToolPart;

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

export type StoredPart = TextPart | ReasoningPart | ToolPart | CompactionPart | SystemNoticePart;

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  parts: StoredPart[];
  createdAt: number;
  completedAt?: number;
  runId?: string;
  compacted?: boolean;
}

export interface StepInfo {
  id: string;
  step: number;
  runId?: string;
  startedAt: number;
  completedAt?: number;
  finishReason?: string;
  usage?: unknown;
  error?: string;
}

export interface StreamingTextState {
  messageId: string;
  partId: string;
  text: string;
}

export interface StreamingReasoningState {
  messageId: string;
  partId: string;
  text: string;
}

export interface StreamingToolState {
  messageId: string;
  partId: string;
  toolCallId: string;
  toolName: string;
  input?: unknown;
}

export interface SessionStoreState {
  sessionId: string;
  createdAt: number;

  // Persistent layer
  title: string | null;
  messages: StoredMessage[];
  steps: StepInfo[];

  // Session-only state
  todos: StoredTodo[];
  reminders: Reminder[];
  childSessionIds: Set<string>;
  parentSessionId?: string;
  subAgentDescriptions: Map<string, string>;

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

  // Temporary streaming layer
  streamingText?: StreamingTextState;
  streamingReasoning?: StreamingReasoningState;
  streamingTools: Record<string, StreamingToolState>;

  readSnapshots: Map<string, number>;

  // Methods
  append: (event: StreamEvent) => void;
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
