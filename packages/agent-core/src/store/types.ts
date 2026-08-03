import type { ModelMessage } from "ai";
import type {
  SessionMessage,
  SessionModelSelection,
  SessionStep,
  SessionTodo,
  Reminder,
  SessionEventEnvelope,
  SessionEventPayload,
  SessionStats,
  SessionExecutionRecord,
  PendingSessionMessage,
  SessionInputReceipt,
  ToolChildSessionLink,
  DelegationRequest,
  PromptTraceSnapshot,
  FinalizedToolResult,
  SessionGoal,
  RootSessionSource,
} from "@archcode/protocol";
import type { CompressionState } from "../compression";
import type { AgentName } from "../agents/names";
import type { PersistedSessionToolCallBlocker } from "../hitl/boundary-codec";
import type { ModelMessagesProjection } from "./projection";

export type {
  StreamEvent,
  ExecutionStartEvent,
  ExecutionSuspendedEvent,
  ExecutionSuspensionUpdatedEvent,
  ExecutionResumedEvent,
  ExecutionEndEvent,
  SessionMessageAcceptedEvent,
  SessionMessageEditedEvent,
  SessionMessageDeletedEvent,
  SessionMessageSteerClaimedEvent,
  SessionMessageSteerRolledBackEvent,
  SessionMessagesCommittedEvent,
  ExecutionStopRequestedEvent,
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
  ToolOutputDeltaEvent,
  ToolResultEvent,
  FinalizedToolResult,
  ToolOutput,
  ToolResultDetails,
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
  PromptTraceEvent,
  LlmRetryEvent,
  LlmRecoveryEvent,
  LlmRecoveryFailedEvent,
  TextPart,
  ReasoningPart,
  PendingToolPart,
  RunningToolPart,
  ToolLiveOutput,
  InterruptedToolPart,
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
  PendingSessionMessage,
  SessionInputReceipt,
  SessionMessageSource,
  SessionProjection,
  SessionEventEnvelope,
  SessionEventPayload,
  ShutdownEvent,
  Reminder,
  ReminderSource,
  SessionPart as StoredPart,
  SessionMessage as StoredMessage,
  SessionModelSelection,
  SessionStep as StepInfo,
  SessionTodo as StoredTodo,
  SessionTodoStatus as StoredTodoStatus,
} from "@archcode/protocol";
export { MAX_EVENTS } from "@archcode/protocol";

export type SessionToolCallState =
  | "queued"
  | "running"
  | "blocked"
  | "child_launch"
  | "child_dependency"
  | "completed"
  | "failed"
  | "manual_inspection_required";

export type SessionToolCallBlocker = PersistedSessionToolCallBlocker;

export interface SessionToolChildTerminalOutcome {
  readonly executionStatus:
    | "completed"
    | "max_steps"
    | "failed"
    | "aborted"
    | "cancelled"
    | "timed_out"
    | "interrupted";
  readonly output?: string;
  readonly terminalError?: string;
  readonly resolvedAt: number;
}

interface SessionToolChildCorrelation {
  readonly parentExecutionId: string;
  readonly runOrdinal: number;
  readonly toolCallId: string;
  readonly childSessionId: string;
  readonly childExecutionId: string;
  readonly createdAt: number;
}

export type SessionToolChildDependency =
  | (SessionToolChildCorrelation & {
      readonly kind: "child_launch";
    })
  | (SessionToolChildCorrelation & {
      readonly kind: "child_dependency";
      readonly dependencyStartedAt: number;
      readonly outcome?: SessionToolChildTerminalOutcome;
    });

export type SessionToolRecoveryFailure =
  | { readonly kind: "read_retry_exhausted" }
  | { readonly kind: "effectful_outcome_unknown" }
  | { readonly kind: "effectful_cancelled_unknown" };

