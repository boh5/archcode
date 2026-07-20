import type { DelegationRequest } from "./delegation";
import type { SessionGoal, SessionGoalChangedEvent } from "./session-goal";
import type {
  ExecutionModelBindingSummary,
  GlobalSSEModelRuntimeChangedEvent,
  MessageModelAudit,
  RequestedModelSelection,
  SessionNextModelSelection,
  SessionModelSelection,
} from "./model-runtime";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface ExecutionStartEvent {
  type: "execution-start";
  executionId: string;
  binding: ExecutionModelBindingSummary;
  origin: SessionExecutionOrigin;
}

export type SessionExecutionOrigin =
  | "user_message"
  | "tool_call"
  | "tool_batch"
  | "goal_continuation";

export interface ExecutionEndEvent {
  type: "execution-end";
  status: "completed" | "max_steps" | "failed" | "aborted" | "cancelled" | "timed_out" | "interrupted" | "waiting_for_human";
  error?: string;
  blockedByHitlIds?: string[];
  blockedToolCallId?: string;
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
  /** User-requested Stop fact for this execution. This is not a Session pause state. */
  stopRequestedAt?: number;
  binding: ExecutionModelBindingSummary;
  origin: SessionExecutionOrigin;
}

export type SessionMessageSource = "user" | "automation";

export interface PendingSessionMessage {
  id: string;
  clientRequestId: string;
  content: string;
  source: SessionMessageSource;
  state: "queued" | "steering";
  revision: number;
  acceptedAt: number;
  updatedAt: number;
  targetExecutionId?: string;
  requestedModelSelection: RequestedModelSelection;
}

export interface SessionMessageInputReceipt {
  kind: "message";
  clientRequestId: string;
  messageId: string;
  requestFingerprint: string;
  status: "pending" | "canonical" | "deleted";
  requestedModelSelection: RequestedModelSelection;
}

export interface SessionCommandInputReceipt {
  kind: "command";
  clientRequestId: string;
  requestFingerprint: string;
  status: "executing" | "completed" | "failed" | "indeterminate";
  error?: string;
  requestedModelSelection: RequestedModelSelection;
}

/** Durable idempotency index for every client-submitted Session input. */
export type SessionInputReceipt = SessionMessageInputReceipt | SessionCommandInputReceipt;

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

export interface SessionMessageAcceptedEvent {
  type: "session.message_accepted";
  message: PendingSessionMessage;
}

export interface SessionModelSelectionChangedEvent {
  type: "session.model_selection_changed";
  modelSelection: SessionModelSelection;
}

export interface SessionMessageEditedEvent {
  type: "session.message_edited";
  message: PendingSessionMessage;
}

export interface SessionMessageDeletedEvent {
  type: "session.message_deleted";
  messageId: string;
  clientRequestId: string;
  revision: number;
  deletedAt: number;
}

export interface SessionMessageSteerClaimedEvent {
  type: "session.message_steer_claimed";
  message: PendingSessionMessage;
}

export interface SessionMessageSteerRolledBackEvent {
  type: "session.message_steer_rolled_back";
  message: PendingSessionMessage;
}

export interface SessionMessagesCommittedEvent {
  type: "session.messages_committed";
  executionId: string;
  messages: SessionMessage[];
}