export type SessionToolManualInspectionReason =
  {
      readonly kind: "effectful_outcome_unknown" | "effectful_cancelled_unknown";
      readonly toolCallId: string;
      readonly toolName: string;
    };

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
  /** Canonical time of the latest execution-relevant call state transition. Metadata-only repair preserves it. */
  readonly checkpointAt: number;
  readonly result?: FinalizedToolResult;
  /** Required exactly when result is present; shared with the terminal tool-result event. */
  readonly settledAt?: number;
  /** Durable marker that this successful call ended its owning Execution. */
  readonly executionCompleted?: true;
  readonly blocker?: SessionToolCallBlocker;
  readonly childDependency?: SessionToolChildDependency;
  readonly recoveryFailure?: SessionToolRecoveryFailure;
}

export interface SessionToolBatchPartition {
  readonly type: "parallel" | "serial";
  readonly callIds: string[];
}

/** Canonical durable checkpoint for one model-produced tool-call batch. */
export interface SessionToolBatch {
  readonly batchId: string;
  readonly executionId: string;
  readonly stepId: string;
  readonly assistantMessageId: string;
  readonly step: number;
  readonly runOrdinal: number;
  readonly agentName: AgentName;
  readonly allowedTools: string[];
  readonly agentSkills: string[];
  readonly partitions: SessionToolBatchPartition[];
  readonly calls: SessionToolBatchCall[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly manualInspectionReason?: SessionToolManualInspectionReason;
}

export interface SessionStoreState {
  sessionId: string;
  createdAt: number;
  updatedAt: number;

  // Persistent layer
  /** Current execution directory. Session files remain owned by the canonical project root. */
  cwd: string;
  agentName: AgentName;
  /** Canonical Skill identity. Resolved afresh for each execution. */
  activeSkillNames: string[];
  modelSelection: SessionModelSelection;
  title: string | null;
  messages: SessionMessage[];
  pendingMessages: PendingSessionMessage[];
  /** Stop cutoff used only when no active root Execution exists; never a paused/held mode. */
  queueDispatchBarrierAt?: number;
  /** Internal durable idempotency index for messages and commands; excluded from public Session DTOs. */
  inputRequestReceipts: SessionInputReceipt[];
  steps: SessionStep[];
  stats: SessionStats;
  executions: SessionExecutionRecord[];
  /** Durable audit records for every model-call Prompt compilation. */
  promptTraces: PromptTraceSnapshot[];
  compression: CompressionState;

  // Session-only state
  todos: SessionTodo[];
  reminders: Reminder[];
  childSessionLinks: ToolChildSessionLink[];
  /** Immutable parent-to-child handoff. Required for every child Session. */
  delegationRequest?: DelegationRequest;
  /** Complete tool-batch audit history; at most one entry may be active (no archivedAt). */
  toolBatches: SessionToolBatch[];
  // Identity is assigned at creation/load and treated as immutable afterwards.
  // Descendant relationships are derived from child files, not parent-side caches.
  rootSessionId: string;
  parentSessionId?: string;
  /** Only ordinary root Lead Sessions may own a Goal. */
  goal?: SessionGoal;
  /** Required for user-facing roots and absent for delegated children. */
  source?: RootSessionSource;

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
  /** Exclusive event cursor that subscribers may observe. Never exceeds nextEventId. */
  publishableNextEventId: number;

  // Methods
  append: (event: SessionEventPayload) => void;
  setCwd: (cwd: string) => void;
  setTitle: (title: string | null) => void;
  setParentSessionId: (parentSessionId: string | undefined) => void;
  toModelMessagesProjection: () => ModelMessagesProjection;
  toModelMessages: () => ModelMessage[];
}

export class BusyError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" is already running`);
    this.name = "BusyError";
  }
}

export class InvalidExecutionTransitionError extends Error {
  constructor(public readonly reason: string) {
    super(`Invalid Execution transition: ${reason}`);
    this.name = "InvalidExecutionTransitionError";
  }
}

export class InvalidTodoStateError extends Error {
  constructor(public readonly reason: string) {
    super(`Invalid todo state: ${reason}`);
    this.name = "InvalidTodoStateError";
  }
}