export interface ExecutionStopRequestedEvent {
  type: "execution-stop-requested";
  executionId: string;
  timestamp: number;
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

export interface ToolOutputCount {
  bytes: number;
  lines: number;
}

export type ToolOutputRecovery =
  | { kind: "none" }
  | { kind: "source"; toolName: string; nextInput: JsonObject }
  | {
      kind: "artifact";
      outputRef: string;
      expiresAt: number;
      canRead: true;
      canSearch: true;
    };

export interface ToolOutput {
  preview: string;
  completeness: "complete" | "partial";
  observed: ToolOutputCount;
  canonical: ToolOutputCount;
  stored: ToolOutputCount;
  omitted: ToolOutputCount;
  recovery: ToolOutputRecovery;
}

export interface ToolResultErrorDetails {
  kind: string;
  code: string;
  name: string;
  hint?: string;
}

export interface ToolProcessDetails {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface ToolDiffPresentation {
  kind: "diff";
  files: DiffFile[];
  truncated?: true;
}

export interface ToolAskUserAnswerPresentation {
  question: string;
  answers: string[];
}

export interface ToolAskUserPresentation {
  kind: "ask_user";
  answers: ToolAskUserAnswerPresentation[];
  truncated?: true;
}

export type ToolResultPresentation = ToolDiffPresentation | ToolAskUserPresentation;

export interface ToolResultDetails {
  error?: ToolResultErrorDetails;
  process?: ToolProcessDetails;
  unknownResult?: true;
  presentations?: ToolResultPresentation[];
}

export interface FinalizedToolResult {
  isError: boolean;
  output: ToolOutput;
  details?: ToolResultDetails;
}

export interface ToolResultEvent {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: FinalizedToolResult;
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
  title: string;
  /** Display-only projection derived from the child's persisted parent chain. */
  depth: number;
  background: boolean;
  status: ToolChildSessionLinkStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
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

/** An error raised by the generic LLM query loop, not a product Automation. */
export interface ExecutionErrorEvent {
  type: "execution-error";
  step?: number;
  error: string;
}

export type PromptSourceStatus = "present" | "absent" | "error";
export type PromptMcpStatus = "pending" | "ready" | "ready-zero" | "partial-warning" | "failed";

export interface PromptTraceSectionSnapshot {
  name: string;
  source: string;
  hash: string;
}

/** Durable audit record for the exact system Prompt used by one model call. */
export interface PromptTraceSnapshot {
  version: "2";
  status: "compiled" | "error";
  hash: string;
  sections: PromptTraceSectionSnapshot[];
  skills: {
    status: "present" | "absent" | "error";
    active: { name: string; source: string }[];
  };
  visibleTools: string[];
  agentsMd: PromptSourceStatus;
  memory: PromptSourceStatus;
  mcp: Record<string, PromptMcpStatus>;
  warnings: string[];
}

export interface PromptTraceEvent {
  type: "prompt-trace";
  trace: PromptTraceSnapshot;
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
  | SessionModelSelectionChangedEvent
  | SessionMessageAcceptedEvent
  | SessionMessageEditedEvent
  | SessionMessageDeletedEvent
  | SessionMessageSteerClaimedEvent
  | SessionMessageSteerRolledBackEvent
  | SessionMessagesCommittedEvent
  | ExecutionStopRequestedEvent
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
  | ExecutionErrorEvent
  | PromptTraceEvent
  | LlmRetryEvent
  | LlmRecoveryEvent
  | LlmRecoveryFailedEvent
  | CompactEvent
  | CompressionStreamEvent;

export const MAX_EVENTS = 10000;

export interface SessionEventEnvelope<P extends SessionEventPayload = SessionEventPayload> {
  id: number;
  createdAt: number;
  payload: P;
}

// Global SSE wire protocol events.
export interface GlobalSessionEventEnvelope<P extends SessionEventPayload = SessionEventPayload> {
  type: "event";
  slug: string;
  sessionId: string;
  eventId: number;
  createdAt: number;
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

/** A secret exists on disk but is never returned through the Settings API. */
export interface ConfiguredSecretView {
  configured: true;
}

export const BUILTIN_MCP_SERVER_NAMES = ["context7", "grep.app", "exa"] as const;
export type BuiltinMcpServerName = typeof BUILTIN_MCP_SERVER_NAMES[number];

/** Explicit secret mutation accepted by PUT /api/config. */
export type ConfigSecretMutation =
  | { action: "preserve" }
  | { action: "replace"; value: string }
  | { action: "delete" };

/** JSON values accepted in generic provider and provider-call option trees. */
export type ConfigJsonValue =
  | string
  | number
  | boolean
  | null
  | ConfigJsonValue[]
  | { [key: string]: ConfigJsonValue };

export type ConfigProviderOptions<Secret> = {
  [key: string]: ConfigJsonValue | Secret | ConfigProviderOptions<Secret>;
};

export interface ConfigModelCallOptions {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
  timeout?: number;
  providerOptions?: Record<string, ConfigJsonValue>;
}

export interface ConfigModelSettings {
  name: string;
  limit: { context: number; output: number };
  modalities: { input: Array<"text" | "image" | "audio" | "video">; output: Array<"text" | "image" | "audio" | "video"> };
  options?: ConfigModelCallOptions;
  variants?: Record<string, ConfigModelCallOptions>;
}

export interface ConfigProviderSettings<Secret> {
  npm: string;
  name: string;
  options: ConfigProviderOptions<Secret>;
  models: Record<string, ConfigModelSettings>;
}

export interface ConfigAgentSettings {
  model: string;
  variant?: string;
  options?: ConfigModelCallOptions;
}

export interface ConfigMcpServerSettings<Secret> {
  url: string;
  headers?: Record<string, Secret>;
  timeout?: number;
}

export interface ConfigMemorySettings {
  enabled?: boolean;
  minMessages?: number;
  minContentLength?: number;
  cooldownMs?: number;
}

export interface ConfigGithubIntegrationSettings {
  enabled?: boolean;
  tokenEnv?: string;
  defaultOwner?: string;
  defaultRepo?: string;
}

/** The complete safe-to-edit representation of ~/.archcode/config.json. */
export interface ServerConfigDocument<Secret> {
  provider: Record<string, ConfigProviderSettings<Secret>>;
  agents: {
    engineer: ConfigAgentSettings;
    plan: ConfigAgentSettings;
    build: ConfigAgentSettings;
    reviewer: ConfigAgentSettings;
    explore: ConfigAgentSettings;
    librarian: ConfigAgentSettings;
    shaper: ConfigAgentSettings;
  };
  mcp?: { servers: Record<string, ConfigMcpServerSettings<Secret>> };
  integrations?: { github?: ConfigGithubIntegrationSettings };
  memory?: ConfigMemorySettings;
}

/** Safe configuration returned by GET /api/config. */
export type ServerConfigEditableView = ServerConfigDocument<ConfiguredSecretView>;

/** Complete configuration mutation accepted by PUT /api/config. */
export type ServerConfigUpdate = ServerConfigDocument<ConfigSecretMutation>;

export interface ServerConfigSnapshot {
  config: ServerConfigEditableView;
  revision: string;
  modelRuntimeRevision: string;
  configPath: string;
  restartRequiredSections: Array<"mcp" | "memory" | "integrations.github">;
}

export interface UpdateServerConfigRequest {
  expectedRevision: string;
  config: ServerConfigUpdate;
}

export type UpdateServerConfigResponse = ServerConfigSnapshot;

export interface ServerConfigValidationIssue {
  path: string;
  message: string;
}

export type McpServerStatus =
  | { state: "pending" }
  | { state: "ready"; toolCount: number; warningCount: number }
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
  /** Present only while the current root Execution accepts Steer. */
  steerTargetExecutionId?: string;
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
  /** Complete active HITL view set for the listed projects. */
  entries: Array<{ projectSlug: string; view: HitlView }>;
  createdAt: number;
}

export type GlobalSSEHitlEventPayload =
  | { type: "hitl.request" }
  | { type: "hitl.updated" }
  | { type: "hitl.resolved" };

export interface GlobalSSEHitlRealtimeEvent {
  type: "hitl.event";
  projectSlug: string;
  hitlId: string;
  createdAt: number;
  payload: GlobalSSEHitlEventPayload;
  view: HitlView;
}

export type GlobalSSEResourceChangedEvent =
  {
    type: "resource.changed";
    projectSlug: string;
    resourceType: "automation" | "todo";
    resourceId: string;
    createdAt: number;
  };

export type GlobalSSEEvent =
  | GlobalSessionEventEnvelope
  | GlobalSSEHeartbeatEvent
  | GlobalSSEResetEvent
  | GlobalSSELaggedEvent
  | GlobalSSEShutdownEvent
  | GlobalSSEMcpStatusEvent
  | GlobalSSEModelRuntimeChangedEvent
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
  | SessionGoalChangedEvent
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
  result: FinalizedToolResult;
  createdAt: number;
  startedAt: number;
  endedAt: number;
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
  result: FinalizedToolResult;
  createdAt: number;
  startedAt: number;
  endedAt: number;
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
  /** Correlates a canonical user message with Queue admission and optimistic UI. */
  clientRequestId?: string;
  compacted?: boolean;
  /** Required for canonical user input; absent from Assistant and internal notice messages. */
  modelAudit?: MessageModelAudit;
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
  /** Current execution directory when the projection is used for a Session surface. */
  cwd: string;
  rootSessionId: string;
  parentSessionId?: string;
  delegationRequest?: DelegationRequest;
  /** Optional long-running execution contract owned by this root Engineer Session. */
  goal?: SessionGoal;
  title: string | null;
  messages: SessionMessage[];
  pendingMessages: PendingSessionMessage[];
  steps: SessionStep[];
  todos: SessionTodo[];
  reminders: Reminder[];
  childSessionLinks: ToolChildSessionLink[];
  stats: SessionStats;
  executions: SessionExecutionRecord[];
  promptTraces?: PromptTraceSnapshot[];
  executionCount: number;
  isRunning: boolean;
  isStreamingModel: boolean;
  currentExecutionId?: string;
  currentAssistantMessageId?: string;
  modelSelection: SessionModelSelection;
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
  delegationRequest?: DelegationRequest;
  agentName: string;
  /** Persisted Skill identity; execution resolves these names against current policy. */
  activeSkillNames: string[];
  modelSelection: SessionModelSelection;
  title: string | null;
  /** Present only on a root Engineer Session with a current Goal. */
  goal?: SessionGoal;
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
  sessionId: string;
  cwd: string;
  rootSessionId: string;
  title: string | null;
  /** Present only on a root Engineer Session with a current Goal. */
  goal?: SessionGoal;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
  pendingMessages: PendingSessionMessage[];
  steps: SessionStep[];
  todos: SessionTodo[];
  reminders: Reminder[];
  childSessionLinks: ToolChildSessionLink[];
  stats: SessionStats;
  executions: SessionExecutionRecord[];
  events?: SessionEventEnvelope[];
  parentSessionId?: string;
  delegationRequest?: DelegationRequest;
  eventCursor?: number;
  modelSelection: SessionModelSelection;
  nextModelSelection: SessionNextModelSelection;
  activeModelBinding?: ExecutionModelBindingSummary;
  agentName: string;
  activeSkillNames: string[];
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
  files: DiffFile[];
  truncated?: boolean;
  unsupportedReason?: ToolDiffUnsupportedReason;
  warning?: string;
}

export type HitlAttentionStatus = "clear" | "waiting_for_human";

// ─── HITL Types ───

export const HITL_RECENT_TERMINAL_LIMIT = 20;

export type HitlOwner = { type: "session"; id: string };

export function hitlIdentityKey(identity: { owner: HitlOwner; hitlId: string }): string {
  return JSON.stringify([
    identity.owner.type,
    identity.owner.id,
    identity.hitlId,
  ]);
}

export type HitlStatus = "pending" | "answered" | "resolved" | "cancelled";

export type HitlSource =
  | { type: "ask_user"; toolCallId: string }
  | { type: "tool_permission"; toolCallId: string; toolName: string };

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

export type HitlResponse =
  | { type: "question_answer"; answers: string[]; comment?: string; answeredBy?: string }
  | { type: "permission_decision"; decision: "approve_once" | "approve_always" | "deny"; comment?: string; decidedBy?: string }
  | { type: "cancel"; reason: string; cancelledBy?: string };

export type HitlAllowedAction = "answer" | "approve" | "deny" | "cancel";

export interface HitlView {
  hitlId: string;
  owner: HitlOwner;
  source: HitlSource;
  status: HitlStatus;
  displayPayload: HitlDisplayPayload;
  /** Redacted permission capability. Absent for non-permission HITL. */
  persistentApprovalEligible?: boolean;
  allowedActions: HitlAllowedAction[];
  requiresInspection?: true;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

// ─── Automation Types ───

export type AutomationStatus = "active" | "paused" | "disabled";

export type AutomationTrigger =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expression: string; timezone: string };

export type AutomationAction =
  | { kind: "start_session"; message: string; location: "project" | "worktree" }
  | { kind: "send_message"; sessionId: string; message: string };

export type AutomationInvocationStatus = "pending" | "dispatched" | "failed" | "cancelled" | "missed";

export interface AutomationInvocation {
  id: string;
  automationId: string;
  dueAt: string;
  status: AutomationInvocationStatus;
  sessionId?: string;
  createdAt: string;
  dispatchedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface Automation {
  id: string;
  projectSlug: string;
  /** Ordinary Engineer Session in which the user confirmed this Automation. */
  createdFromSessionId: string;
  name: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
  status: AutomationStatus;
  createdAt: string;
  updatedAt: string;
  nextFireAt?: string;
}
