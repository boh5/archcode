import { rm } from "node:fs/promises";
import {
  MAX_DIRECT_CHILD_SESSIONS,
  isTerminalChildSessionStatus,
  TOOL_TOOL_SEARCH,
  type DelegationRequest,
  type ExecutionStartEvent,
  type MessageModelAudit,
  type ModelSelectionRef,
  type LoadedToolRef,
  type PendingSessionMessage,
  type ParentAgentMessageProvenance,
  type RequestedModelSelection,
  type SessionExecutionOrigin,
  type SessionExecutionRecord,
  type ExecutionSkillBinding,
  type SessionExecutionSuspension,
  type SessionExecutionTerminalStatus,
  type SessionFamilyActivity,
  type SessionMessageSource,
  type NormalizedUsage,
  type SessionTreeNode,
  type SessionTreeResponse,
  type ToolAuthorizationSnapshot,
  type ToolChildSessionLink,
  type ToolChildSessionLinkStatus,
} from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import type { Agent, AgentResult } from "../agents/types";
import {
  SkillNotFoundError,
  type SkillPackageSnapshot,
  type SkillService,
} from "../skills";
import type { AgentChildPolicy } from "../agents/factory-types";
import type { ProfileName } from "../config";
import {
  AgentChildPolicyMissingError,
  AgentRunningError,
  ChildSessionCwdMismatchError,
  ChildSessionNotFoundError,
  ChildSessionNotDescendantError,
  ChildSessionParentMismatchError,
  ConcurrentLimitError,
  DelegateTargetNotAllowedError,
  DepthLimitError,
  SessionCwdTransitionConflictError,
  SessionCwdTransitionInProgressError,
  SessionToolBatchActiveError,
} from "../agents/errors";
import { classifyChildFinalOutput, finalOutputForExecution } from "../delegation/final-output";
import { DelegatedSessionTitleSchema, DelegationRequestSchema } from "../delegation/schema";
import type {
  ChildExecutionHandle,
  ChildExecutionOutcome,
  ChildExecutionRequest,
  ParentAgentMessageRequest,
  ParentAgentMessageResult,
  ResumeChildRequest,
} from "../delegation/types";
import { ResumeSessionInputSchema } from "../tools/builtins/resume-session";
import { getSessionDir } from "../store/sessions-dir";
import { NotRootSessionError, SessionDeleteConflictError, SessionFileNotFoundError } from "../store/errors";
import { scopedKey } from "../store/key";
import type { Reminder, SessionStoreState, SessionToolBatch } from "../store/types";
import type { DurableSessionMutation } from "../store/session-store-manager";
import type { AgentName } from "../agents/names";
import { resolveSessionProfile } from "../agents/session-profile";
import type { Logger } from "../logger";
import {
  nextSessionTimestamp,
  SessionInputConflictError,
  type ResolvedSessionInputSnapshot,
  type SessionInputService,
} from "../session-input/service";
import { resolveDurableSessionModelOverride } from "../session-input/model-selection-service";
import type { ExecutionModelBinding, ModelRuntime, ModelRuntimeSnapshot } from "../models";
import type { MemoryPolicyRuntime, MemoryPolicySnapshot } from "../memory";
import type { ModelSelectionResolver } from "../models/model-selection-resolver";
import { sanitizeProviderError } from "../llm/provider-error-sanitizer";
import {
  SessionExecutionScopeConflictError,
  type SessionExecutionScopeValidator,
} from "./session-execution-scope-validator";
import { resolveSessionExecutionIdentity } from "./session-execution-identity";
import {
  SessionDeleteInProgressError,
  type SessionDeletionLifecycle,
} from "./session-deletion";
import {
  SessionFamilyActiveError,
  SessionFamilyIdentityUnavailableError,
  SessionFamilyStopInProgressError,
  type AcquireSessionFamilyStopInput,
  type SessionFamilyStopLease,
} from "./session-family-control";
import {
  SessionWorkspaceClosingError,
  type SessionWorkspaceCloseLease,
} from "./session-workspace-control";
import { collectSessionTreeIds } from "./session-tree";

const ABORT_AND_WAIT_TIMEOUT_MS = 10000;
const MAX_CWD_TRANSITIONS_PER_EXECUTION = 4;
const DEFAULT_EXECUTION_MAX_STEPS = 50;
const TOOL_LOAD_NOTICE_MAX_BYTES = 512;
export interface ActiveSessionExecution {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly workspaceRoot: string;
  readonly agentName: AgentName;
  readonly origin: SessionExecutionOrigin;
  readonly abortController: AbortController;
  readonly promise: Promise<void>;
  readonly executionToken: symbol;
  /** Durable id shared with the Session execution-start record. */
  readonly executionId: string;
  readonly runOrdinal: number;
  readonly initialStep: number;
  readonly maxSteps: number;
  /** Full immutable binding used by every model call in this Execution. */
  readonly binding: ExecutionModelBinding;
  /** Immutable Memory policy captured at the same claim boundary. */
  readonly memoryPolicy: MemoryPolicySnapshot;
  /** Immutable tool authorization inputs captured at the same claim boundary. */
  readonly toolAuthorizationSnapshot: ToolAuthorizationSnapshot;
  /** Settles once input plus execution-start are durable, before model work. */
  readonly started: Promise<void>;
}

// Session execution lifecycle:
//   active execution: starting -> running -> cancelling -> completed | failed | cancelled | timed_out | interrupted
//   parent link:      linked   -> running -> suspended -> running -> terminal
// `executionToken` is the generation guard for every manager-owned completion path:
// stale promises may resolve after abort/restart, but must not write terminal execution
// events, child links, reminders, or deferred-request cleanup for a newer generation.

export type SessionExecutionInput =
  | { readonly kind: "queue" }
  | {
    readonly kind: "direct";
    readonly text: string;
    readonly source?: SessionMessageSource;
    readonly messageId?: string;
    readonly clientRequestId?: string;
    readonly requestedModelSelection?: RequestedModelSelection;
  }
  | { readonly kind: "goal" }
  | {
    readonly kind: "child_resume";
    readonly text: string;
    readonly clientRequestId: string;
    readonly provenance: ParentAgentMessageProvenance;
  }
  | { readonly kind: "resume" };

export interface StartSessionExecutionInput {
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly input: SessionExecutionInput;
  readonly origin?: SessionExecutionOrigin;
  readonly maxSteps?: number;
  readonly activeTimeoutMs?: number;
  readonly extraTools?: readonly string[];
  /** Caller-supplied durable attempt id when an owner must checkpoint before start. */
  readonly executionId?: string;
}

interface InternalStartSessionExecutionInput extends StartSessionExecutionInput {
  readonly toolProjection?: readonly string[];
  readonly admissionSignal?: AbortSignal;
  /** Cold recovery of the exact open run; never exposed as a caller-owned continuation input. */
  readonly recoveryExecutionId?: string;
}

interface PendingSessionExecution extends Omit<ActiveSessionExecution, "promise"> {
  promise?: Promise<void>;
  newlyActivatedAgent?: Agent;
  runAgent?: Agent;
  familyStopLease?: SessionFamilyStopLease;
  readonly queueSnapshots?: readonly ResolvedSessionInputSnapshot[];
  readonly directRequestedModelSelection?: RequestedModelSelection;
  readonly initialUsage: NormalizedUsage;
  /** Session cwd fixed synchronously when this logical Execution claims admission. */
  readonly skillResolutionRoot: string;
  executionSkillSnapshots?: ReadonlyMap<string, SkillPackageSnapshot>;
  ready: boolean;
  messageGateOpen: boolean;
  readonly steerMailbox: ResolvedSessionInputSnapshot[];
  readonly messageOperations: Set<Promise<void>>;
  childSlotParentSessionId?: string;
  childSlotReleased?: boolean;
  resolveStarted(): void;
  rejectStarted(error: unknown): void;
}

interface ActiveSessionCommand {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly clientRequestId: string;
  readonly token: symbol;
  readonly abortController: AbortController;
  readonly completion: Promise<void>;
  readonly binding: ExecutionModelBinding;
  resolveCompletion(): void;
  rejectCompletion(error: unknown): void;
}

export type SessionCommandRunResult<T> =
  | { readonly kind: "executed"; readonly result: T }
  | { readonly kind: "joined"; readonly error?: unknown };

interface SessionCwdTransitionLeaseState {
  readonly token: symbol;
  readonly blockRootExecution: boolean;
}

interface SessionDeletionLeaseState {
  readonly token: symbol;
  readonly rootSessionId: string;
}

interface SessionFamilyStopLeaseState {
  readonly token: symbol;
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly exemptSessionId?: string;
}

interface SessionSubtreeStopLeaseState {
  readonly token: symbol;
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly targetSessionId: string;
}

interface PendingChildLaunch {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly abortController: AbortController;
  slotReserved: boolean;
}

interface PendingChildLaunchFamilyState {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly launches: Map<symbol, PendingChildLaunch>;
}

interface PendingSessionInputMutationFamilyState {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly mutations: Set<symbol>;
}

/**
 * A very short root-family control section used for durable state transitions
 * which must not race an as-yet-uncommitted user input mutation.  It is not a
 * scheduler: it only supplies a linearization point between the two owners.
 */
interface SessionFamilyControlState {
  readonly token: symbol;
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
}

export interface SessionRuntimeChange {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly activity: SessionFamilyActivity;
  readonly steerTargetExecutionId?: string;
}

export type SessionRuntimeChangeListener = (change: SessionRuntimeChange) => void;

export type RuntimeMaintenanceAdmission =
  | { readonly ready: true }
  | {
    readonly ready: false;
    readonly activeFamilyCount: number;
  };

export interface SessionExecutionDeadlineHandle {
  readonly id?: unknown;
}

/**
 * Owns only execution lifecycle deadlines. Business timestamps remain
 * authoritative wall-clock values; tests can advance cancellation deadlines
 * without waiting for the host machine.
 */
export interface SessionExecutionDeadlineScheduler {
  now(): number;
  sleep(delayMs: number): Promise<void>;
  schedule(delayMs: number, callback: () => void): SessionExecutionDeadlineHandle;
  cancel(handle: SessionExecutionDeadlineHandle): void;
}

const systemExecutionDeadlineScheduler: SessionExecutionDeadlineScheduler = {
  now: () => Date.now(),
  sleep: async (delayMs) => {
    await Bun.sleep(delayMs);
  },
  schedule: (delayMs, callback) => {
    const id = setTimeout(callback, delayMs);
    return { id };
  },
  cancel: (handle) => {
    if (handle.id !== undefined) clearTimeout(handle.id as Timer);
  },
};

interface SessionExecutionManagerConfig {
  readonly sessionAgentManager: SessionAgentManager;
  readonly validateToolAuthorization: (input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly authorization: ToolAuthorizationSnapshot;
  }) => Promise<void>;
  readonly modelRuntime: ModelRuntime;
  readonly memoryPolicyRuntime: MemoryPolicyRuntime;
  readonly modelSelectionResolver: ModelSelectionResolver;
  readonly createSessionStore: (
    sessionId: string,
    workspaceRoot: string,
    options: {
      readonly rootSessionId?: string;
      readonly parentSessionId?: string;
      readonly cwd?: string;
      readonly agentName: AgentName;
      readonly title?: string;
      readonly activeSkillNames?: readonly string[];
      readonly delegationRequest?: DelegationRequest;
    },
  ) => StoreApi<SessionStoreState>;
  /** Durability barrier for a freshly created Session snapshot. */
  readonly flushSessionStore: (sessionId: string, workspaceRoot: string) => Promise<void>;
  readonly getSessionStore: (sessionId: string, workspaceRoot: string) => StoreApi<SessionStoreState> | undefined;
  readonly loadSessionStore: (sessionId: string, workspaceRoot: string) => Promise<StoreApi<SessionStoreState>>;
  readonly commitDurableSessionMutation: <T>(
    sessionId: string,
    workspaceRoot: string,
    mutate: (state: Readonly<SessionStoreState>) => DurableSessionMutation<T>,
  ) => Promise<T>;
  readonly deleteSessionStore: (
    sessionId: string,
    workspaceRoot: string,
    options?: { readonly forgetWorkspaceIndex?: boolean },
  ) => boolean;
  readonly resolveRootSessionId: (sessionId: string, workspaceRoot: string) => Promise<string>;
  readonly resolveSessionDepth: (workspaceRoot: string, sessionId: string) => Promise<number>;
  readonly buildSessionTree: (workspaceRoot: string, rootSessionId: string) => Promise<SessionTreeResponse>;
  readonly listSessionFamilyToolBatchHitlIds: (workspaceRoot: string, rootSessionId: string) => Promise<readonly string[]>;
  readonly cancelSessionToolBatch: (
    sessionId: string,
    workspaceRoot: string,
    reason: string,
  ) => Promise<void>;
  readonly sessionInputService: Pick<
    SessionInputService,
    "acceptParentAgentMessage" | "getParentAgentMessageReplay" | "beginChildResumeExecution" | "beginQueueExecution" | "beginDirectExecution" | "claimSteer" | "commitSteers" | "rollbackSteers" | "getPendingMessages" | "recordQueueDispatchBarrier"
  >;
  readonly skillService: SkillService;
  readonly trackSession: (workspaceRoot: string, sessionId: string) => void;
  readonly untrackSession: (workspaceRoot: string, sessionId: string) => void;
  readonly executionScopeValidator: Pick<SessionExecutionScopeValidator, "validate">;
  readonly executionClaimCoordinator?: SessionExecutionClaimCoordinator;
  readonly deletionLifecycle?: SessionDeletionLifecycle;
  readonly sessionFamilyStopTimeoutMs?: number;
  readonly deadlineScheduler?: SessionExecutionDeadlineScheduler;
  /** Wakes an idle-family owner after its last durable input mutation settles. */
  readonly onSessionInputMutationReleased: (input: {
    readonly workspaceRoot: string;
    readonly rootSessionId: string;
  }) => void | Promise<void>;
  /** Retries durable resume-pending work after a child concurrency slot is released. */
  readonly onContinuationAdmissionReleased: (input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
  }) => void | Promise<void>;
  readonly applyChildDependencyOutcome: (input: {
    readonly workspaceRoot: string;
    readonly parentSessionId: string;
    readonly parentExecutionId: string;
    readonly parentToolBatchId: string;
    readonly parentToolCallId: string;
    readonly childSessionId: string;
    readonly childExecutionId: string;
    readonly outcome: Extract<ChildExecutionOutcome, { outcome: "terminal" }>;
  }) => Promise<void>;
  readonly resolveGoalInstanceId: (input: {
    readonly workspaceRoot: string;
    readonly rootSessionId: string;
  }) => Promise<string | null>;
  readonly onExecutionSettlement: (input: {
    readonly workspaceRoot: string;
    readonly rootSessionId: string;
    readonly sessionId: string;
    readonly executionId: string;
    readonly settlements: readonly (
      | {
          readonly key: string;
          readonly kind: "run";
          readonly runOrdinal: number;
          readonly usage: NormalizedUsage;
          readonly executionTimeMs: number;
          readonly goalInstanceId: string | null;
        }
      | {
          readonly key: string;
          readonly kind: "terminal";
          readonly usage: NormalizedUsage;
          readonly executionTimeMs: 0;
          readonly goalInstanceId: string | null;
          readonly terminalStatus: SessionExecutionTerminalStatus;
        }
    )[];
  }) => Promise<void>;
  readonly logger: Logger;
}

export interface SessionExecutionClaimCoordinator {
  run<T>(ownerId: string, action: () => Promise<T>): Promise<T>;
}

interface ExistingChildActivationAdmission {
  readonly childState: SessionStoreState;
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentState: SessionStoreState;
  readonly parentDepth: number;
  readonly childDepth: number;
  readonly childPolicy: AgentChildPolicy;
}

interface PendingCheckedStart {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
}

export class SessionExecutionManagerShuttingDownError extends Error {
  readonly code = "SESSION_EXECUTION_MANAGER_SHUTTING_DOWN";

  constructor() {
    super("Session execution manager is shutting down");
    this.name = "SessionExecutionManagerShuttingDownError";
  }
}

export class SessionSteerUnavailableError extends Error {
  readonly code = "SESSION_STEER_UNAVAILABLE";

  constructor(
    public readonly sessionId: string,
    public readonly expectedExecutionId: string,
  ) {
    super(`Session "${sessionId}" is not accepting Steer for execution "${expectedExecutionId}"`);
    this.name = "SessionSteerUnavailableError";
  }
}

export class SessionMessageAdmissionError extends Error {
  readonly code = "SESSION_MESSAGE_ADMISSION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "SessionMessageAdmissionError";
  }
}

export type CancelDescendantSessionResult = "cancelled" | "already_stopped";

export class DelegationExecutionAdmissionError extends Error {
  constructor(
    public readonly code:
      | "DELEGATION_IDENTITY_REQUIRED"
      | "DELEGATION_PROFILE_NOT_ALLOWED"
      | "DELEGATION_SESSION_CAPACITY_REACHED",
    message: string,
  ) {
    super(message);
    this.name = "DelegationExecutionAdmissionError";
  }
}

export class SessionExecutionManager {
  readonly #active = new Map<string, PendingSessionExecution>();
  readonly #activeCommands = new Map<string, ActiveSessionCommand>();
  readonly #childSlots = new Map<string, number>();
  readonly #cwdTransitions = new Map<string, SessionCwdTransitionLeaseState>();
  readonly #pendingChildLaunches = new Map<string, PendingChildLaunchFamilyState>();
  readonly #deletions = new Map<string, SessionDeletionLeaseState>();
  readonly #familyStops = new Map<string, SessionFamilyStopLeaseState>();
  readonly #subtreeStops = new Map<string, SessionSubtreeStopLeaseState>();
  readonly #workspaceClosures = new Map<string, symbol>();
  readonly #pendingCheckedStarts = new Map<symbol, PendingCheckedStart>();
  readonly #pendingSessionInputMutations = new Map<string, PendingSessionInputMutationFamilyState>();
  readonly #familyControls = new Map<string, SessionFamilyControlState>();
  readonly #runtimeMutations = new Set<symbol>();
  readonly #runtimeChangeListeners = new Set<SessionRuntimeChangeListener>();
  readonly #executionSkillSnapshots = new Map<string, ReadonlyMap<string, SkillPackageSnapshot>>();
  readonly #publishedRuntime = new Map<string, Pick<SessionRuntimeChange, "activity" | "steerTargetExecutionId">>();
  readonly #durableNonterminal = new Map<string, {
    readonly workspaceRoot: string;
    readonly rootSessionId: string;
    readonly sessionId: string;
    readonly suspension: SessionExecutionSuspension;
  }>();
  readonly #config: SessionExecutionManagerConfig;
  readonly #deadlineScheduler: SessionExecutionDeadlineScheduler;
  readonly #logger: Logger;
  #acceptingExecutions = true;
  #shutdownPromise: Promise<void> | undefined;

  constructor(config: SessionExecutionManagerConfig) {
    this.#config = config;
    this.#deadlineScheduler = config.deadlineScheduler ?? systemExecutionDeadlineScheduler;
    this.#logger = config.logger;
  }

  #claimExecution(
    input: InternalStartSessionExecutionInput,
    newlyActivatedAgent?: Agent,
  ): ActiveSessionExecution {
    this.#assertWorkspaceOpen(input.workspaceRoot);
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    if (this.#active.has(key)) {
      throw new AgentRunningError();
    }
    const sessionState = this.#config.getSessionStore(input.sessionId, input.workspaceRoot)?.getState();
    if (sessionState === undefined) throw new SessionFamilyIdentityUnavailableError(input.sessionId);
    this.#assertDurableChildDelegationIdentity(sessionState);
    const resumedRecord = input.input.kind === "resume"
      ? sessionState.executions.find((candidate) => candidate.id === input.executionId)
      : undefined;
    if (input.input.kind === "resume") {
      if (input.recoveryExecutionId !== undefined) {
        const openRun = resumedRecord?.runs.at(-1);
        if (
          input.executionId !== input.recoveryExecutionId
          || resumedRecord?.status !== "running"
          || openRun === undefined
          || openRun.endedAt !== undefined
        ) {
          throw new Error(`Session "${input.sessionId}" has no recoverable running Execution "${input.recoveryExecutionId}"`);
        }
      } else if (
        input.executionId === undefined
        || resumedRecord?.status !== "suspended"
        || resumedRecord.suspension.kind !== "resume_pending"
      ) {
        throw new Error(`Session "${input.sessionId}" has no resume-pending Execution "${input.executionId ?? "none"}"`);
      }
      if (input.extraTools !== undefined || input.toolProjection !== undefined) {
        throw new Error(`Continuation of Execution "${input.executionId}" cannot replace its tool authorization snapshot`);
      }
    }
    this.#assertSessionStartAllowed(
      input.workspaceRoot,
      input.sessionId,
      sessionState,
      input.input.kind === "resume",
    );
    this.#assertExecutionOriginReady(input, sessionState);
    const queuedAtClaim = input.input.kind === "queue" || input.input.kind === "child_resume"
      ? sessionState.pendingMessages.filter((message) => message.state === "queued")
      : [];
    if (input.input.kind === "queue" && queuedAtClaim.length === 0) {
      throw new SessionInputConflictError("empty_queue", `Session ${sessionState.sessionId} has no queued input`);
    }
    if (input.input.kind === "queue" && sessionState.parentSessionId !== undefined) {
      const previous = sessionState.executions.at(-1);
      if (
        previous === undefined
        || previous.status !== "completed"
        || previous.stopRequestedAt !== undefined
        || !queueDispatchEligible(previous, queuedAtClaim, sessionState.queueDispatchBarrierAt)
      ) {
        throw new SessionInputConflictError(
          "empty_queue",
          `Child Session ${sessionState.sessionId} Queue is no longer dispatch eligible`,
        );
      }
      assertQueuedChildDispatchInput(sessionState, queuedAtClaim);
    }
    const modelSnapshot = this.#config.modelRuntime.current;
    const memoryPolicy = resumedRecord === undefined
      ? this.#config.memoryPolicyRuntime.claim()
      : resumedRecord.memoryPolicy;
    const toolAuthorizationSnapshot = resumedRecord === undefined
      ? normalizeToolAuthorizationSnapshot(input.extraTools, input.toolProjection)
      : cloneToolAuthorizationSnapshot(resumedRecord.toolAuthorizationSnapshot);
    const profile = resolveSessionProfile(sessionState);
    const sessionOverride = resolveDurableSessionModelOverride(sessionState);
    const resolved = (input.input.kind === "queue" || input.input.kind === "child_resume")
      && queuedAtClaim.length > 0
      ? resolveQueuePrefix(
        queuedAtClaim,
        modelSnapshot,
        profile,
        sessionOverride,
        this.#config.modelSelectionResolver,
      )
      : resolveSingleBinding(
        modelSnapshot,
        profile,
        sessionOverride,
        input.input.kind === "direct" ? input.input.requestedModelSelection : undefined,
        this.#config.modelSelectionResolver,
      );
    const directRequestedModelSelection = input.input.kind === "direct" || input.input.kind === "child_resume"
      ? effectiveDirectRequest(
        input.input.kind === "direct" ? input.input.requestedModelSelection : undefined,
        resolved.binding,
      )
      : undefined;
    const rootSessionId = sessionState.rootSessionId;
    const abortController = new AbortController();
    const executionToken = Symbol(`session-execution:${key}`);
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    void started.catch(() => undefined);
    const recoveredOpenRun = input.recoveryExecutionId === undefined
      ? undefined
      : resumedRecord?.runs.at(-1);
    const pending: PendingSessionExecution = {
      sessionId: input.sessionId,
      rootSessionId,
      workspaceRoot: input.workspaceRoot,
      agentName: sessionState.agentName,
      origin: resumedRecord?.origin ?? sessionExecutionOrigin(input.origin),
      abortController,
      executionToken,
      executionId: resumedRecord?.id ?? input.executionId ?? crypto.randomUUID(),
      runOrdinal: recoveredOpenRun?.ordinal ?? resumedRecord?.runs.length ?? 0,
      initialStep: nextExecutionStep(sessionState, resumedRecord?.id),
      maxSteps: resumedRecord?.maxSteps ?? input.maxSteps ?? DEFAULT_EXECUTION_MAX_STEPS,
      binding: resolved.binding,
      memoryPolicy,
      toolAuthorizationSnapshot,
      initialUsage: input.recoveryExecutionId === undefined || resumedRecord === undefined
        ? { ...sessionState.stats.usage }
        : subtractUsage(sessionState.stats.usage, recoveredRunUsage(sessionState, resumedRecord)),
      skillResolutionRoot: sessionState.cwd,
      ...(input.input.kind === "queue" || input.input.kind === "child_resume"
        ? { queueSnapshots: resolved.snapshots ?? [] }
        : {}),
      ...(directRequestedModelSelection === undefined ? {} : { directRequestedModelSelection }),
      started,
      ready: false,
      messageGateOpen: false,
      steerMailbox: [],
      messageOperations: new Set(),
      resolveStarted,
      rejectStarted,
      ...(newlyActivatedAgent === undefined ? {} : { newlyActivatedAgent }),
    };

    if (input.input.kind === "resume") this.#durableNonterminal.delete(key);
    this.#active.set(key, pending);
    this.#config.trackSession(input.workspaceRoot, input.sessionId);
    pending.promise = this.#runExecution(input, pending).finally(() => {
      this.#finalizeExecution(key, pending);
    });
    return pending as ActiveSessionExecution;
  }

  /**
   * User-message entry point. It cold-loads canonical Session identity before
   * synchronously claiming execution, so a child can never continue in a cwd
   * abandoned by its root Session.
   */
  async startCheckedExecution(input: StartSessionExecutionInput): Promise<ActiveSessionExecution> {
    return await this.#startCheckedExecution(input);
  }

  /** Attempts one FIFO batch start for a root or one durable child Queue chain. */
  async tryStartQueuedExecution(input: {
    readonly slug: string;
    readonly workspaceRoot: string;
    readonly sessionId: string;
  }): Promise<ActiveSessionExecution | undefined> {
    let queuedChildState: SessionStoreState | undefined;
    let queuedChildParentStore: StoreApi<SessionStoreState> | undefined;
    let queuedChildLaunchSignal: AbortSignal | undefined;
    try {
      const store = await this.#config.loadSessionStore(input.sessionId, input.workspaceRoot);
      const state = store.getState();
      const pending = state.pendingMessages.filter((message) => message.state === "queued");
      if (pending.length === 0 || !queueDispatchEligible(
        state.executions.at(-1),
        pending,
        state.queueDispatchBarrierAt,
      )) return undefined;
      if (state.parentSessionId === undefined) {
        if (state.sessionId !== state.rootSessionId) return undefined;
        if (this.getSessionFamilyActivity(input.workspaceRoot, state.rootSessionId) !== "idle") return undefined;
        if ((await this.#config.listSessionFamilyToolBatchHitlIds(input.workspaceRoot, state.rootSessionId)).length > 0) return undefined;
        return await this.#startCheckedExecution({
          ...input,
          origin: "user_message",
          input: { kind: "queue" },
        });
      }

      const previous = state.executions.at(-1);
      if (
        previous === undefined
        || previous.status !== "completed"
        || previous.stopRequestedAt !== undefined
        || this.#active.has(scopedKey(input.workspaceRoot, input.sessionId))
      ) return undefined;
      queuedChildState = state;
      assertQueuedChildDispatchInput(state, pending);
      const childLaunch = this.#reserveChildLaunch(
        input.workspaceRoot,
        state.rootSessionId,
        state.parentSessionId,
        state.sessionId,
      );
      queuedChildLaunchSignal = childLaunch.signal;
      let launchReserved = true;
      let slotReserved = false;
      let admission: ExistingChildActivationAdmission | undefined;
      try {
        childLaunch.signal.throwIfAborted();
        admission = await this.#validateExistingChildActivation(input.workspaceRoot, store);
        childLaunch.signal.throwIfAborted();
        queuedChildParentStore = admission.parentStore;
        const currentState = store.getState();
        const currentPending = currentState.pendingMessages.filter((message) => message.state === "queued");
        const currentPrevious = currentState.executions.at(-1);
        if (
          currentPrevious === undefined
          || currentPrevious.status !== "completed"
          || currentPrevious.stopRequestedAt !== undefined
          || !queueDispatchEligible(currentPrevious, currentPending, currentState.queueDispatchBarrierAt)
        ) return undefined;
        assertQueuedChildDispatchInput(currentState, currentPending);
        this.#reserveChildSlot(
          input.workspaceRoot,
          admission.parentState.sessionId,
          admission.childPolicy.maxConcurrent,
        );
        slotReserved = true;
        childLaunch.markSlotReserved();
        childLaunch.signal.throwIfAborted();
        const execution = await this.#startCheckedExecution({
          ...input,
          origin: "tool_call",
          input: { kind: "queue" },
          admissionSignal: childLaunch.signal,
          activeTimeoutMs: admission.childPolicy.timeoutMs > 0
            ? admission.childPolicy.timeoutMs
            : undefined,
        });
        this.#attachChildSlotOwnership(execution, admission.parentState.sessionId);
        childLaunch.takeReservedSlot();
        slotReserved = false;
        childLaunch.release();
        launchReserved = false;
        try {
          await execution.started;
        } catch (error) {
          await this.#releaseExecutionChildSlot(execution);
          throw error;
        }
        const timeout = scheduleActiveExecutionTimeout(
          store.getState(),
          execution,
          this.#deadlineScheduler,
        );
        const removeParentAbort = admission.childPolicy.abortCascade
          ? this.#wireExactQueuedSenderAbort(input.workspaceRoot, admission, execution)
          : () => {};
        let resolveForcedWatcher: () => void = () => {};
        const forcedWatcher = new Promise<void>((resolve) => {
          resolveForcedWatcher = resolve;
        });
        const watcher = this.#watchQueuedChildExecution(
          input.workspaceRoot,
          execution,
          admission,
          timeout,
          removeParentAbort,
          forcedWatcher,
        );
        void watcher;
        try {
          await this.#appendQueuedChildLinks(
            input.workspaceRoot,
            admission,
            execution,
          );
        } catch (error) {
          this.#logger.error("session.child_queue.link_persist_failed", {
            error,
            context: { sessionId: execution.sessionId, executionId: execution.executionId },
            meta: { workspaceRoot: input.workspaceRoot },
          });
          this.#cancelExecution(execution, "Queued child Link persistence cancelled");
          try {
            await waitForExecutionToStop(execution, this.#deadlineScheduler);
          } catch {
            await this.#forceTerminalizeExecution(
              execution as PendingSessionExecution,
              "Queued child Link persistence cancelled",
            );
            resolveForcedWatcher();
          }
          await watcher;
        }
        return execution;
      } finally {
        if (launchReserved) childLaunch.release();
        if (slotReserved && childLaunch.takeReservedSlot() && admission !== undefined) {
          await this.#releaseChildSlot(input.workspaceRoot, admission.parentState.sessionId);
        }
      }
    } catch (error) {
      if (queuedChildLaunchSignal?.aborted) return undefined;
      if (
        error instanceof AgentRunningError
        || error instanceof ConcurrentLimitError
        || error instanceof SessionFamilyActiveError
        || error instanceof SessionFamilyStopInProgressError
        || error instanceof SessionDeleteInProgressError
        || error instanceof SessionExecutionManagerShuttingDownError
        || (error instanceof SessionInputConflictError && error.reason === "empty_queue")
      ) return undefined;
      if (
        queuedChildState?.parentSessionId !== undefined
      ) {
        const blockedAfterExecutionId = queuedChildState.executions.at(-1)?.id;
        if (blockedAfterExecutionId !== undefined) {
          queuedChildParentStore ??= await this.#config.loadSessionStore(
            queuedChildState.parentSessionId,
            input.workspaceRoot,
          );
          const safeError = queueDispatchErrorMessage(error);
          const childStore = await this.#config.loadSessionStore(input.sessionId, input.workspaceRoot);
          await this.#config.sessionInputService.recordQueueDispatchBarrier({
            sessionId: input.sessionId,
            workspaceRoot: input.workspaceRoot,
            timestamp: nextSessionTimestamp(childStore.getState()),
          });
          appendQueueDispatchBlockedReminder(
            queuedChildParentStore,
            input.sessionId,
            blockedAfterExecutionId,
            safeError,
          );
          await this.#config.flushSessionStore(
            queuedChildState.parentSessionId,
            input.workspaceRoot,
          );
          return undefined;
        }
      }
      throw error;
    }
  }

  /**
   * Runs a root Session command under the same family admission owner as model
   * executions. Commands do not create Execution records, but they block model,
   * other root starts and sibling commands and participate in Stop cancellation.
   */
  async runSessionCommand<T>(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly clientRequestId: string;
    readonly requestedModelSelection: RequestedModelSelection;
  }, execute: (binding: ExecutionModelBinding, signal: AbortSignal) => Promise<T>): Promise<SessionCommandRunResult<T>> {
    this.#assertWorkspaceOpen(input.workspaceRoot);
    const state = this.#config.getSessionStore(input.sessionId, input.workspaceRoot)?.getState();
    if (state === undefined) throw new SessionFamilyIdentityUnavailableError(input.sessionId);
    if (state.parentSessionId !== undefined || state.rootSessionId !== input.sessionId) {
      throw new NotRootSessionError(input.sessionId, state.parentSessionId ?? state.rootSessionId);
    }
    const familyKey = scopedKey(input.workspaceRoot, state.rootSessionId);
    const existingCommand = this.#activeCommands.get(familyKey);
    if (existingCommand?.clientRequestId === input.clientRequestId) {
      try {
        await existingCommand.completion;
        return { kind: "joined" };
      } catch (error) {
        return { kind: "joined", error };
      }
    }
    const activity = this.getSessionFamilyActivity(input.workspaceRoot, state.rootSessionId);
    if (activity === "stopping") {
      throw new SessionFamilyStopInProgressError(input.sessionId, state.rootSessionId);
    }
    if (activity === "running") {
      throw new SessionFamilyActiveError(input.sessionId, state.rootSessionId, activity);
    }
    this.#assertSessionStartAllowed(input.workspaceRoot, input.sessionId, state);
    if (state.pendingMessages.length > 0) {
      throw new SessionInputConflictError(
        "state",
        `Session ${input.sessionId} command cannot bypass ${state.pendingMessages.length} queued message(s)`,
      );
    }
    const binding = this.#config.modelSelectionResolver.resolve({
      snapshot: this.#config.modelRuntime.current,
      profile: resolveSessionProfile(state),
      requested: input.requestedModelSelection,
      sessionOverride: resolveDurableSessionModelOverride(state),
    });

    const token = Symbol(`session-command:${familyKey}`);
    const abortController = new AbortController();
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);
    const command: ActiveSessionCommand = {
      workspaceRoot: input.workspaceRoot,
      rootSessionId: state.rootSessionId,
      clientRequestId: input.clientRequestId,
      token,
      abortController,
      completion,
      binding,
      resolveCompletion,
      rejectCompletion,
    };
    this.#activeCommands.set(familyKey, command);
    this.#publishSessionRuntimeChange(input.workspaceRoot, state.rootSessionId);
    try {
      const result = await raceAbort(execute(binding, abortController.signal), abortController.signal);
      resolveCompletion();
      return { kind: "executed", result };
    } catch (error) {
      const safeError = sanitizeBindingError(error, binding);
      rejectCompletion(safeError);
      throw safeError;
    } finally {
      if (this.#activeCommands.get(familyKey)?.token === token) {
        this.#activeCommands.delete(familyKey);
        this.#publishSessionRuntimeChange(input.workspaceRoot, state.rootSessionId);
      }
    }
  }

  /** Claims one durable resume-pending logical Execution without creating a second record. */
  async resumeSessionExecution(
    input: Omit<StartSessionExecutionInput, "input" | "origin" | "executionId">,
  ): Promise<ActiveSessionExecution> {
    const sessionStore = await this.#config.loadSessionStore(input.sessionId, input.workspaceRoot);
    const initialState = sessionStore.getState();
    if (this.getSessionFamilyActivity(input.workspaceRoot, initialState.rootSessionId) === "stopping") {
      throw new SessionFamilyStopInProgressError(input.sessionId, initialState.rootSessionId);
    }
    const record = initialState.executions.find((candidate) =>
      candidate.status === "suspended" && candidate.suspension.kind === "resume_pending"
    );
    if (record === undefined) {
      throw new Error(`Session "${input.sessionId}" has no resume-pending Execution`);
    }
    const childState = sessionStore.getState();
    const childAdmission = childState.parentSessionId === undefined
      ? undefined
      : await this.#validateExistingChildActivation(input.workspaceRoot, sessionStore);
    let childSlotReserved = false;
    let execution: ActiveSessionExecution;
    try {
      if (childAdmission !== undefined) {
        this.#reserveChildSlot(
          input.workspaceRoot,
          childAdmission.parentState.sessionId,
          childAdmission.childPolicy.maxConcurrent,
        );
        childSlotReserved = true;
      }
      execution = await this.#startCheckedExecution({
        ...input,
        executionId: record.id,
        input: { kind: "resume" },
      });
      if (childAdmission !== undefined) {
        this.#attachChildSlotOwnership(execution, childAdmission.parentState.sessionId);
        childSlotReserved = false;
      }
    } catch (error) {
      if (childSlotReserved && childAdmission !== undefined) {
        await this.#releaseChildSlot(input.workspaceRoot, childAdmission.parentState.sessionId);
      }
      throw error;
    }
    await execution.started;
    const timeout = scheduleActiveExecutionTimeout(
      sessionStore.getState(),
      execution,
      this.#deadlineScheduler,
    );
    await this.#updateChildSessionLinkForExecution(input.workspaceRoot, input.sessionId, "running");
    void execution.promise.finally(async () => {
      if (timeout !== undefined) this.#deadlineScheduler.cancel(timeout);
      await this.#releaseExecutionChildSlot(execution);
      const store = await this.#config.loadSessionStore(input.sessionId, input.workspaceRoot);
      const status = childTerminalStatus(store.getState().executions.at(-1), execution.abortController.signal);
      await this.#updateChildSessionLinkForExecution(input.workspaceRoot, input.sessionId, status);
    }).catch((error) => {
      this.#logger.warn("session.tool_batch.child_link_update_failed", {
        context: { sessionId: input.sessionId },
        meta: { workspaceRoot: input.workspaceRoot },
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return execution;
  }

  async listSessionFamilyToolBatchHitlIds(workspaceRoot: string, rootSessionId: string): Promise<readonly string[]> {
    return await this.#config.listSessionFamilyToolBatchHitlIds(workspaceRoot, rootSessionId);
  }

  /** Waits only for the exact live run to persist its suspend/terminal boundary. */
  async awaitExactRunBoundary(
    workspaceRoot: string,
    sessionId: string,
    executionId: string,
  ): Promise<void> {
    const active = this.#active.get(scopedKey(workspaceRoot, sessionId));
    if (active?.executionId !== executionId) return;
    await active.promise;
  }

  /**
   * Reconciles one strict current-format logical Execution. This is the only
   * cold-start path allowed to write lifecycle repair events.
   */
  async reconcileDurableSession(input: {
    readonly slug: string;
    readonly workspaceRoot: string;
    readonly sessionId: string;
  }): Promise<ActiveSessionExecution | undefined> {
    const store = await this.#config.loadSessionStore(input.sessionId, input.workspaceRoot);
    const state = store.getState();
    let record: SessionExecutionRecord | undefined = state.executions.find((candidate) =>
      candidate.status === "running" || candidate.status === "suspended"
    );
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    if (record === undefined) {
      const orphanedBatch = state.toolBatches.find((batch) => batch.archivedAt === undefined);
      if (orphanedBatch !== undefined) {
        await this.#config.cancelSessionToolBatch(
          input.sessionId,
          input.workspaceRoot,
          "Terminal Session cannot retain an active Tool Batch",
        );
        if (store.getState().toolBatches.some((batch) => batch.archivedAt === undefined)) {
          throw new Error(`Terminal Session ${input.sessionId} still has an active Tool Batch`);
        }
      }
      const terminalRecord = store.getState().executions.at(-1);
      const terminalChildStatus = terminalRecord === undefined
        ? undefined
        : childLinkStatusFromExecution(terminalRecord);
      if (terminalChildStatus !== undefined && terminalChildStatus !== "waiting_for_human") {
        await this.#updateChildSessionLinkForExecution(
          input.workspaceRoot,
          input.sessionId,
          terminalChildStatus,
        );
      }
      this.#durableNonterminal.delete(key);
      return undefined;
    }

    let activeBatch = state.toolBatches.find((batch) =>
      batch.archivedAt === undefined && batch.executionId === record!.id
    );
    const exactLive = this.#active.get(key);
    if (
      record.status === "running"
      && exactLive?.executionId === record.id
      && exactLive.promise !== undefined
    ) return exactLive as ActiveSessionExecution;
    if (
      record.status === "running"
      && this.#active.get(key)?.executionId !== record.id
      && activeBatch !== undefined
      && hasRecoverableToolSearchCalls(activeBatch)
      && isCompleteToolAuthorizationSnapshot(record.toolAuthorizationSnapshot)
    ) {
      const execution = await this.#startCheckedExecution({
        slug: input.slug,
        workspaceRoot: input.workspaceRoot,
        sessionId: input.sessionId,
        executionId: record.id,
        recoveryExecutionId: record.id,
        input: { kind: "resume" },
      });
      await execution.started;
      return execution;
    }
    if (record.status === "running" && this.#active.get(key)?.executionId !== record.id) {
      const run = record.runs.at(-1);
      if (run === undefined || run.endedAt !== undefined) {
        throw new Error(`Running Execution ${record.id} has no open run`);
      }
      const blockerIds = activeBatch?.calls.flatMap((call) =>
        call.state === "blocked" && call.blocker?.hitlId !== undefined
          ? [call.blocker.hitlId]
          : []
      ).sort() ?? [];
      const childCall = activeBatch?.calls.find((call) =>
        call.state === "child_launch" || call.state === "child_dependency"
      );
      let runEndedAt = recoveryRunEndedAt(state, record, activeBatch);
      const claimedSteers = state.pendingMessages.filter((message) =>
        message.state === "steering"
        && message.targetExecutionId === record!.id
        && message.targetRunOrdinal === run.ordinal
      );
      const recoverableSuspension = activeBatch !== undefined
        && (blockerIds.length > 0 || childCall?.childDependency !== undefined);
      if (claimedSteers.length > 0) {
        if (recoverableSuspension) {
          await this.#config.sessionInputService.commitSteers({
            sessionId: input.sessionId,
            workspaceRoot: input.workspaceRoot,
            executionId: record.id,
            runOrdinal: run.ordinal,
            snapshots: claimedSteers.map((pending) => {
              if (pending.targetModelAudit === undefined) {
                throw new Error(`Steering message ${pending.id} has no durable model audit`);
              }
              return { pending, modelAudit: pending.targetModelAudit };
            }),
            binding: run.binding,
            committedAt: runEndedAt,
          });
        } else {
          await this.#config.sessionInputService.rollbackSteers({
            sessionId: input.sessionId,
            workspaceRoot: input.workspaceRoot,
            executionId: record.id,
            messageIds: claimedSteers.map((message) => message.id),
          });
        }
      }
      const runUsageDelta = recoveredRunUsage(state, record);
      const goalInstanceId = await this.#config.resolveGoalInstanceId({
        workspaceRoot: input.workspaceRoot,
        rootSessionId: state.rootSessionId,
      });
      const runSettlement = {
        key: `run:${state.sessionId}:${record.id}:${run.ordinal}`,
        goalInstanceId,
      };
      if (activeBatch !== undefined && childCall?.childDependency !== undefined) {
        store.getState().append({
          type: "execution-suspended",
          executionId: record.id,
          suspension: {
            kind: "child_dependency",
            toolBatchId: activeBatch.batchId,
            toolCallId: childCall.toolCallId,
            childSessionId: childCall.childDependency.childSessionId,
            childExecutionId: childCall.childDependency.childExecutionId,
          },
          runEndedAt,
          runUsageDelta,
          runSettlement,
        });
        await this.#config.flushSessionStore(input.sessionId, input.workspaceRoot);
        await this.#applySettlements({
          workspaceRoot: input.workspaceRoot,
          rootSessionId: state.rootSessionId,
          sessionId: state.sessionId,
          executionId: record.id,
          settlements: [{
            ...runSettlement,
            kind: "run",
            runOrdinal: run.ordinal,
            usage: runUsageDelta,
            executionTimeMs: Math.max(0, runEndedAt - run.startedAt),
          }],
        });
      } else if (activeBatch !== undefined && blockerIds.length > 0) {
        store.getState().append({
          type: "execution-suspended",
          executionId: record.id,
          suspension: {
            kind: "hitl",
            toolBatchId: activeBatch.batchId,
            blockerIds,
          },
          runEndedAt,
          runUsageDelta,
          runSettlement,
        });
        await this.#config.flushSessionStore(input.sessionId, input.workspaceRoot);
        await this.#applySettlements({
          workspaceRoot: input.workspaceRoot,
          rootSessionId: state.rootSessionId,
          sessionId: state.sessionId,
          executionId: record.id,
          settlements: [{
            ...runSettlement,
            kind: "run",
            runOrdinal: run.ordinal,
            usage: runUsageDelta,
            executionTimeMs: Math.max(0, runEndedAt - run.startedAt),
          }],
        });
      } else {
        if (activeBatch !== undefined) {
          await this.#config.cancelSessionToolBatch(
            input.sessionId,
            input.workspaceRoot,
            "Execution lost its live tool continuation and requires manual inspection",
          );
        }
        const interruptedExecutionId = record.id;
        for (const openStep of store.getState().steps.filter((step) =>
          step.executionId === interruptedExecutionId
          && step.runOrdinal === run.ordinal
          && step.completedAt === undefined
        )) {
          store.getState().append({
            type: "step-end",
            stepId: openStep.id,
            step: openStep.step,
            finishReason: "interrupted",
          });
        }
        runEndedAt = Math.max(
          runEndedAt,
          ...store.getState().steps
            .filter((step) => step.executionId === interruptedExecutionId && step.runOrdinal === run.ordinal)
            .flatMap((step) => step.completedAt === undefined ? [] : [step.completedAt]),
        );
        const terminalSettlement = {
          key: `terminal:${state.sessionId}:${record.id}`,
          goalInstanceId,
        };
        store.getState().append({
          type: "execution-end",
          executionId: record.id,
          terminalStatus: "interrupted",
          endedAt: runEndedAt,
          runEndedAt,
          runUsageDelta,
          runSettlement,
          terminalSettlement,
          error: "Execution lost its live model/tool continuation and requires manual inspection",
        });
        await this.#config.flushSessionStore(input.sessionId, input.workspaceRoot);
        await this.#applySettlements({
          workspaceRoot: input.workspaceRoot,
          rootSessionId: state.rootSessionId,
          sessionId: state.sessionId,
          executionId: record.id,
          settlements: [
            {
              ...runSettlement,
              kind: "run",
              runOrdinal: run.ordinal,
              usage: runUsageDelta,
              executionTimeMs: Math.max(0, runEndedAt - run.startedAt),
            },
            {
              ...terminalSettlement,
              kind: "terminal",
              usage: zeroUsage(),
              executionTimeMs: 0,
              terminalStatus: "interrupted",
            },
          ],
        });
      }
      record = store.getState().executions.find((candidate) => candidate.id === record!.id);
    }

    const queuedLinkRecovery = record === undefined
      ? undefined
      : await this.#recoverQueuedChildLinks(input.workspaceRoot, store, record.id);

    if (record === undefined || record.status !== "suspended") {
      const childStatus = record === undefined ? undefined : childLinkStatusFromExecution(record);
      if (record !== undefined && childStatus !== undefined && childStatus !== "waiting_for_human") {
        if (queuedLinkRecovery === undefined) {
          await this.#updateChildSessionLinkForExecution(input.workspaceRoot, input.sessionId, childStatus);
        } else {
          await this.#updateAllChildLinksForExecution(
            input.workspaceRoot,
            input.sessionId,
            record.id,
            childStatus,
          );
          if (queuedLinkRecovery.terminalReminders) {
            appendTerminalReminder(
              queuedLinkRecovery.parentStore,
              input.sessionId,
              record.id,
              childStatus,
              record.error,
            );
            await this.#config.flushSessionStore(
              queuedLinkRecovery.parentSessionId,
              input.workspaceRoot,
            );
          }
        }
      }
      this.#durableNonterminal.delete(key);
      this.#publishSessionRuntimeChange(input.workspaceRoot, state.rootSessionId);
      return undefined;
    }

    if (activeBatch === undefined || activeBatch.batchId !== record.suspension.toolBatchId) {
      await this.#terminalizeSuspendedForInspection(
        input.workspaceRoot,
        state.rootSessionId,
        state.sessionId,
        record,
        "Suspended Execution has no exact active Tool Batch",
      );
      return undefined;
    }

    if (record.suspension.kind === "child_dependency") {
      await this.#reconcileExactChildDependency(input, store, record, activeBatch);
      activeBatch = store.getState().toolBatches.find((batch) =>
        batch.archivedAt === undefined && batch.executionId === record!.id
      );
      if (activeBatch === undefined) return undefined;
    }

    const blockerIds = activeBatch.calls.flatMap((call) =>
      call.state === "blocked" && call.blocker?.hitlId !== undefined
        ? [call.blocker.hitlId]
        : []
    ).sort();
    if (record.suspension.kind === "hitl") {
      const nextSuspension: SessionExecutionSuspension = blockerIds.length > 0
        ? { ...record.suspension, blockerIds }
        : {
            kind: "resume_pending",
            toolBatchId: activeBatch.batchId,
            readyAt: Date.parse(activeBatch.updatedAt),
          };
      store.getState().append({
        type: "execution-suspension-updated",
        executionId: record.id,
        suspension: nextSuspension,
      });
      await this.#config.flushSessionStore(input.sessionId, input.workspaceRoot);
      record = store.getState().executions.find((candidate) => candidate.id === record!.id);
    } else if (record.suspension.kind === "child_dependency") {
      const childSuspension = record.suspension;
      const call = activeBatch.calls.find((candidate) =>
        candidate.toolCallId === childSuspension.toolCallId
      );
      const dependency = call?.childDependency;
      if (
        call?.state === "queued"
        && dependency?.kind === "child_dependency"
        && dependency.outcome !== undefined
      ) {
        store.getState().append({
          type: "execution-suspension-updated",
          executionId: record.id,
          suspension: {
            kind: "resume_pending",
            toolBatchId: activeBatch.batchId,
            readyAt: dependency.outcome.resolvedAt,
          },
        });
        await this.#config.flushSessionStore(input.sessionId, input.workspaceRoot);
        record = store.getState().executions.find((candidate) => candidate.id === record!.id);
      }
    }

    if (record?.status !== "suspended") return undefined;
    this.#durableNonterminal.set(key, {
      workspaceRoot: input.workspaceRoot,
      rootSessionId: state.rootSessionId,
      sessionId: state.sessionId,
      suspension: record.suspension,
    });
    if (queuedLinkRecovery === undefined) {
      await this.#updateChildSessionLinkForExecution(
        input.workspaceRoot,
        input.sessionId,
        "waiting_for_human",
      );
    } else {
      await this.#updateAllChildLinksForExecution(
        input.workspaceRoot,
        input.sessionId,
        record.id,
        "waiting_for_human",
      );
    }
    this.#publishSessionRuntimeChange(input.workspaceRoot, state.rootSessionId);
    if (record.suspension.kind !== "resume_pending") return undefined;
    try {
      return await this.resumeSessionExecution(input);
    } catch (error) {
      if (
        error instanceof AgentRunningError
        || error instanceof SessionFamilyActiveError
        || error instanceof ConcurrentLimitError
        || error instanceof SessionFamilyStopInProgressError
        || error instanceof SessionDeleteInProgressError
        || error instanceof SessionWorkspaceClosingError
      ) return undefined;
      throw error;
    }
  }

  async #reconcileExactChildDependency(
    input: { readonly slug: string; readonly workspaceRoot: string; readonly sessionId: string },
    parentStore: StoreApi<SessionStoreState>,
    record: Extract<SessionExecutionRecord, { status: "suspended" }>,
    batch: SessionToolBatch,
  ): Promise<void> {
    if (record.suspension.kind !== "child_dependency") return;
    const suspension = record.suspension;
    let call = batch.calls.find((candidate) => candidate.toolCallId === suspension.toolCallId);
    let dependency = call?.childDependency;
    if (
      call === undefined
      || dependency === undefined
      || dependency.parentExecutionId !== record.id
      || dependency.runOrdinal !== batch.runOrdinal
      || dependency.toolCallId !== call.toolCallId
      || dependency.childSessionId !== suspension.childSessionId
      || dependency.childExecutionId !== suspension.childExecutionId
    ) {
      await this.#terminalizeSuspendedForInspection(
        input.workspaceRoot,
        parentStore.getState().rootSessionId,
        input.sessionId,
        record,
        "Suspended child dependency has no exact durable child intent",
      );
      return;
    }
    if (dependency.kind === "child_launch") {
      const dependencyStartedAt = record.runs.at(-1)?.endedAt ?? record.startedAt;
      parentStore.setState((state) => ({
        toolBatches: state.toolBatches.map((candidate) =>
          candidate.batchId !== batch.batchId
            ? candidate
            : {
                ...candidate,
                calls: candidate.calls.map((candidateCall) =>
                  candidateCall.toolCallId !== call!.toolCallId
                    ? candidateCall
                    : {
                        ...candidateCall,
                        state: "child_dependency",
                        childDependency: {
                          ...dependency!,
                          kind: "child_dependency",
                          dependencyStartedAt,
                        },
                      }
                ),
              }
        ),
      }));
      await this.#config.flushSessionStore(input.sessionId, input.workspaceRoot);
      const refreshedBatch = parentStore.getState().toolBatches.find((candidate) => candidate.batchId === batch.batchId)!;
      call = refreshedBatch.calls.find((candidate) => candidate.toolCallId === suspension.toolCallId);
      dependency = call?.childDependency;
    }
    if (call === undefined || dependency?.kind !== "child_dependency" || dependency.outcome !== undefined) return;

    let childStore = this.#config.getSessionStore(dependency.childSessionId, input.workspaceRoot);
    if (childStore === undefined) {
      childStore = await this.#config.loadSessionStore(dependency.childSessionId, input.workspaceRoot).catch((error) => {
        if (isMissingSessionError(error)) return undefined;
        throw error;
      });
    }

    if (childStore === undefined) {
      if (call.toolName === "resume_session") {
        await this.#config.applyChildDependencyOutcome({
          workspaceRoot: input.workspaceRoot,
          parentSessionId: input.sessionId,
          parentExecutionId: record.id,
          parentToolBatchId: batch.batchId,
          parentToolCallId: call.toolCallId,
          childSessionId: dependency.childSessionId,
          childExecutionId: dependency.childExecutionId,
          outcome: {
            outcome: "terminal",
            executionId: dependency.childExecutionId,
            executionStatus: "failed",
            terminalError: `Child Session "${dependency.childSessionId}" does not exist`,
          },
        });
        return;
      }
      if (call.toolName !== "delegate") {
        throw new Error(`Unsupported child intent tool "${call.toolName}"`);
      }
      const request = DelegationRequestSchema.parse(call.input);
      const handle = await this.#startChildExecution(input.workspaceRoot, {
        parentStore,
        parentSessionId: input.sessionId,
        parentExecutionId: record.id,
        parentRunOrdinal: batch.runOrdinal,
        parentToolBatchId: batch.batchId,
        parentToolCallId: call.toolCallId,
        childSessionId: dependency.childSessionId,
        childExecutionId: dependency.childExecutionId,
        toolName: "delegate",
        request,
      });
      void handle.result.catch((error) => {
        this.#logger.warn("session.child_dependency.recovered_launch_failed", {
          error,
          context: { sessionId: dependency!.childSessionId },
          meta: { workspaceRoot: input.workspaceRoot },
        });
      });
      return;
    }

    let childExecution = childStore.getState().executions.find((candidate) =>
      candidate.id === dependency!.childExecutionId
    );
    if (childExecution === undefined) {
      if (call.toolName === "delegate") {
        const request = DelegationRequestSchema.parse(call.input);
        const handle = await this.#startChildExecution(input.workspaceRoot, {
          parentStore,
          parentSessionId: input.sessionId,
          parentExecutionId: record.id,
          parentRunOrdinal: batch.runOrdinal,
          parentToolBatchId: batch.batchId,
          parentToolCallId: call.toolCallId,
          childSessionId: dependency.childSessionId,
          childExecutionId: dependency.childExecutionId,
          toolName: "delegate",
          request,
        });
        void handle.result.catch((error) => {
          this.#logger.warn("session.child_dependency.recovered_start_failed", {
            error,
            context: { sessionId: dependency!.childSessionId },
            meta: { workspaceRoot: input.workspaceRoot },
          });
        });
        return;
      }
      if (call.toolName === "resume_session") {
        const resume = ResumeSessionInputSchema.parse(call.input);
        const handle = await this.#resumeChildExecution(input.workspaceRoot, {
          parentStore,
          parentSessionId: input.sessionId,
          parentExecutionId: record.id,
          parentRunOrdinal: batch.runOrdinal,
          parentToolBatchId: batch.batchId,
          parentToolCallId: call.toolCallId,
          toolName: "resume_session",
          sessionId: dependency.childSessionId,
          childExecutionId: dependency.childExecutionId,
          instruction: resume.instruction,
          background: resume.background,
        });
        void handle.result.catch((error) => {
          this.#logger.warn("session.child_dependency.recovered_resume_failed", {
            error,
            context: { sessionId: dependency!.childSessionId },
            meta: { workspaceRoot: input.workspaceRoot },
          });
        });
        return;
      }
      throw new Error(`Unsupported child intent tool "${call.toolName}"`);
    }

    if (childExecution.status === "running" || childExecution.status === "suspended") {
      await this.reconcileDurableSession({
        slug: input.slug,
        workspaceRoot: input.workspaceRoot,
        sessionId: dependency.childSessionId,
      });
      childExecution = childStore.getState().executions.find((candidate) =>
        candidate.id === dependency!.childExecutionId
      );
    }
    if (childExecution === undefined || childExecution.status === "running" || childExecution.status === "suspended") return;
    const childLinkStatus = childLinkStatusFromExecution(childExecution);
    if (childLinkStatus !== undefined) {
      await this.#updateChildSessionLinkForExecution(
        input.workspaceRoot,
        dependency.childSessionId,
        childLinkStatus,
      );
    }
    const outcome = toChildExecutionOutcome(childStore, dependency.childExecutionId);
    if (outcome.outcome !== "terminal") return;
    await this.#config.applyChildDependencyOutcome({
      workspaceRoot: input.workspaceRoot,
      parentSessionId: input.sessionId,
      parentExecutionId: record.id,
      parentToolBatchId: batch.batchId,
      parentToolCallId: call.toolCallId,
      childSessionId: dependency.childSessionId,
      childExecutionId: dependency.childExecutionId,
      outcome,
    });
  }

  async #startCheckedExecution(input: InternalStartSessionExecutionInput): Promise<ActiveSessionExecution> {
    this.#assertWorkspaceOpen(input.workspaceRoot);
    const pendingToken = Symbol(`checked-session-start:${input.sessionId}`);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.#pendingCheckedStarts.set(pendingToken, {
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      completion,
      resolveCompletion,
    });
    try {
      input.admissionSignal?.throwIfAborted();
      const store = await this.#config.loadSessionStore(input.sessionId, input.workspaceRoot);
      input.admissionSignal?.throwIfAborted();
      const loadedState = store.getState();
      if (this.getSessionFamilyActivity(input.workspaceRoot, loadedState.rootSessionId) === "stopping") {
        throw new SessionFamilyStopInProgressError(input.sessionId, loadedState.rootSessionId);
      }
      this.#assertExecutionOriginReady(input, loadedState);
      if (loadedState.parentSessionId !== undefined) {
        await this.#validateExistingChildActivation(input.workspaceRoot, store);
        input.admissionSignal?.throwIfAborted();
      }
      if (input.input.kind !== "resume") {
        await this.#config.validateToolAuthorization({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.sessionId,
          authorization: normalizeToolAuthorizationSnapshot(input.extraTools, input.toolProjection),
        });
        input.admissionSignal?.throwIfAborted();
      }
      const claimedScope = executionScopeSnapshot(store.getState());
      const validateAndStart = async (): Promise<ActiveSessionExecution> => {
        const validationState = store.getState();
        const validationScope = executionScopeSnapshot(validationState);
        if (!sameExecutionScopeSnapshot(claimedScope, validationScope)) {
          throw executionScopeChanged(validationState.sessionId, claimedScope, validationScope);
        }
        const claimAfterValidation = async (): Promise<ActiveSessionExecution> => {
          input.admissionSignal?.throwIfAborted();
          const currentState = store.getState();
          const currentScope = executionScopeSnapshot(currentState);
          if (!sameExecutionScopeSnapshot(validationScope, currentScope)) {
            throw executionScopeChanged(currentState.sessionId, validationScope, currentScope);
          }
          if (this.#config.getSessionStore(currentState.sessionId, input.workspaceRoot) !== store) {
            throw executionScopeChanged(currentState.sessionId, validationScope, currentScope, ["sessionRegistration"]);
          }
          this.#assertSessionFamilyCwdAligned(input.workspaceRoot, input.sessionId, currentState);
          const activity = this.getSessionFamilyActivity(input.workspaceRoot, currentState.rootSessionId);
          if (activity === "stopping") {
            throw new SessionFamilyStopInProgressError(input.sessionId, currentState.rootSessionId);
          }
          const isResume = input.input.kind === "resume";
          const isChildQueue = input.input.kind === "queue" && currentState.parentSessionId !== undefined;
          if (activity === "running" && !isResume && !isChildQueue) {
            throw new SessionFamilyActiveError(input.sessionId, currentState.rootSessionId, activity);
          }
          if (!isResume && !isChildQueue) {
            const toolBatchHitlIds = await this.#config.listSessionFamilyToolBatchHitlIds(input.workspaceRoot, currentState.rootSessionId);
            if (toolBatchHitlIds.length > 0) {
              throw new SessionToolBatchActiveError(input.sessionId, [...toolBatchHitlIds]);
            }
            const activityAfterBlockerRead = this.getSessionFamilyActivity(input.workspaceRoot, currentState.rootSessionId);
            if (activityAfterBlockerRead !== "idle") {
              throw new SessionFamilyActiveError(input.sessionId, currentState.rootSessionId, activityAfterBlockerRead);
            }
            const postBlockerState = store.getState();
            const postBlockerScope = executionScopeSnapshot(postBlockerState);
            if (!sameExecutionScopeSnapshot(currentScope, postBlockerScope)) {
              throw executionScopeChanged(postBlockerState.sessionId, currentScope, postBlockerScope);
            }
            if (this.#config.getSessionStore(postBlockerState.sessionId, input.workspaceRoot) !== store) {
              throw executionScopeChanged(postBlockerState.sessionId, currentScope, postBlockerScope, ["sessionRegistration"]);
            }
          }

          // Deliberately no await between the final identity check and this claim.
          input.admissionSignal?.throwIfAborted();
          return this.#claimExecution(input);
        };

        if (validationState.parentSessionId !== undefined) {
          return await this.#validateExistingChildActivation(
            input.workspaceRoot,
            store,
            async () => await claimAfterValidation(),
          );
        }
        await this.#config.executionScopeValidator.validate({
          projectRoot: input.workspaceRoot,
          subject: await resolveSessionExecutionIdentity({
            workspaceRoot: input.workspaceRoot,
            sessionId: validationState.sessionId,
            sessions: {
              getOrLoad: this.#config.loadSessionStore,
              buildSessionTree: this.#config.buildSessionTree,
            },
          }),
        });
        return await claimAfterValidation();
      };

      return await validateAndStart();
    } finally {
      const pending = this.#pendingCheckedStarts.get(pendingToken);
      this.#pendingCheckedStarts.delete(pendingToken);
      pending?.resolveCompletion();
    }
  }

  async stopSessionFamily(workspaceRoot: string, rootSessionId: string): Promise<void> {
    const state = this.#config.getSessionStore(rootSessionId, workspaceRoot)?.getState();
    if (state !== undefined && (state.parentSessionId !== undefined || state.rootSessionId !== rootSessionId)) {
      throw new NotRootSessionError(rootSessionId, state.parentSessionId ?? state.rootSessionId);
    }
    const lease = this.acquireSessionFamilyStop({
      workspaceRoot,
      rootSessionId,
    });
    try {
      await lease.stopAndWait();
    } finally {
      lease.release();
    }
  }

  acquireSessionFamilyStop(input: AcquireSessionFamilyStopInput): SessionFamilyStopLease {
    this.#assertWorkspaceOpen(input.workspaceRoot);
    const key = scopedKey(input.workspaceRoot, input.rootSessionId);
    if (this.#familyStops.has(key)) {
      throw new SessionFamilyStopInProgressError(input.exemptSessionId ?? input.rootSessionId, input.rootSessionId);
    }
    if (this.#deletions.has(key)) {
      throw new SessionDeleteInProgressError(input.exemptSessionId ?? input.rootSessionId, input.rootSessionId);
    }

    const token = Symbol(`session-family-stop:${key}`);
    const hadActiveFamily = this.getSessionFamilyActivity(input.workspaceRoot, input.rootSessionId) !== "idle";
    const hadActiveRootExecution = this.#active.has(key);
    const rootState = this.#config.getSessionStore(input.rootSessionId, input.workspaceRoot)?.getState();
    const queueDispatchBarrierAt = input.exemptSessionId === undefined
      && hadActiveFamily
      && !hadActiveRootExecution
      && rootState !== undefined
      ? nextSessionTimestamp(rootState)
      : undefined;
    this.#familyStops.set(key, {
      token,
      workspaceRoot: input.workspaceRoot,
      rootSessionId: input.rootSessionId,
      ...(input.exemptSessionId === undefined ? {} : { exemptSessionId: input.exemptSessionId }),
    });
    this.#publishSessionRuntimeChange(input.workspaceRoot, input.rootSessionId);
    let released = false;
    return {
      rootSessionId: input.rootSessionId,
      stopAndWait: async () => {
        if (released || this.#familyStops.get(key)?.token !== token) {
          throw new SessionFamilyStopInProgressError(input.exemptSessionId ?? input.rootSessionId, input.rootSessionId);
        }
        const stopFactPersistence = input.exemptSessionId === undefined && hadActiveFamily && hadActiveRootExecution
          ? this.#recordUserStop(input.workspaceRoot, input.rootSessionId)
          : undefined;
        const queueBarrierPersistence = queueDispatchBarrierAt === undefined
          ? undefined
          : this.#config.sessionInputService.recordQueueDispatchBarrier({
            sessionId: input.rootSessionId,
            workspaceRoot: input.workspaceRoot,
            timestamp: queueDispatchBarrierAt,
          });
        const stopping = this.#stopSessionFamily(input.workspaceRoot, input.rootSessionId, input.exemptSessionId);
        await Promise.all([
          stopping,
          ...(stopFactPersistence === undefined ? [] : [stopFactPersistence]),
          ...(queueBarrierPersistence === undefined ? [] : [queueBarrierPersistence]),
        ]);
        if (input.exemptSessionId === undefined) {
          await this.#terminalizeSuspendedFamily(
            input.workspaceRoot,
            input.rootSessionId,
            "Session family cancelled",
          );
        }
        if (input.exemptSessionId === undefined) {
          await this.#config.sessionInputService.rollbackSteers({
            sessionId: input.rootSessionId,
            workspaceRoot: input.workspaceRoot,
          });
        }
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.#familyStops.get(key)?.token === token) {
          this.#familyStops.delete(key);
          this.#publishSessionRuntimeChange(input.workspaceRoot, input.rootSessionId);
        }
      },
    };
  }

  /** Linearization gate used by project removal before it inspects live families. */
  acquireWorkspaceClose(workspaceRoot: string): SessionWorkspaceCloseLease {
    this.#assertWorkspaceOpen(workspaceRoot);
    if (this.#workspaceClosures.has(workspaceRoot)) {
      throw new SessionWorkspaceClosingError(workspaceRoot);
    }
    const token = Symbol(`session-workspace-close:${workspaceRoot}`);
    this.#workspaceClosures.set(workspaceRoot, token);
    let released = false;
    return {
      workspaceRoot,
      release: () => {
        if (released) return;
        released = true;
        if (this.#workspaceClosures.get(workspaceRoot) === token) {
          this.#workspaceClosures.delete(workspaceRoot);
        }
      },
    };
  }

  assertWorkspaceOpen(workspaceRoot: string): void {
    this.#assertWorkspaceOpen(workspaceRoot);
  }

  /**
   * Keeps a durable root-Session input mutation from crossing Session deletion
   * or workspace teardown. It is deliberately not Session runtime activity:
   * Queue admission must not make an idle family appear to be executing.
   */
  async runSessionInputMutation<T>(input: {
    readonly workspaceRoot: string;
    readonly rootSessionId: string;
  }, mutate: () => Promise<T>): Promise<T> {
    let release: () => Promise<void>;
    while (true) {
      const admission = this.#tryAcquireSessionInputMutation(input.workspaceRoot, input.rootSessionId);
      if (admission.kind === "acquired") {
        release = admission.release;
        break;
      }
      await admission.control.completion;
    }
    try {
      return await mutate();
    } finally {
      await release();
    }
  }

  /**
   * Runs a root-scoped control transition only when no user-input mutation has
   * already claimed the family.  Conversely, a later input waits for this
   * short section to settle.  This gives review completion and input admission
   * one explicit ordering point without creating a second execution owner.
   */
  async tryRunSessionFamilyControl<T>(input: {
    readonly workspaceRoot: string;
    readonly rootSessionId: string;
  }, operation: () => Promise<T>): Promise<{ readonly kind: "executed"; readonly result: T } | { readonly kind: "blocked" }> {
    this.#assertWorkspaceOpen(input.workspaceRoot);
    const key = scopedKey(input.workspaceRoot, input.rootSessionId);
    if ((this.#pendingSessionInputMutations.get(key)?.mutations.size ?? 0) > 0) {
      return { kind: "blocked" };
    }
    if (this.getSessionFamilyActivity(input.workspaceRoot, input.rootSessionId) !== "idle") {
      return { kind: "blocked" };
    }

    const token = Symbol(`session-family-control:${key}`);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    this.#familyControls.set(key, {
      token,
      workspaceRoot: input.workspaceRoot,
      rootSessionId: input.rootSessionId,
      completion,
      resolveCompletion,
    });
    this.#publishSessionRuntimeChange(input.workspaceRoot, input.rootSessionId);
    try {
      return { kind: "executed", result: await operation() };
    } finally {
      if (this.#familyControls.get(key)?.token === token) {
        const control = this.#familyControls.get(key)!;
        this.#familyControls.delete(key);
        control.resolveCompletion();
        this.#publishSessionRuntimeChange(input.workspaceRoot, input.rootSessionId);
      }
    }
  }

  async abortAll(): Promise<void> {
    const executions = [...this.#active.values()];
    const commands = [...this.#activeCommands.values()];
    for (const execution of executions) this.#cancelExecution(execution, "Session cancelled");
    for (const command of commands) command.abortController.abort(new Error("Session cancelled"));
    await Promise.allSettled([
      ...executions.map((execution) => execution.promise),
      ...commands.map((command) => command.completion),
    ]);
  }

  async runRuntimeMutation<T>(
    workspaceRoot: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#assertWorkspaceOpen(workspaceRoot);
    const token = Symbol("runtime-mutation");
    this.#runtimeMutations.add(token);
    try {
      return await operation();
    } finally {
      this.#runtimeMutations.delete(token);
    }
  }

  /**
   * Atomically closes every new execution and control-plane admission only
   * when the Runtime is idle. A busy Runtime remains fully open.
   */
  closeAdmissionIfIdle(): RuntimeMaintenanceAdmission {
    if (!this.#acceptingExecutions) {
      throw new SessionExecutionManagerShuttingDownError();
    }
    this.#acceptingExecutions = false;
    const activeFamilyCount = this.listSessionFamilyActivities().length;
    const hasUnpublishedWork = this.#active.size > 0
      || this.#activeCommands.size > 0
      || this.#childSlots.size > 0
      || this.#cwdTransitions.size > 0
      || this.#pendingChildLaunches.size > 0
      || this.#deletions.size > 0
      || this.#familyStops.size > 0
      || this.#subtreeStops.size > 0
      || this.#workspaceClosures.size > 0
      || this.#pendingCheckedStarts.size > 0
      || this.#pendingSessionInputMutations.size > 0
      || this.#familyControls.size > 0
      || this.#runtimeMutations.size > 0;
    if (hasUnpublishedWork) {
      this.#acceptingExecutions = true;
      return {
        ready: false,
        activeFamilyCount: Math.max(1, activeFamilyCount),
      };
    }
    return { ready: true };
  }

  /**
   * Permanently closes Runtime-owned execution admission, drains checked starts
   * that entered before the close, then cancels every execution they claimed.
   */
  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#acceptingExecutions = false;
    this.#shutdownPromise = (async () => {
      while (this.#pendingCheckedStarts.size > 0) {
        await Promise.allSettled(
          [...this.#pendingCheckedStarts.values()].map((pending) => pending.completion),
        );
      }
      await this.abortAll();
    })();
    return this.#shutdownPromise;
  }

  getSessionFamilyActivity(workspaceRoot: string, rootSessionId: string): SessionFamilyActivity {
    const key = scopedKey(workspaceRoot, rootSessionId);
    if (this.#familyStops.has(key)) return "stopping";
    const durable = [...this.#durableNonterminal.values()].filter((entry) =>
      entry.workspaceRoot === workspaceRoot && entry.rootSessionId === rootSessionId
    );
    if (durable.some((entry) => entry.suspension.kind !== "resume_pending")) return "waiting_for_human";
    if ((this.#pendingChildLaunches.get(key)?.launches.size ?? 0) > 0) return "running";
    if (this.#familyControls.has(key)) return "running";
    if (this.#activeCommands.has(key)) return "running";
    for (const execution of this.#active.values()) {
      if (execution.workspaceRoot === workspaceRoot && execution.rootSessionId === rootSessionId) return "running";
    }
    if (durable.length > 0) return "resuming";
    return "idle";
  }

  listSessionFamilyActivities(): readonly SessionRuntimeChange[] {
    const families = new Map<string, { workspaceRoot: string; rootSessionId: string }>();
    for (const execution of this.#active.values()) {
      if (!execution.ready) continue;
      const key = scopedKey(execution.workspaceRoot, execution.rootSessionId);
      families.set(key, { workspaceRoot: execution.workspaceRoot, rootSessionId: execution.rootSessionId });
    }
    for (const pending of this.#pendingChildLaunches.values()) {
      const key = scopedKey(pending.workspaceRoot, pending.rootSessionId);
      families.set(key, { workspaceRoot: pending.workspaceRoot, rootSessionId: pending.rootSessionId });
    }
    for (const command of this.#activeCommands.values()) {
      const key = scopedKey(command.workspaceRoot, command.rootSessionId);
      families.set(key, { workspaceRoot: command.workspaceRoot, rootSessionId: command.rootSessionId });
    }
    for (const stop of this.#familyStops.values()) {
      const key = scopedKey(stop.workspaceRoot, stop.rootSessionId);
      families.set(key, { workspaceRoot: stop.workspaceRoot, rootSessionId: stop.rootSessionId });
    }
    for (const [key, control] of this.#familyControls) {
      families.set(key, { workspaceRoot: control.workspaceRoot, rootSessionId: control.rootSessionId });
    }
    for (const durable of this.#durableNonterminal.values()) {
      const key = scopedKey(durable.workspaceRoot, durable.rootSessionId);
      families.set(key, {
        workspaceRoot: durable.workspaceRoot,
        rootSessionId: durable.rootSessionId,
      });
    }
    return [...families.values()]
      .map(({ workspaceRoot, rootSessionId }) => ({
        workspaceRoot,
        rootSessionId,
        activity: this.getSessionFamilyActivity(workspaceRoot, rootSessionId),
        ...(this.getSteerTargetExecutionId(workspaceRoot, rootSessionId) === undefined ? {} : {
          steerTargetExecutionId: this.getSteerTargetExecutionId(workspaceRoot, rootSessionId),
        }),
      }))
      .filter((family) => family.activity !== "idle")
      .sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot)
        || left.rootSessionId.localeCompare(right.rootSessionId));
  }

  listPendingCheckedStarts(workspaceRoot: string): readonly { sessionId: string }[] {
    return [...this.#pendingCheckedStarts.values()]
      .filter((pending) => pending.workspaceRoot === workspaceRoot)
      .map(({ sessionId }) => ({ sessionId }));
  }

  listPendingSessionInputMutations(workspaceRoot: string): readonly { rootSessionId: string }[] {
    return [...this.#pendingSessionInputMutations.values()]
      .filter((pending) => pending.workspaceRoot === workspaceRoot && pending.mutations.size > 0)
      .map(({ rootSessionId }) => ({ rootSessionId }));
  }

  subscribeSessionRuntimeChanges(listener: SessionRuntimeChangeListener): () => void {
    this.#runtimeChangeListeners.add(listener);
    return () => {
      this.#runtimeChangeListeners.delete(listener);
    };
  }

  getExecution(workspaceRoot: string, sessionId: string): ActiveSessionExecution | undefined {
    const execution = this.#active.get(scopedKey(workspaceRoot, sessionId));
    return execution?.promise ? execution as ActiveSessionExecution : undefined;
  }

  snapshotActiveExecutionIds(
    workspaceRoot: string,
    rootSessionId: string,
  ): ReadonlyMap<string, string> {
    const snapshot = new Map<string, string>();
    for (const execution of this.#active.values()) {
      if (
        execution.ready
        && execution.workspaceRoot === workspaceRoot
        && execution.rootSessionId === rootSessionId
      ) snapshot.set(execution.sessionId, execution.executionId);
    }
    return snapshot;
  }

  getSteerTargetExecutionId(workspaceRoot: string, rootSessionId: string): string | undefined {
    if (this.#familyStops.has(scopedKey(workspaceRoot, rootSessionId))) return undefined;
    const execution = this.#active.get(scopedKey(workspaceRoot, rootSessionId));
    return execution?.ready === true && execution.messageGateOpen
      ? execution.executionId
      : undefined;
  }

  async steerQueuedMessage(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly messageId: string;
    readonly expectedRevision: number;
    readonly expectedExecutionId: string;
  }): Promise<PendingSessionMessage> {
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    const execution = this.#active.get(key);
    if (
      execution === undefined
      || execution.executionId !== input.expectedExecutionId
      || !execution.ready
      || !execution.messageGateOpen
    ) throw new SessionSteerUnavailableError(input.sessionId, input.expectedExecutionId);

    let operation!: Promise<void>;
    let claimed: PendingSessionMessage | undefined;
    operation = (async () => {
      const pending = (await this.#config.sessionInputService.getPendingMessages(
        input.sessionId,
        input.workspaceRoot,
      )).find((message) => message.id === input.messageId);
      if (pending === undefined || pending.revision !== input.expectedRevision || pending.state !== "queued") {
        throw new SessionSteerUnavailableError(input.sessionId, input.expectedExecutionId);
      }
      const steerState = this.#config.getSessionStore(input.sessionId, input.workspaceRoot)?.getState();
      if (steerState === undefined) throw new SessionFamilyIdentityUnavailableError(input.sessionId);
      const steerBinding = this.#config.modelSelectionResolver.resolve({
        snapshot: this.#config.modelRuntime.current,
        profile: resolveSessionProfile(steerState),
        requested: pending.requestedModelSelection,
        sessionOverride: resolveDurableSessionModelOverride(steerState),
      });
      if (!sameModelSelection(steerBinding.summary.selection, execution.binding.summary.selection)) {
        throw new SessionSteerUnavailableError(input.sessionId, input.expectedExecutionId);
      }
      claimed = await this.#config.sessionInputService.claimSteer({
        ...input,
        runOrdinal: execution.runOrdinal,
        modelAudit: modelAuditFor(pending.requestedModelSelection, execution.binding),
        claimedAt: Date.now(),
      });
      const current = this.#active.get(key);
      if (
        current?.executionToken !== execution.executionToken
        || !current.ready
        || !current.messageGateOpen
      ) {
        await this.#config.sessionInputService.rollbackSteers({
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          executionId: input.expectedExecutionId,
          messageIds: [claimed.id],
        });
        throw new SessionSteerUnavailableError(input.sessionId, input.expectedExecutionId);
      }
      current.steerMailbox.push({
        pending: claimed,
        modelAudit: modelAuditFor(claimed.requestedModelSelection, execution.binding),
      });
    })().finally(() => {
      execution.messageOperations.delete(operation);
    });
    execution.messageOperations.add(operation);
    await operation;
    return claimed!;
  }

  /**
   * Linearized parent-to-direct-child message admission. The operation joins
   * the target Execution's gate before durable acceptance, so terminalization
   * cannot decide Queue continuation or emit a terminal reminder first.
   */
  async sendMessageToChild(
    workspaceRoot: string,
    request: ParentAgentMessageRequest,
  ): Promise<ParentAgentMessageResult> {
    const childStore = await this.#config.loadSessionStore(request.sessionId, workspaceRoot)
      .catch(() => { throw new ChildSessionNotFoundError(workspaceRoot, request.sessionId); });
    const childState = childStore.getState();
    if (childState.parentSessionId !== request.parentSessionId) {
      throw new ChildSessionParentMismatchError(
        request.sessionId,
        request.parentSessionId,
        childState.parentSessionId,
      );
    }
    if (request.parentStore !== this.#config.getSessionStore(request.parentSessionId, workspaceRoot)) {
      throw new SessionMessageAdmissionError("Parent Session store is not the canonical durable parent");
    }
    if (
      request.parentStore.getState().rootSessionId !== childState.rootSessionId
      || request.parentStore.getState().agentName !== request.parentAgentName
    ) {
      throw new SessionMessageAdmissionError("Parent and child Session lineage changed during message admission");
    }

    const provenance: ParentAgentMessageProvenance = {
      senderSessionId: request.parentSessionId,
      senderAgentName: request.parentAgentName,
      senderExecutionId: request.parentExecutionId,
      senderRunOrdinal: request.parentRunOrdinal,
      senderToolBatchId: request.parentToolBatchId,
      senderToolCallId: request.parentToolCallId,
    };
    const replay = await this.#config.sessionInputService.getParentAgentMessageReplay({
      sessionId: request.sessionId,
      workspaceRoot,
      text: request.message,
      clientRequestId: request.clientRequestId,
      expectedExecutionId: request.expectedExecutionId,
      delivery: request.delivery,
      provenance,
    });
    if (replay !== undefined) {
      const canonical = childStore.getState().messages.find((message) => message.id === replay.messageId);
      if (canonical !== undefined) {
        const delivery = canonical.executionId === request.expectedExecutionId ? "steered" : "queued";
        if (delivery === "steered") {
          await this.#registerCanonicalParentAgentLinks(
            workspaceRoot,
            childStore,
            request.expectedExecutionId,
          );
        }
        return {
          sessionId: request.sessionId,
          executionId: request.expectedExecutionId,
          messageId: replay.messageId,
          delivery,
        };
      }
      const live = this.#active.get(scopedKey(workspaceRoot, request.sessionId));
      if (replay.message?.state === "steering" && live?.executionId !== request.expectedExecutionId) {
        await this.#config.sessionInputService.rollbackSteers({
          sessionId: request.sessionId,
          workspaceRoot,
          executionId: request.expectedExecutionId,
          messageIds: [replay.messageId],
        });
      }
      if (live?.executionId === request.expectedExecutionId && replay.message?.state === "steering") {
        const delivery = await waitForMessageDisposition(
          childStore,
          replay.messageId,
          request.expectedExecutionId,
          live.promise ?? Promise.resolve(),
        );
        return {
          sessionId: request.sessionId,
          executionId: request.expectedExecutionId,
          messageId: replay.messageId,
          delivery,
        };
      }
      return {
        sessionId: request.sessionId,
        executionId: request.expectedExecutionId,
        messageId: replay.messageId,
        delivery: "queued",
      };
    }

    const key = scopedKey(workspaceRoot, request.sessionId);
    const execution = this.#active.get(key);
    if (
      execution === undefined
      || execution.executionId !== request.expectedExecutionId
      || !execution.ready
      || !execution.messageGateOpen
    ) {
      throw new SessionSteerUnavailableError(request.sessionId, request.expectedExecutionId);
    }
    let operation!: Promise<ParentAgentMessageResult>;
    const operationSettled = new Promise<void>((resolve) => {
      operation = (async (): Promise<ParentAgentMessageResult> => {
        const acceptance = await this.#config.sessionInputService.acceptParentAgentMessage({
          sessionId: request.sessionId,
          workspaceRoot,
          text: request.message,
          clientRequestId: request.clientRequestId,
          expectedExecutionId: request.expectedExecutionId,
          delivery: request.delivery,
          provenance,
          requestedModelSelection: effectiveDirectRequest(undefined, execution.binding),
          signal: execution.abortController.signal,
        });

        if (acceptance.status === "canonical") {
          const canonical = childStore.getState().messages.find((message) => message.id === acceptance.messageId);
          const delivery = canonical?.executionId === request.expectedExecutionId ? "steered" : "queued";
          if (delivery === "steered") {
            await this.#registerCanonicalParentAgentLinks(
              workspaceRoot,
              childStore,
              request.expectedExecutionId,
            );
          }
          return {
            sessionId: request.sessionId,
            executionId: request.expectedExecutionId,
            messageId: acceptance.messageId,
            delivery,
          };
        }

        if (request.delivery === "steer" && acceptance.message !== undefined) {
          try {
            await this.steerQueuedMessage({
              workspaceRoot,
              sessionId: request.sessionId,
              messageId: acceptance.messageId,
              expectedRevision: acceptance.message.revision,
              expectedExecutionId: request.expectedExecutionId,
            });
          } catch (error) {
            if (!(error instanceof SessionSteerUnavailableError)) throw error;
          }
        }

        const canonical = childStore.getState().messages.find((message) => message.id === acceptance.messageId);
        const delivery = canonical?.executionId === request.expectedExecutionId ? "steered" : "queued";
        if (delivery === "steered") {
          await this.#registerCanonicalParentAgentLinks(
            workspaceRoot,
            childStore,
            request.expectedExecutionId,
          );
        }
        return {
          sessionId: request.sessionId,
          executionId: request.expectedExecutionId,
          messageId: acceptance.messageId,
          delivery,
        };
      })().finally(() => {
        resolve();
      });
    });
    execution.messageOperations.add(operationSettled);
    let result: ParentAgentMessageResult;
    try {
      result = await operation;
    } finally {
      await operationSettled;
      execution.messageOperations.delete(operationSettled);
    }
    if (request.delivery !== "steer" || result.delivery === "steered") return result;
    const delivery = await waitForMessageDisposition(
      childStore,
      result.messageId,
      request.expectedExecutionId,
      execution.promise ?? Promise.resolve(),
    );
    if (delivery === "steered") {
      await this.#registerCanonicalParentAgentLinks(
        workspaceRoot,
        childStore,
        request.expectedExecutionId,
      );
    }
    return { ...result, delivery };
  }

  /**
   * Acquires the root-scoped transition lease spanning Git preparation and the
   * Session cwd CAS. Child launch reservations use the same key, closing the
   * check-to-update race in both directions.
   */
  acquireSessionCwdTransition(workspaceRoot: string, sessionId: string): () => void {
    return this.#acquireSessionCwdTransition(workspaceRoot, sessionId, false);
  }

  /** Control-plane lease: requires the root Session to be idle and blocks every new execution. */
  acquireIdleSessionCwdTransition(workspaceRoot: string, sessionId: string): () => void {
    return this.#acquireSessionCwdTransition(workspaceRoot, sessionId, true);
  }

  /**
   * Atomically acquires a stable set of idle root-family leases from the
   * caller's perspective. If any family is busy, earlier acquisitions are
   * released before the error escapes.
   */
  acquireIdleSessionFamilyCwdTransitions(
    workspaceRoot: string,
    rootSessionIds: readonly string[],
  ): () => void {
    const releases: Array<() => void> = [];
    try {
      for (const rootSessionId of [...new Set(rootSessionIds)].sort((left, right) => left.localeCompare(right))) {
        releases.push(this.acquireIdleSessionCwdTransition(workspaceRoot, rootSessionId));
      }
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  }

  #acquireSessionCwdTransition(
    workspaceRoot: string,
    sessionId: string,
    blockRootExecution: boolean,
  ): () => void {
    this.#assertWorkspaceOpen(workspaceRoot);
    const key = scopedKey(workspaceRoot, sessionId);
    if (this.#familyStops.has(key)) {
      throw new SessionFamilyStopInProgressError(sessionId, sessionId);
    }
    if (this.#deletions.has(key)) {
      throw new SessionDeleteInProgressError(sessionId, sessionId);
    }
    if (this.#cwdTransitions.has(key)) {
      throw new SessionCwdTransitionInProgressError(sessionId, sessionId);
    }

    const conflictingSessionIds = new Set(
      [...(this.#pendingChildLaunches.get(key)?.launches.values() ?? [])].map((launch) => launch.sessionId),
    );
    if (blockRootExecution && this.#activeCommands.has(key)) {
      conflictingSessionIds.add(sessionId);
    }
    for (const execution of this.#active.values()) {
      if (execution.workspaceRoot !== workspaceRoot) continue;
      if (execution.sessionId === sessionId) {
        if (blockRootExecution) conflictingSessionIds.add(sessionId);
        continue;
      }
      const state = this.#config.getSessionStore(execution.sessionId, workspaceRoot)?.getState();
      if (state?.rootSessionId === sessionId || this.#isDescendantOf(workspaceRoot, execution.sessionId, sessionId)) {
        conflictingSessionIds.add(execution.sessionId);
      }
    }
    if (conflictingSessionIds.size > 0) {
      throw new SessionCwdTransitionConflictError(sessionId, [...conflictingSessionIds].sort());
    }

    const token = Symbol(`session-cwd-transition:${key}`);
    this.#cwdTransitions.set(key, { token, blockRootExecution });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#cwdTransitions.get(key)?.token === token) this.#cwdTransitions.delete(key);
    };
  }

  async startChildExecution(workspaceRoot: string, request: ChildExecutionRequest): Promise<ChildExecutionHandle> {
    await this.#assertFamilyToolBatchReady(workspaceRoot, request.parentStore.getState());
    return await this.#startChildExecution(workspaceRoot, request);
  }

  async #startChildExecution(
    workspaceRoot: string,
    request: ChildExecutionRequest,
  ): Promise<ChildExecutionHandle> {
    const factory = this.#config.sessionAgentManager.getFactory(workspaceRoot);
    const currentDepth = await this.#config.resolveSessionDepth(workspaceRoot, request.parentSessionId);
    const parentAgentName = request.parentStore.getState().agentName;
    const parentState = request.parentStore.getState();
    const targetAgentName = request.request.agent_type as AgentName;
    const parentDefinition = factory.getDefinition(parentAgentName);
    const delegationCapabilities = factory.resolveDelegationCapabilities(parentAgentName, currentDepth);
    const targetCapability = delegationCapabilities.targets.find((target) => target.agentName === targetAgentName);
    if (targetCapability === undefined) {
      throw new DelegateTargetNotAllowedError(parentAgentName, targetAgentName, currentDepth);
    }

    const targetDefinition = factory.getDefinition(targetAgentName);
    const configuredChildPolicy = parentDefinition.childPolicy;
    if (configuredChildPolicy === undefined) {
      throw new AgentChildPolicyMissingError(parentAgentName);
    }
    const childPolicy = configuredChildPolicy;

    const validatedRequest = request.request;
    if (!targetCapability.profiles.includes(validatedRequest.profile)) {
      throw new DelegationExecutionAdmissionError(
        "DELEGATION_PROFILE_NOT_ALLOWED",
        `${targetDefinition.displayName} does not allow Profile "${validatedRequest.profile}"`,
      );
    }
    const childSessionId = request.childSessionId;
    const childLaunch = this.#reserveChildLaunch(
      workspaceRoot,
      parentState.rootSessionId,
      request.parentSessionId,
      childSessionId,
    );
    const releaseChildLaunch = childLaunch.release;
    let childLaunchReserved = true;
    let activeSkillNames: readonly string[];
    try {
      activeSkillNames = await factory.resolveDelegatedSkillNames(
        targetCapability,
        validatedRequest.skills,
        parentState.cwd,
      );
      childLaunch.signal.throwIfAborted();
      await this.#validateProspectiveChildExecutionScope(
        workspaceRoot,
        parentState,
        childSessionId,
        targetDefinition.name,
      );
      childLaunch.signal.throwIfAborted();
      await this.#assertFamilyToolBatchReady(workspaceRoot, parentState);
      childLaunch.signal.throwIfAborted();
    } catch (error) {
      releaseChildLaunch();
      childLaunchReserved = false;
      throw error;
    }
    const childPrompt = validatedRequest.objective;
    let childSlotReserved = false;
    const background = validatedRequest.background;
    const childTitle = validatedRequest.title;
    const createdAt = Date.now();
    let childStore: StoreApi<SessionStoreState> | undefined;
    let childLinked = false;
    let execution: ActiveSessionExecution | undefined;
    let newlyActivatedAgent: Agent | undefined;

    try {
      this.#reserveChildSlot(workspaceRoot, request.parentSessionId, childPolicy.maxConcurrent);
      childSlotReserved = true;
      childLaunch.markSlotReserved();
      childStore = this.#config.getSessionStore(childSessionId, workspaceRoot);
      if (childStore === undefined) {
        childStore = this.#config.createSessionStore(childSessionId, workspaceRoot, {
          cwd: parentState.cwd,
          rootSessionId: parentState.rootSessionId,
          parentSessionId: request.parentSessionId,
          agentName: targetDefinition.name,
          title: childTitle,
          activeSkillNames,
          delegationRequest: validatedRequest,
        });
      } else {
        const existing = childStore.getState();
        if (
          existing.executions.length > 0
          || existing.parentSessionId !== request.parentSessionId
          || existing.rootSessionId !== parentState.rootSessionId
          || existing.cwd !== parentState.cwd
          || existing.agentName !== targetDefinition.name
          || existing.title !== childTitle
          || JSON.stringify(existing.delegationRequest) !== JSON.stringify(validatedRequest)
          || JSON.stringify(existing.activeSkillNames) !== JSON.stringify(activeSkillNames)
        ) {
          throw new DelegationExecutionAdmissionError(
            "DELEGATION_IDENTITY_REQUIRED",
            `Precreated child Session "${childSessionId}" does not match its durable launch intent`,
          );
        }
        await this.#validateExistingChildActivation(workspaceRoot, childStore);
      }
      await this.#config.flushSessionStore(childSessionId, workspaceRoot);
      childLaunch.signal.throwIfAborted();

      const cachedAgent = this.#config.sessionAgentManager.get(workspaceRoot, childSessionId);
      this.#config.sessionAgentManager.createChildAgent({
        workspaceRoot,
        sessionId: childSessionId,
        store: childStore,
        depth: currentDepth + 1,
      });
      const activatedAgent = this.#config.sessionAgentManager.get(workspaceRoot, childSessionId);
      if (cachedAgent !== activatedAgent) newlyActivatedAgent = activatedAgent;

      await this.#config.validateToolAuthorization({
        workspaceRoot,
        sessionId: childSessionId,
        authorization: normalizeToolAuthorizationSnapshot(undefined, undefined),
      });
      childLaunch.signal.throwIfAborted();

      execution = this.#claimExecution({
        slug: "",
        workspaceRoot,
        sessionId: childSessionId,
        input: {
          kind: "direct",
          text: childPrompt,
        },
        origin: "tool_call",
        executionId: request.childExecutionId,
        activeTimeoutMs: childPolicy.timeoutMs > 0 ? childPolicy.timeoutMs : undefined,
      }, newlyActivatedAgent);
      newlyActivatedAgent = undefined;
      this.#attachChildSlotOwnership(execution, request.parentSessionId);
      childLaunch.takeReservedSlot();
      childSlotReserved = false;
      await execution.started;
      this.#supersedeChildReminders(request.parentStore, childSessionId);
      this.#appendChildLinkStatus(workspaceRoot, request, childSessionId, request.request.agent_type, currentDepth + 1, "running", childTitle, createdAt, background);
      childLinked = true;
      releaseChildLaunch();
      childLaunchReserved = false;
    } catch (error) {
      if (execution !== undefined) {
        this.#cancelExecution(execution, "Child Session link failed");
        await execution.promise.catch(() => undefined);
      }
      if (
        newlyActivatedAgent !== undefined
        && this.#config.sessionAgentManager.get(workspaceRoot, childSessionId) === newlyActivatedAgent
      ) {
        this.#config.sessionAgentManager.releaseAgent(workspaceRoot, childSessionId);
      }
      if (childLaunchReserved) releaseChildLaunch();
      if (childSlotReserved && childLaunch.takeReservedSlot()) {
        await this.#releaseChildSlot(workspaceRoot, request.parentSessionId);
      }
      if (execution !== undefined) await this.#releaseExecutionChildSlot(execution);
      if (childStore !== undefined) {
        if (childLinked) {
          this.#appendChildLinkStatus(workspaceRoot, request, childSessionId, request.request.agent_type, currentDepth + 1, "failed", childTitle, createdAt, background);
          await this.#config.flushSessionStore(request.parentSessionId, workspaceRoot);
        } else {
          this.#config.deleteSessionStore(childSessionId, workspaceRoot);
          await rm(getSessionDir(workspaceRoot, childSessionId), { recursive: true, force: true });
        }
      }
      throw error;
    }

    if (execution === undefined) throw new Error(`Child Session "${childSessionId}" did not claim execution`);

    const timeout = scheduleActiveExecutionTimeout(
      childStore.getState(),
      execution,
      this.#deadlineScheduler,
    );
    const removeParentAbort = childPolicy.abortCascade
      ? wireAbortCascade(request.parentAbort, execution.abortController)
      : () => {};

    const result = execution.promise
      .then(() => toChildExecutionOutcome(childStore, execution.executionId))
      .then(async (outcome) => {
        if (
          !background
          && outcome.outcome === "terminal"
          && hasExactChildDependency(request.parentStore.getState(), {
            parentExecutionId: request.parentExecutionId,
            parentRunOrdinal: request.parentRunOrdinal,
            parentToolBatchId: request.parentToolBatchId,
            parentToolCallId: request.parentToolCallId,
            childSessionId,
            childExecutionId: request.childExecutionId,
          })
        ) {
          await this.#config.applyChildDependencyOutcome({
            workspaceRoot,
            parentSessionId: request.parentSessionId,
            parentExecutionId: request.parentExecutionId,
            parentToolBatchId: request.parentToolBatchId,
            parentToolCallId: request.parentToolCallId,
            childSessionId,
            childExecutionId: request.childExecutionId,
            outcome,
          });
        }
        return outcome;
      })
      .finally(async () => {
        if (timeout !== undefined) this.#deadlineScheduler.cancel(timeout);
        removeParentAbort();
        await this.#releaseExecutionChildSlot(execution);
        const current = this.#active.get(scopedKey(workspaceRoot, childSessionId));
        if (current !== undefined && current.executionToken !== execution.executionToken) return;
        const settledExecution = childStore.getState().executions.find((candidate) => candidate.id === execution.executionId);
        const status = childTerminalStatus(settledExecution, execution.abortController.signal);
        this.#appendChildLinkStatus(workspaceRoot, request, childSessionId, request.request.agent_type, currentDepth + 1, status, childTitle, createdAt, background);
        await this.#updateAllChildLinksForExecution(
          workspaceRoot,
          childSessionId,
          execution.executionId,
          status,
        );
        if (await this.#continueQueuedChildChain(workspaceRoot, childStore, settledExecution)) return;
        if (background && childPolicy.terminalReminders && status !== "waiting_for_human") {
          appendTerminalReminder(request.parentStore, childSessionId, request.childExecutionId, status, settledExecution?.error);
        }
      });

    return {
      sessionId: childSessionId,
      executionId: execution.executionId,
      store: childStore,
      result,
      abort: () => this.#cancelExecution(execution, "Sub-agent aborted"),
    };
  }

  /** Keeps the original delegate link aligned with a cold-started batch execution. */
  async #appendQueuedChildLinks(
    workspaceRoot: string,
    admission: ExistingChildActivationAdmission,
    execution: ActiveSessionExecution,
  ): Promise<void> {
    const childState = this.#config.getSessionStore(execution.sessionId, workspaceRoot)?.getState();
    const delegation = childState?.delegationRequest;
    if (childState === undefined || delegation === undefined || childState.title === null) {
      throw new DelegationExecutionAdmissionError(
        "DELEGATION_IDENTITY_REQUIRED",
        `Queued child Session "${execution.sessionId}" has no durable delegation identity`,
      );
    }
    this.#supersedeChildReminders(admission.parentStore, execution.sessionId);
    this.#appendQueuedChildLinksFromSources({
      parentStore: admission.parentStore,
      parentSessionId: admission.parentState.sessionId,
      childState,
      childExecutionId: execution.executionId,
      childDepth: admission.childDepth,
      sources: (execution as PendingSessionExecution).queueSnapshots?.map((snapshot) => ({
        acceptedAt: snapshot.pending.acceptedAt,
        source: snapshot.pending.source,
        provenance: snapshot.pending.parentAgentProvenance,
      })) ?? [],
    });
    await this.#config.flushSessionStore(admission.parentState.sessionId, workspaceRoot);
  }

  #appendQueuedChildLinksFromSources(input: {
    readonly parentStore: StoreApi<SessionStoreState>;
    readonly parentSessionId: string;
    readonly childState: SessionStoreState;
    readonly childExecutionId: string;
    readonly childDepth: number;
    readonly sources: readonly {
      readonly acceptedAt: number;
      readonly source: SessionMessageSource | undefined;
      readonly provenance: ParentAgentMessageProvenance | undefined;
    }[];
  }): number {
    const delegation = input.childState.delegationRequest;
    if (delegation === undefined || input.childState.title === null) return 0;
    const seen = new Set<string>();
    let appended = 0;
    for (const message of input.sources) {
      const provenance = message.provenance;
      if (
        message.source !== "parent_agent"
        || provenance === undefined
        || provenance.senderSessionId !== input.parentSessionId
      ) continue;
      const provenanceKey = parentAgentProvenanceKey(provenance);
      if (seen.has(provenanceKey)) continue;
      seen.add(provenanceKey);
      if (input.parentStore.getState().childSessionLinks.some((link) =>
        link.toolName === "send_message"
        && link.parentToolCallId === provenance.senderToolCallId
        && link.childSessionId === input.childState.sessionId
        && link.childExecutionId === input.childExecutionId
      )) continue;
      const execution = input.childState.executions.find((candidate) => (
        candidate.id === input.childExecutionId
      ));
      const status = childLinkStatusFromExecution(execution) ?? "running";
      const now = Date.now();
      input.parentStore.getState().append({
        type: "tool-child-session-link",
        link: {
          parentSessionId: input.parentSessionId,
          parentToolCallId: provenance.senderToolCallId,
          toolName: "send_message",
          childSessionId: input.childState.sessionId,
          childExecutionId: input.childExecutionId,
          childAgentName: delegation.agent_type,
          childProfile: delegation.profile,
          childSkillNames: [...input.childState.activeSkillNames],
          title: input.childState.title,
          depth: input.childDepth,
          background: true,
          status,
          createdAt: message.acceptedAt,
          startedAt: execution?.startedAt ?? now,
          ...(execution?.endedAt === undefined ? {} : { endedAt: execution.endedAt }),
          ...(execution?.durationMs === undefined ? {} : {
            durationMs: execution.durationMs,
            durationUpdatedAt: now,
          }),
          ...(execution?.error === undefined ? {} : { error: execution.error }),
        },
      });
      appended += 1;
    }
    return appended;
  }

  async #registerCanonicalParentAgentLinks(
    workspaceRoot: string,
    childStore: StoreApi<SessionStoreState>,
    childExecutionId: string,
  ): Promise<void> {
    const childState = childStore.getState();
    const parentSessionId = childState.parentSessionId;
    if (parentSessionId === undefined) return;
    const sources = childState.messages.flatMap((message) => (
      message.role === "user"
      && message.executionId === childExecutionId
      && message.inputSource === "parent_agent"
      && message.parentAgentProvenance?.senderSessionId === parentSessionId
        ? [{
            acceptedAt: message.createdAt,
            source: message.inputSource,
            provenance: message.parentAgentProvenance,
          }]
        : []
    ));
    if (sources.length === 0) return;
    const parentStore = await this.#config.loadSessionStore(parentSessionId, workspaceRoot);
    const sendMessageSources = sources.filter(({ provenance }) => !parentStore.getState().childSessionLinks.some((link) =>
      (link.toolName === "delegate" || link.toolName === "resume_session")
      && link.parentToolCallId === provenance.senderToolCallId
      && link.childSessionId === childState.sessionId
      && link.childExecutionId === childExecutionId
    ));
    if (sendMessageSources.length === 0) return;
    const childDepth = await this.#config.resolveSessionDepth(workspaceRoot, childState.sessionId);
    const currentChildState = childStore.getState();
    const appended = this.#appendQueuedChildLinksFromSources({
      parentStore,
      parentSessionId,
      childState: currentChildState,
      childExecutionId,
      childDepth,
      sources: sendMessageSources,
    });
    if (appended > 0) await this.#config.flushSessionStore(parentSessionId, workspaceRoot);
  }

  #wireExactQueuedSenderAbort(
    workspaceRoot: string,
    admission: ExistingChildActivationAdmission,
    execution: ActiveSessionExecution,
  ): () => void {
    const exactSender = (execution as PendingSessionExecution).queueSnapshots
      ?.map((snapshot) => snapshot.pending.parentAgentProvenance)
      .find((provenance) => {
        if (provenance?.senderSessionId !== admission.parentState.sessionId) return false;
        const active = this.#active.get(scopedKey(workspaceRoot, provenance.senderSessionId));
        return active?.ready === true
          && active.executionId === provenance.senderExecutionId
          && active.runOrdinal === provenance.senderRunOrdinal;
      });
    if (exactSender === undefined) return () => {};
    const sender = this.#active.get(scopedKey(workspaceRoot, exactSender.senderSessionId));
    return wireAbortCascade(sender?.abortController.signal, execution.abortController);
  }

  async #recoverQueuedChildLinks(
    workspaceRoot: string,
    childStore: StoreApi<SessionStoreState>,
    childExecutionId: string,
  ): Promise<{
    readonly parentStore: StoreApi<SessionStoreState>;
    readonly parentSessionId: string;
    readonly terminalReminders: boolean;
  } | undefined> {
    const childState = childStore.getState();
    const parentSessionId = childState.parentSessionId;
    if (parentSessionId === undefined) return undefined;
    const parentStore = await this.#config.loadSessionStore(parentSessionId, workspaceRoot);
    const parentState = parentStore.getState();
    const sources = childState.messages.flatMap((message) => {
      const provenance = message.parentAgentProvenance;
      if (
        message.role !== "user"
        || message.executionId !== childExecutionId
        || message.inputSource !== "parent_agent"
        || provenance === undefined
        || provenance.senderSessionId !== parentSessionId
        || !hasExactSendMessageCall(parentState, provenance)
      ) return [];
      return [{
        acceptedAt: message.createdAt,
        source: message.inputSource,
        provenance,
      }];
    });
    if (sources.length === 0) return undefined;
    this.#appendQueuedChildLinksFromSources({
      parentStore,
      parentSessionId,
      childState,
      childExecutionId,
      childDepth: await this.#config.resolveSessionDepth(workspaceRoot, childState.sessionId),
      sources,
    });
    await this.#config.flushSessionStore(parentSessionId, workspaceRoot);
    const terminalReminders = this.#config.sessionAgentManager
      .getFactory(workspaceRoot)
      .getDefinition(parentState.agentName)
      .childPolicy?.terminalReminders === true;
    return { parentStore, parentSessionId, terminalReminders };
  }

  /** A completed child Execution is not terminal to its parent while its Queue chain can continue. */
  async #continueQueuedChildChain(
    workspaceRoot: string,
    childStore: StoreApi<SessionStoreState>,
    settledExecution: SessionExecutionRecord | undefined,
  ): Promise<boolean> {
    if (settledExecution?.status !== "completed" || settledExecution.stopRequestedAt !== undefined) return false;
    const live = this.#active.get(scopedKey(workspaceRoot, childStore.getState().sessionId));
    if (live !== undefined && live.executionId !== settledExecution.id) return true;

    const state = childStore.getState();
    const latest = state.executions.at(-1);
    if (latest?.id !== settledExecution.id) return true;
    const queued = state.pendingMessages.filter((message) => message.state === "queued");
    if (
      queued.length === 0
      || !queueDispatchEligible(settledExecution, queued, state.queueDispatchBarrierAt)
    ) return false;

    await this.tryStartQueuedExecution({
      slug: "",
      workspaceRoot,
      sessionId: state.sessionId,
    });
    // Permanent admission failures publish queue_dispatch_blocked. Temporary
    // admission leaves the durable Queue for Runtime retry. Neither is a
    // terminal result for the completed intermediate Execution.
    return true;
  }

  async #watchQueuedChildExecution(
    workspaceRoot: string,
    execution: ActiveSessionExecution,
    admission: ExistingChildActivationAdmission,
    timeout: SessionExecutionDeadlineHandle | undefined,
    removeParentAbort: () => void,
    forcedSettlement: Promise<void>,
  ): Promise<void> {
    try {
      await Promise.race([execution.promise, forcedSettlement]);
      await this.#releaseExecutionChildSlot(execution);
      const childStore = await this.#config.loadSessionStore(execution.sessionId, workspaceRoot);
      const record = childStore.getState().executions.find((candidate) => candidate.id === execution.executionId);
      const status = childTerminalStatus(record, execution.abortController.signal);
      await this.#updateAllChildLinksForExecution(workspaceRoot, execution.sessionId, execution.executionId, status);
      if (await this.#continueQueuedChildChain(workspaceRoot, childStore, record)) return;

      if (admission.childPolicy.terminalReminders && status !== "waiting_for_human") {
        appendTerminalReminder(admission.parentStore, execution.sessionId, execution.executionId, status, record?.error);
        await this.#config.flushSessionStore(admission.parentState.sessionId, workspaceRoot);
      }
    } catch (error) {
      this.#logger.error("session.child_queue.watch_failed", {
        error,
        context: { sessionId: execution.sessionId, executionId: execution.executionId },
        meta: { workspaceRoot },
      });
    } finally {
      if (timeout !== undefined) this.#deadlineScheduler.cancel(timeout);
      removeParentAbort();
    }
  }

  async #updateAllChildLinksForExecution(
    workspaceRoot: string,
    childSessionId: string,
    childExecutionId: string,
    status: SubAgentExecutionStatus,
  ): Promise<void> {
    const childStore = await this.#config.loadSessionStore(childSessionId, workspaceRoot);
    const childState = childStore.getState();
    const parentSessionId = childState.parentSessionId;
    if (parentSessionId === undefined) return;
    const parentStore = await this.#config.loadSessionStore(parentSessionId, workspaceRoot);
    const record = childState.executions.find((candidate) => candidate.id === childExecutionId);
    const now = Date.now();
    const links = parentStore.getState().childSessionLinks.filter((link) =>
      link.childSessionId === childSessionId
      && link.childExecutionId === childExecutionId
      && !isTerminalChildSessionStatus(link.status)
    );
    for (const link of links) {
      parentStore.getState().append({
        type: "tool-child-session-link",
        link: {
          ...link,
          status,
          ...(record?.startedAt === undefined ? {} : { startedAt: record.startedAt }),
          ...(record?.endedAt === undefined ? {} : { endedAt: record.endedAt }),
          ...(record?.durationMs === undefined ? {} : {
            durationMs: record.durationMs,
            durationUpdatedAt: now,
          }),
          ...(record?.error === undefined ? {} : { error: record.error }),
        },
      });
    }
    if (links.length > 0) await this.#config.flushSessionStore(parentSessionId, workspaceRoot);
  }

  async #updateChildSessionLinkForExecution(
    workspaceRoot: string,
    childSessionId: string,
    status: ToolChildSessionLinkStatus,
  ): Promise<void> {
    const childStore = await this.#config.loadSessionStore(childSessionId, workspaceRoot);
    const childState = childStore.getState();
    const parentSessionId = childState.parentSessionId;
    if (parentSessionId === undefined) return;
    const currentExecution = childState.executions.at(-1);
    if (currentExecution === undefined) return;

    const parentStore = await this.#config.loadSessionStore(parentSessionId, workspaceRoot);
    const exactLinks = parentStore.getState().childSessionLinks.filter((link) =>
      link.childSessionId === childSessionId
      && link.childExecutionId === currentExecution.id
    );
    if (isTerminalChildSessionStatus(status) && exactLinks.length > 0) {
      await this.#updateAllChildLinksForExecution(
        workspaceRoot,
        childSessionId,
        currentExecution.id,
        status,
      );
      if (exactLinks.some((link) => link.background)) {
        const parentDefinition = this.#config.sessionAgentManager
          .getFactory(workspaceRoot)
          .getDefinition(parentStore.getState().agentName);
        if (
          parentDefinition.childPolicy?.terminalReminders
          && !(await this.#continueQueuedChildChain(workspaceRoot, childStore, currentExecution))
        ) {
          appendTerminalReminder(parentStore, childSessionId, currentExecution.id, status, currentExecution.error);
          await this.#config.flushSessionStore(parentSessionId, workspaceRoot);
        }
      }
      return;
    }
    const existing = [...exactLinks]
      .reverse()
      .at(0);
    if (existing === undefined) {
      const exactBatchCall = parentStore.getState().toolBatches
        .flatMap((batch) => batch.calls.map((call) => ({ batch, call })))
        .find(({ call }) =>
          call.childDependency?.childSessionId === childSessionId
          && call.childDependency.childExecutionId === currentExecution.id
        );
      const dependency = exactBatchCall?.call.childDependency;
      const delegation = childState.delegationRequest;
      if (
        exactBatchCall === undefined
        || dependency === undefined
        || delegation === undefined
        || childState.title == null
        || (exactBatchCall.call.toolName !== "delegate" && exactBatchCall.call.toolName !== "resume_session")
      ) {
        this.#logger.warn("session.child_link.batch_missing", {
          context: { sessionId: childSessionId, parentSessionId },
          meta: { workspaceRoot, status },
        });
        return;
      }
      const background = exactBatchCall.call.toolName === "delegate"
        ? DelegationRequestSchema.parse(exactBatchCall.call.input).background
        : ResumeSessionInputSchema.parse(exactBatchCall.call.input).background;
      const depth = await this.#config.resolveSessionDepth(workspaceRoot, childSessionId);
      const durationUpdatedAt = Date.now();
      parentStore.getState().append({
        type: "tool-child-session-link",
        link: {
          parentSessionId,
          parentToolCallId: exactBatchCall.call.toolCallId,
          toolName: exactBatchCall.call.toolName,
          childSessionId,
          childExecutionId: currentExecution.id,
          childAgentName: delegation.agent_type,
          childProfile: delegation.profile,
          childSkillNames: [...childState.activeSkillNames],
          title: childState.title,
          depth,
          background,
          status,
          createdAt: dependency.createdAt,
          startedAt: currentExecution.startedAt,
          ...(currentExecution.endedAt === undefined ? {} : { endedAt: currentExecution.endedAt }),
          ...(currentExecution.durationMs === undefined ? {} : {
            durationMs: currentExecution.durationMs,
            durationUpdatedAt,
          }),
          ...(currentExecution.error === undefined ? {} : { error: currentExecution.error }),
        },
      });
      await this.#config.flushSessionStore(parentSessionId, workspaceRoot);
      return;
    }
    if (isTerminalChildSessionStatus(existing.status)) {
      if (existing.status !== status) {
        throw new Error(
          `Child link ${existing.childExecutionId} is already ${existing.status}, not ${status}`,
        );
      }
      return;
    }

    const now = Date.now();
    const run = currentExecution;
    const {
      startedAt: _startedAt,
      endedAt: _endedAt,
      durationMs: _durationMs,
      durationUpdatedAt: _durationUpdatedAt,
      error: _error,
      ...base
    } = existing;
    const isTerminal = isTerminalChildSessionStatus(status);
    const runMatchesStatus = childLinkStatusFromExecution(run) === status;
    const startedAt = run?.startedAt ?? existing.startedAt;
    const endedAt = isTerminal
      ? runMatchesStatus ? run?.endedAt ?? now : now
      : undefined;
    const openRun = run?.status === "running" ? run.runs.at(-1) : undefined;
    const durationMs = run === undefined
      ? existing.durationMs
      : run.durationMs + (
          openRun !== undefined && openRun.endedAt === undefined
            ? Math.max(0, now - openRun.startedAt)
            : 0
        );
    const durationUpdatedAt = durationMs === undefined ? undefined : now;
    const error = isTerminal && runMatchesStatus ? run?.error : undefined;
    if (
      existing.status === status
      && existing.startedAt === startedAt
      && existing.endedAt === endedAt
      && existing.durationMs === durationMs
      && existing.durationUpdatedAt === durationUpdatedAt
      && existing.error === error
    ) return;
    parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        ...base,
        status,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(endedAt === undefined ? {} : { endedAt }),
        ...(durationMs === undefined ? {} : { durationMs, durationUpdatedAt }),
        ...(error === undefined ? {} : { error }),
      },
    });
    if (isTerminal && existing.background) {
      const parentAgentName = parentStore.getState().agentName;
      const parentDefinition = this.#config.sessionAgentManager.getFactory(workspaceRoot).getDefinition(parentAgentName);
      if (
        parentDefinition.childPolicy?.terminalReminders
        && !(await this.#continueQueuedChildChain(workspaceRoot, childStore, currentExecution))
      ) {
        appendTerminalReminder(parentStore, childSessionId, currentExecution.id, status, currentExecution.error);
      }
    }
    await this.#config.flushSessionStore(parentSessionId, workspaceRoot);
  }

  /** Strong descendant cancellation protected by a temporary subtree lease. */
  async cancelDescendantSession(
    workspaceRoot: string,
    parentSessionId: string,
    childSessionId: string,
  ): Promise<CancelDescendantSessionResult> {
    const targetStore = this.#config.getSessionStore(childSessionId, workspaceRoot)
      ?? await this.#config.loadSessionStore(childSessionId, workspaceRoot)
        .catch(() => { throw new ChildSessionNotFoundError(workspaceRoot, childSessionId); });
    const targetState = targetStore.getState();
    const parentStore = this.#config.getSessionStore(parentSessionId, workspaceRoot)
      ?? await this.#config.loadSessionStore(parentSessionId, workspaceRoot)
        .catch(() => { throw new ChildSessionNotFoundError(workspaceRoot, parentSessionId); });
    if (parentStore.getState().rootSessionId !== targetState.rootSessionId) {
      throw new ChildSessionNotDescendantError(parentSessionId, childSessionId);
    }
    const authorityTree = await this.#config.buildSessionTree(workspaceRoot, targetState.rootSessionId);
    const authorizedDescendants = new Set(collectSessionTreeIds(authorityTree.root, parentSessionId));
    if (childSessionId === parentSessionId || !authorizedDescendants.has(childSessionId)) {
      throw new ChildSessionNotDescendantError(parentSessionId, childSessionId);
    }
    const initialTargetIds = new Set(collectSessionTreeIds(authorityTree.root, childSessionId));
    const leaseKey = scopedKey(workspaceRoot, childSessionId);
    if (this.#subtreeStops.has(leaseKey)) {
      throw new SessionFamilyStopInProgressError(childSessionId, targetState.rootSessionId);
    }
    const token = Symbol(`session-subtree-stop:${leaseKey}`);
    this.#subtreeStops.set(leaseKey, {
      token,
      workspaceRoot,
      rootSessionId: targetState.rootSessionId,
      targetSessionId: childSessionId,
    });

    const immediateExecutions = [...this.#active.values()].filter((execution) =>
      execution.workspaceRoot === workspaceRoot
      && initialTargetIds.has(execution.sessionId)
    );
    let observedWork = immediateExecutions.length > 0;
    for (const execution of immediateExecutions) {
      this.#cancelExecution(execution, "Session subtree cancelled");
    }
    try {
      const deadline = this.#deadlineScheduler.now()
        + (this.#config.sessionFamilyStopTimeoutMs ?? ABORT_AND_WAIT_TIMEOUT_MS);
      while (true) {
        const tree = await this.#config.buildSessionTree(workspaceRoot, targetState.rootSessionId);
        const sessionIds = collectSessionTreeIds(tree.root, childSessionId);
        if (sessionIds.length === 0) {
          throw new ChildSessionNotFoundError(workspaceRoot, childSessionId);
        }
        const sessionIdSet = new Set(sessionIds);
        const executions = [...this.#active.values()].filter((execution) =>
          execution.workspaceRoot === workspaceRoot && sessionIdSet.has(execution.sessionId)
        );
        const launchKey = scopedKey(workspaceRoot, targetState.rootSessionId);
        const launchEntries = [...(this.#pendingChildLaunches
          .get(launchKey)?.launches.entries() ?? [])]
          .filter(([, launch]) =>
            sessionIdSet.has(launch.parentSessionId) || sessionIdSet.has(launch.sessionId)
          );
        const launches = launchEntries.map(([, launch]) => launch);
        if (executions.length > 0 || launches.length > 0) observedWork = true;

        for (const execution of executions) this.#cancelExecution(execution, "Session subtree cancelled");
        for (const sessionId of [...sessionIds].reverse()) {
          const store = await this.#config.loadSessionStore(sessionId, workspaceRoot);
          const suspended = store.getState().executions.at(-1);
          if (suspended?.status === "suspended") {
            observedWork = true;
            await this.#config.cancelSessionToolBatch(sessionId, workspaceRoot, "Session subtree cancelled");
            await this.#terminalizeSuspendedForInspection(
              workspaceRoot,
              targetState.rootSessionId,
              sessionId,
              suspended,
              "Session subtree cancelled",
              "cancelled",
            );
          }
        }

        if (executions.length === 0 && launches.length === 0) {
          const rescanned = [...(this.#pendingChildLaunches
            .get(scopedKey(workspaceRoot, targetState.rootSessionId))?.launches.values() ?? [])]
            .filter((launch) =>
              sessionIdSet.has(launch.parentSessionId) || sessionIdSet.has(launch.sessionId)
            );
          if (rescanned.length === 0) break;
        }

        const remainingMs = deadline - this.#deadlineScheduler.now();
        if (remainingMs <= 0) {
          for (const execution of executions) {
            await this.#forceTerminalizeExecution(execution, "Session subtree cancelled");
          }
          const pendingFamily = this.#pendingChildLaunches.get(launchKey);
          for (const [launchToken, launch] of launchEntries) {
            launch.abortController.abort(new SessionFamilyStopInProgressError(
              launch.sessionId,
              targetState.rootSessionId,
            ));
            this.#config.sessionAgentManager.releaseAgent(workspaceRoot, launch.sessionId);
            if (launch.slotReserved) {
              launch.slotReserved = false;
              await this.#releaseChildSlot(workspaceRoot, launch.parentSessionId);
            }
            pendingFamily?.launches.delete(launchToken);
          }
          if (pendingFamily?.launches.size === 0) this.#pendingChildLaunches.delete(launchKey);
          if (launchEntries.length > 0) {
            this.#publishSessionRuntimeChange(workspaceRoot, targetState.rootSessionId);
          }
          continue;
        }

        const pendingPromises = executions.flatMap((execution) =>
          execution.promise === undefined ? [] : [execution.promise]
        );
        if (pendingPromises.length === 0) {
          await this.#deadlineScheduler.sleep(Math.min(5, remainingMs));
        } else {
          await Promise.race([
            Promise.allSettled(pendingPromises).then(() => undefined),
            this.#deadlineScheduler.sleep(Math.min(5, remainingMs)),
          ]);
        }
      }

      const finalTree = await this.#config.buildSessionTree(workspaceRoot, targetState.rootSessionId);
      const finalSessionIds = collectSessionTreeIds(finalTree.root, childSessionId);
      for (const sessionId of finalSessionIds) {
        const store = await this.#config.loadSessionStore(sessionId, workspaceRoot);
        const state = store.getState();
        const latest = state.executions.at(-1);
        const linkStatus = childLinkStatusFromExecution(latest);
        if (
          state.parentSessionId !== undefined
          && latest !== undefined
          && linkStatus !== undefined
          && linkStatus !== "waiting_for_human"
        ) {
          await this.#updateAllChildLinksForExecution(
            workspaceRoot,
            sessionId,
            latest.id,
            linkStatus,
          );
          const parentStore = await this.#config.loadSessionStore(state.parentSessionId, workspaceRoot);
          const hasBackgroundLink = parentStore.getState().childSessionLinks.some((link) =>
            link.childSessionId === sessionId
            && link.childExecutionId === latest.id
            && link.background
          );
          const parentDefinition = this.#config.sessionAgentManager
            .getFactory(workspaceRoot)
            .getDefinition(parentStore.getState().agentName);
          if (hasBackgroundLink && parentDefinition.childPolicy?.terminalReminders) {
            appendTerminalReminder(parentStore, sessionId, latest.id, linkStatus, latest.error);
            await this.#config.flushSessionStore(state.parentSessionId, workspaceRoot);
          }
        }
        const pending = state.pendingMessages.filter((message) => message.state === "queued");
        if (pending.length > 0 && queueDispatchEligible(
          state.executions.at(-1),
          pending,
          state.queueDispatchBarrierAt,
        )) observedWork = true;
        await this.#config.sessionInputService.rollbackSteers({
          sessionId,
          workspaceRoot,
        });
        await this.#config.sessionInputService.recordQueueDispatchBarrier({
          sessionId,
          workspaceRoot,
          timestamp: nextSessionTimestamp(store.getState()),
        });
      }
      return observedWork ? "cancelled" : "already_stopped";
    } finally {
      if (this.#subtreeStops.get(leaseKey)?.token === token) {
        this.#subtreeStops.delete(leaseKey);
      }
    }
  }

  async resumeChildExecution(workspaceRoot: string, request: ResumeChildRequest): Promise<ChildExecutionHandle> {
    const canonicalChild = await this.#config.loadSessionStore(request.sessionId, workspaceRoot)
      .catch(() => { throw new ChildSessionNotFoundError(workspaceRoot, request.sessionId); });
    const canonicalChildState = canonicalChild.getState();
    if (canonicalChildState.parentSessionId !== request.parentSessionId) {
      throw new ChildSessionParentMismatchError(
        request.sessionId,
        request.parentSessionId,
        canonicalChildState.parentSessionId,
      );
    }
    return await this.#resumeChildExecution(workspaceRoot, request);
  }

  async #assertFamilyToolBatchReady(workspaceRoot: string, state: SessionStoreState): Promise<void> {
    const toolBatchHitlIds = await this.#config.listSessionFamilyToolBatchHitlIds(workspaceRoot, state.rootSessionId);
    if (toolBatchHitlIds.length > 0) throw new SessionToolBatchActiveError(state.sessionId, toolBatchHitlIds);
  }

  async #resumeChildExecution(
    workspaceRoot: string,
    request: ResumeChildRequest,
  ): Promise<ChildExecutionHandle> {
    const key = scopedKey(workspaceRoot, request.sessionId);
    if (this.#active.has(key)) throw new AgentRunningError();

    const childStore = await this.#config.loadSessionStore(request.sessionId, workspaceRoot)
      .catch(() => { throw new ChildSessionNotFoundError(workspaceRoot, request.sessionId); });
    const initialAdmission = await this.#validateExistingChildActivation(workspaceRoot, childStore);
    let childState = initialAdmission.childState;
    await this.#assertFamilyToolBatchReady(workspaceRoot, initialAdmission.parentState);
    this.#assertSessionToolBatchReady(request.sessionId, childState);
    let childTitle = requireCanonicalChildTitle(childState);
    if (childState.parentSessionId !== request.parentSessionId) {
      throw new ChildSessionParentMismatchError(request.sessionId, request.parentSessionId, childState.parentSessionId);
    }
    if (initialAdmission.parentStore !== request.parentStore) {
      throw new DelegationExecutionAdmissionError(
        "DELEGATION_IDENTITY_REQUIRED",
        `Resume parent Store for child Session "${request.sessionId}" is not the canonical durable parent`,
      );
    }
    const parentState = initialAdmission.parentState;

    const background = request.background;
    const childPolicy = initialAdmission.childPolicy;
    const childDepth = initialAdmission.childDepth;
    const existingLink = this.#findChildSessionLink(request.parentStore, request.sessionId);
    const resumeLinkCreatedAt = Date.now();
    const childLaunch = this.#reserveChildLaunch(
      workspaceRoot,
      parentState.rootSessionId,
      request.parentSessionId,
      request.sessionId,
    );
    const releaseChildLaunch = childLaunch.release;
    let childLaunchReserved = true;
    let childSlotReserved = false;
    let newlyActivatedAgent: Agent | undefined;
    let execution: ActiveSessionExecution | undefined;
    try {
      await this.#validateExistingChildActivation(workspaceRoot, childStore, async (finalAdmission) => {
        if (finalAdmission.parentStore !== request.parentStore) {
          throw new DelegationExecutionAdmissionError(
            "DELEGATION_IDENTITY_REQUIRED",
            `Resume parent Store for child Session "${request.sessionId}" is not the canonical durable parent`,
          );
        }
        childState = finalAdmission.childState;
        childTitle = requireCanonicalChildTitle(childState);
        await this.#assertFamilyToolBatchReady(workspaceRoot, finalAdmission.parentState);
        childLaunch.signal.throwIfAborted();
        this.#reserveChildSlot(workspaceRoot, request.parentSessionId, childPolicy.maxConcurrent);
        childSlotReserved = true;
        childLaunch.markSlotReserved();
        const cachedAgent = this.#config.sessionAgentManager.get(workspaceRoot, request.sessionId);
        const activatedAgent = await this.#config.sessionAgentManager.getOrCreate(workspaceRoot, request.sessionId);
        childLaunch.signal.throwIfAborted();
        if (cachedAgent !== activatedAgent) newlyActivatedAgent = activatedAgent;
        await this.#config.validateToolAuthorization({
          workspaceRoot,
          sessionId: request.sessionId,
          authorization: normalizeToolAuthorizationSnapshot(undefined, undefined),
        });
        childLaunch.signal.throwIfAborted();
        execution = this.#claimExecution({
          slug: "",
          workspaceRoot,
          sessionId: request.sessionId,
          input: {
            kind: "child_resume",
            text: request.instruction,
            clientRequestId: `resume:${request.parentSessionId}:${request.parentExecutionId}:${request.parentRunOrdinal}:${request.parentToolBatchId}:${request.parentToolCallId}`,
            provenance: {
              senderSessionId: request.parentSessionId,
              senderAgentName: finalAdmission.parentState.agentName,
              senderExecutionId: request.parentExecutionId,
              senderRunOrdinal: request.parentRunOrdinal,
              senderToolBatchId: request.parentToolBatchId,
              senderToolCallId: request.parentToolCallId,
            },
          },
          origin: "tool_call",
          executionId: request.childExecutionId,
          activeTimeoutMs: childPolicy.timeoutMs > 0 ? childPolicy.timeoutMs : undefined,
        }, newlyActivatedAgent);
        newlyActivatedAgent = undefined;
        this.#attachChildSlotOwnership(execution, request.parentSessionId);
        childLaunch.takeReservedSlot();
        childSlotReserved = false;
        await execution.started;
        this.#supersedeChildReminders(request.parentStore, request.sessionId);
        this.#appendResumeChildLinkStatus(
          workspaceRoot,
          request,
          existingLink,
          childState.delegationRequest!.agent_type,
          childTitle,
          childDepth,
          "running",
          resumeLinkCreatedAt,
        );
        releaseChildLaunch();
        childLaunchReserved = false;
      });
    } catch (error) {
      if (
        newlyActivatedAgent !== undefined
        && this.#config.sessionAgentManager.get(workspaceRoot, request.sessionId) === newlyActivatedAgent
      ) {
        this.#config.sessionAgentManager.releaseAgent(workspaceRoot, request.sessionId);
      }
      if (childLaunchReserved) releaseChildLaunch();
      if (childSlotReserved && childLaunch.takeReservedSlot()) {
        await this.#releaseChildSlot(workspaceRoot, request.parentSessionId);
      }
      if (execution !== undefined) await this.#releaseExecutionChildSlot(execution);
      throw error;
    }

    if (execution === undefined) throw new Error(`Child Session "${request.sessionId}" did not claim execution`);
    const claimedExecution = execution;

    const timeout = scheduleActiveExecutionTimeout(
      childStore.getState(),
      claimedExecution,
      this.#deadlineScheduler,
    );
    const removeParentAbort = childPolicy.abortCascade
      ? wireAbortCascade(request.parentAbort, claimedExecution.abortController)
      : () => {};

    const result = claimedExecution.promise
      .then(() => toChildExecutionOutcome(childStore, claimedExecution.executionId))
      .then(async (outcome) => {
        if (
          !background
          && outcome.outcome === "terminal"
          && hasExactChildDependency(request.parentStore.getState(), {
            parentExecutionId: request.parentExecutionId,
            parentRunOrdinal: request.parentRunOrdinal,
            parentToolBatchId: request.parentToolBatchId,
            parentToolCallId: request.parentToolCallId,
            childSessionId: request.sessionId,
            childExecutionId: request.childExecutionId,
          })
        ) {
          await this.#config.applyChildDependencyOutcome({
            workspaceRoot,
            parentSessionId: request.parentSessionId,
            parentExecutionId: request.parentExecutionId,
            parentToolBatchId: request.parentToolBatchId,
            parentToolCallId: request.parentToolCallId,
            childSessionId: request.sessionId,
            childExecutionId: request.childExecutionId,
            outcome,
          });
        }
        return outcome;
      })
      .finally(async () => {
        if (timeout !== undefined) this.#deadlineScheduler.cancel(timeout);
        removeParentAbort();
        await this.#releaseExecutionChildSlot(claimedExecution);
        const current = this.#active.get(scopedKey(workspaceRoot, request.sessionId));
        if (current !== undefined && current.executionToken !== claimedExecution.executionToken) return;
        const settledExecution = childStore.getState().executions.find((candidate) => candidate.id === claimedExecution.executionId);
        const status = childTerminalStatus(settledExecution, claimedExecution.abortController.signal);
        this.#appendResumeChildLinkStatus(
          workspaceRoot,
          request,
          existingLink,
          childState.delegationRequest!.agent_type,
          childTitle,
          childDepth,
          status,
          resumeLinkCreatedAt,
        );
        await this.#updateAllChildLinksForExecution(
          workspaceRoot,
          request.sessionId,
          claimedExecution.executionId,
          status,
        );
        if (await this.#continueQueuedChildChain(workspaceRoot, childStore, settledExecution)) return;
        if (background && childPolicy.terminalReminders && status !== "waiting_for_human") {
          appendTerminalReminder(request.parentStore, request.sessionId, request.childExecutionId, status, settledExecution?.error);
        }
      });

    return {
      sessionId: request.sessionId,
      executionId: claimedExecution.executionId,
      store: childStore,
      result,
      abort: () => this.#cancelExecution(claimedExecution, "Sub-agent aborted"),
    };
  }

  async deleteSession(workspaceRoot: string, sessionId: string): Promise<void> {
    const rootSessionId = await this.#config.resolveRootSessionId(sessionId, workspaceRoot);
    const releaseDeletion = this.#acquireSessionDeletion(workspaceRoot, rootSessionId, sessionId);
    try {
      const tree = await this.#config.buildSessionTree(workspaceRoot, rootSessionId);
      const sessionIds = collectSessionTreeIds(tree.root, sessionId);

      if (sessionIds.length === 0) {
        throw new Error(`Session "${sessionId}" was not found in tree rooted at "${rootSessionId}"`);
      }

      const stuckSessionIds = await this.#cancelAndWaitForSessions(workspaceRoot, sessionIds);
      if (stuckSessionIds.length > 0) {
        throw new SessionDeleteConflictError(stuckSessionIds);
      }

      await this.#config.deletionLifecycle?.prepareForDeletion({ workspaceRoot, rootSessionId, sessionIds });

      for (const id of sessionIds) {
        this.#config.sessionAgentManager.dispose(workspaceRoot, id);
        this.#config.untrackSession(workspaceRoot, id);
        const snapshotPrefix = `${scopedKey(workspaceRoot, id)}\0`;
        for (const key of this.#executionSkillSnapshots.keys()) {
          if (key.startsWith(snapshotPrefix)) this.#executionSkillSnapshots.delete(key);
        }
      }

      for (const id of sessionIds) {
        await rm(getSessionDir(workspaceRoot, id), { recursive: true, force: true });
      }
      for (const id of sessionIds) this.#config.deleteSessionStore(id, workspaceRoot);
      if (sessionId === rootSessionId) {
        this.#config.deleteSessionStore(rootSessionId, workspaceRoot, { forgetWorkspaceIndex: true });
      }
    } finally {
      releaseDeletion();
    }
  }

  async #applySettlements(
    input: Parameters<SessionExecutionManagerConfig["onExecutionSettlement"]>[0],
  ): Promise<void> {
    await this.#config.onExecutionSettlement(input);
  }

  async #terminalizeSuspendedForInspection(
    workspaceRoot: string,
    rootSessionId: string,
    sessionId: string,
    record: Extract<SessionExecutionRecord, { status: "suspended" }>,
    error: string,
    terminalStatus: "interrupted" | "cancelled" = "interrupted",
  ): Promise<void> {
    const store = await this.#config.loadSessionStore(sessionId, workspaceRoot);
    const lastRunEndedAt = record.runs.at(-1)?.endedAt ?? record.startedAt;
    const endedAt = Math.max(Date.now(), lastRunEndedAt);
    const goalInstanceId = await this.#config.resolveGoalInstanceId({
      workspaceRoot,
      rootSessionId,
    });
    const terminalSettlement = {
      key: `terminal:${sessionId}:${record.id}`,
      goalInstanceId,
    };
    store.getState().append({
      type: "execution-end",
      executionId: record.id,
      terminalStatus,
      endedAt,
      terminalSettlement,
      error,
    });
    await this.#config.flushSessionStore(sessionId, workspaceRoot);
    this.#durableNonterminal.delete(scopedKey(workspaceRoot, sessionId));
    this.#executionSkillSnapshots.delete(executionSkillSnapshotKey(workspaceRoot, sessionId, record.id));
    this.#publishSessionRuntimeChange(workspaceRoot, rootSessionId);
    await this.#applySettlements({
      workspaceRoot,
      rootSessionId,
      sessionId,
      executionId: record.id,
      settlements: [{
        ...terminalSettlement,
        kind: "terminal",
        usage: zeroUsage(),
        executionTimeMs: 0,
        terminalStatus,
      }],
    });
    await this.#updateChildSessionLinkForExecution(workspaceRoot, sessionId, terminalStatus);
  }

  async #runExecution(input: InternalStartSessionExecutionInput, execution: PendingSessionExecution): Promise<void> {
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    let store = this.#config.getSessionStore(input.sessionId, input.workspaceRoot);
    let terminalStatus: SessionExecutionTerminalStatus = "completed";
    let terminalError: string | undefined;
    let finalOutputStepId: string | undefined;
    let suspension: Exclude<SessionExecutionSuspension, { kind: "resume_pending" }> | undefined;
    let runEndedAt: number | undefined;
    try {
      if (store === undefined) throw new SessionFamilyIdentityUnavailableError(input.sessionId);
      if (input.input.kind === "resume" && input.recoveryExecutionId === undefined) {
        store.getState().append({
          type: "execution-resumed",
          executionId: execution.executionId,
          runOrdinal: execution.runOrdinal,
          binding: execution.binding.summary,
        });
        await this.#config.flushSessionStore(input.sessionId, input.workspaceRoot);
      }
      execution.executionSkillSnapshots = await this.#resolveExecutionSkillSnapshots(
        input,
        execution,
        store.getState(),
      );
      let executionStart: ExecutionStartEvent | undefined;
      if (input.input.kind !== "resume") {
        const executionSkills: ExecutionSkillBinding[] = [...execution.executionSkillSnapshots.values()].map((snapshot) => ({
          name: snapshot.name,
          source: snapshot.source,
          digest: snapshot.digest,
          resolutionRoot: execution.skillResolutionRoot,
        }));
        executionStart = {
          type: "execution-start",
          executionId: execution.executionId,
          binding: execution.binding.summary,
          executionSkills,
          memoryPolicy: execution.memoryPolicy,
          toolAuthorizationSnapshot: cloneToolAuthorizationSnapshot(execution.toolAuthorizationSnapshot),
          loadedToolRefs: [],
          origin: execution.origin,
          maxSteps: execution.maxSteps,
          ...(input.activeTimeoutMs === undefined ? {} : { activeTimeoutMs: input.activeTimeoutMs }),
        };
        const atomicChildInputStart = input.input.kind === "child_resume"
          || (input.input.kind === "queue" && store.getState().parentSessionId !== undefined);
        if (!atomicChildInputStart) {
          store.getState().append(executionStart);
          await this.#config.flushSessionStore(input.sessionId, input.workspaceRoot);
        }
      }
      if (input.input.kind === "queue") {
        if (execution.queueSnapshots === undefined || execution.queueSnapshots.length === 0) {
          throw new Error(`Queue execution ${execution.executionId} has no resolved input prefix`);
        }
        await this.#config.sessionInputService.beginQueueExecution({
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          executionId: execution.executionId,
          runOrdinal: execution.runOrdinal,
          snapshots: execution.queueSnapshots,
          binding: execution.binding.summary,
          origin: execution.origin,
          ...(executionStart === undefined ? {} : { executionStart }),
          signal: execution.abortController.signal,
        });
      } else if (input.input.kind === "child_resume") {
        if (execution.directRequestedModelSelection === undefined || executionStart === undefined) {
          throw new Error(`Child resume execution ${execution.executionId} has no effective requested model selection`);
        }
        await this.#config.sessionInputService.beginChildResumeExecution({
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          executionId: execution.executionId,
          runOrdinal: execution.runOrdinal,
          snapshots: execution.queueSnapshots ?? [],
          binding: execution.binding.summary,
          instruction: input.input.text,
          clientRequestId: input.input.clientRequestId,
          provenance: input.input.provenance,
          requestedModelSelection: execution.directRequestedModelSelection,
          modelAudit: modelAuditFor(execution.directRequestedModelSelection, execution.binding),
          executionStart,
          signal: execution.abortController.signal,
        });
      } else if (input.input.kind === "direct") {
        if (execution.directRequestedModelSelection === undefined) {
          throw new Error(`Direct execution ${execution.executionId} has no effective requested model selection`);
        }
        await this.#config.sessionInputService.beginDirectExecution({
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          executionId: execution.executionId,
          runOrdinal: execution.runOrdinal,
          text: input.input.text,
          ...(input.input.source === undefined ? {} : { source: input.input.source }),
          ...(input.input.messageId === undefined ? {} : { messageId: input.input.messageId }),
          ...(input.input.clientRequestId === undefined ? {} : { clientRequestId: input.input.clientRequestId }),
          requestedModelSelection: execution.directRequestedModelSelection,
          modelAudit: modelAuditFor(execution.directRequestedModelSelection, execution.binding),
          binding: execution.binding.summary,
          origin: execution.origin,
          signal: execution.abortController.signal,
        });
      }

      execution.ready = true;
      execution.messageGateOpen = true;
      execution.resolveStarted();
      this.#publishSessionRuntimeChange(input.workspaceRoot, execution.rootSessionId);

      for (let transitionCount = 0; transitionCount <= MAX_CWD_TRANSITIONS_PER_EXECUTION; transitionCount += 1) {
        const activationStore = this.#config.getSessionStore(input.sessionId, input.workspaceRoot);
        if (
          activationStore?.getState().parentSessionId !== undefined
          && input.toolProjection === undefined
        ) {
          await this.#validateExistingChildActivation(input.workspaceRoot, activationStore);
        }
        const cachedAgent = this.#config.sessionAgentManager.get(input.workspaceRoot, input.sessionId);
        const agent = await this.#config.sessionAgentManager.getOrCreate(input.workspaceRoot, input.sessionId);
        if (cachedAgent !== agent && execution.newlyActivatedAgent === undefined) {
          execution.newlyActivatedAgent = agent;
        }
        store = agent.store;
        this.#assertSessionStartAllowed(
          input.workspaceRoot,
          input.sessionId,
          agent.store.getState(),
          input.input.kind === "resume",
        );
        if (execution.abortController.signal.aborted) {
          terminalStatus = abortExecutionStatus(execution.abortController.signal);
          return;
        }

        const current = this.#active.get(key);
        if (current?.executionToken !== execution.executionToken) return;

        execution.runAgent = agent;
        let result: AgentResult;
        try {
          const executionRecord = agent.store.getState().executions.find((candidate) =>
            candidate.id === execution.executionId
          );
          if (executionRecord === undefined) {
            throw new Error(`Execution ${execution.executionId} lost its durable tool state before Agent activation`);
          }
          result = await agent.run(execution.binding, {
            abort: execution.abortController.signal,
            executionId: execution.executionId,
            runOrdinal: execution.runOrdinal,
            initialStep: execution.initialStep,
            maxSteps: execution.maxSteps,
            toolAuthorizationSnapshot: cloneToolAuthorizationSnapshot(executionRecord.toolAuthorizationSnapshot),
            loadedToolRefs: cloneLoadedToolRefs(executionRecord.loadedToolRefs),
            reconcileExecutionToolLoads: async (invalidRefs) => {
              await this.#reconcileExecutionToolLoads(
                input.workspaceRoot,
                input.sessionId,
                execution.executionId,
                invalidRefs,
              );
            },
            consumeSteers: async () => await this.#consumeSteers(execution),
            ...(execution.executionSkillSnapshots.size === 0
              ? {}
              : { executionSkillSnapshots: execution.executionSkillSnapshots }),
            memoryPolicy: execution.memoryPolicy,
          });
        } finally {
          execution.runAgent = undefined;
        }
        runEndedAt = Date.now();
        execution.newlyActivatedAgent = undefined;
        if (result.cwdChanged === undefined) {
          if (result.outcome === "suspended") {
            suspension = result.suspension;
          } else {
            terminalStatus = result.status;
            finalOutputStepId = result.status === "completed"
              ? result.finalOutputStepId
              : undefined;
            terminalError = result.error === undefined
              ? undefined
              : execution.binding.modelInfo.redactSensitiveText(result.error);
            if (terminalStatus === "completed" && agent.store.getState().parentSessionId !== undefined) {
              const classification = classifyChildFinalOutput(
                agent.store.getState(),
                execution.executionId,
                finalOutputStepId,
              );
              if (!classification.accepted) {
                terminalStatus = "failed";
                finalOutputStepId = undefined;
                terminalError = classification.error;
              }
            }
          }
          return;
        }
        if (transitionCount === MAX_CWD_TRANSITIONS_PER_EXECUTION) {
          throw new Error(`Session cwd changed more than ${MAX_CWD_TRANSITIONS_PER_EXECUTION} times in one execution`);
        }
        this.#config.sessionAgentManager.releaseAgent(input.workspaceRoot, input.sessionId);
      }
    } catch (error) {
      const safeError = sanitizeBindingError(error, execution.binding);
      if (!execution.ready) execution.rejectStarted(safeError);
      terminalStatus = execution.abortController.signal.aborted
        ? abortExecutionStatus(execution.abortController.signal)
        : "failed";
      terminalError = safeError.message;
      runEndedAt ??= Date.now();
      if (!execution.abortController.signal.aborted) {
        const current = this.#active.get(key);
        if (current?.executionToken !== execution.executionToken) return;
        this.#logger.error("session.execution.failed", {
          error: safeError,
          context: { sessionId: input.sessionId, agentName: execution.agentName, origin: execution.origin },
          meta: { workspaceRoot: input.workspaceRoot },
        });
      }
    } finally {
      this.#releaseNewlyActivatedAgent(execution);
      this.#closeSteerGate(execution);
      await this.#settleSteers(execution, suspension !== undefined);
      if (execution.abortController.signal.aborted) {
        suspension = undefined;
        terminalStatus = abortExecutionStatus(execution.abortController.signal);
        finalOutputStepId = undefined;
      }
      const current = this.#active.get(key);
      if (current?.executionToken === execution.executionToken) {
        store = this.#config.getSessionStore(input.sessionId, input.workspaceRoot) ?? store;
        if (store?.getState().isRunning && store.getState().currentExecutionId === execution.executionId) {
          const canonicalExecution = store.getState().executions.find((candidate) =>
            candidate.id === execution.executionId
          );
          const canonicalRun = canonicalExecution?.runs[execution.runOrdinal];
          if (
            canonicalExecution?.status !== "running"
            || canonicalRun === undefined
            || canonicalRun.endedAt !== undefined
          ) {
            throw new Error(
              `Execution ${execution.executionId} run ${execution.runOrdinal} has no canonical open run`,
            );
          }
          const effectiveRunEndedAt = Math.max(runEndedAt ?? Date.now(), canonicalRun.startedAt);
          const finalUsage = store.getState().stats.usage;
          const runUsageDelta = subtractUsage(finalUsage, execution.initialUsage);
          const goalInstanceId = await this.#config.resolveGoalInstanceId({
            workspaceRoot: input.workspaceRoot,
            rootSessionId: execution.rootSessionId,
          });
          const runSettlement = {
            key: `run:${input.sessionId}:${execution.executionId}:${execution.runOrdinal}`,
            kind: "run" as const,
            runOrdinal: execution.runOrdinal,
            usage: runUsageDelta,
            executionTimeMs: effectiveRunEndedAt - canonicalRun.startedAt,
            goalInstanceId,
          };
          if (suspension === undefined) {
            if (store.getState().toolBatches.some((batch) =>
              batch.archivedAt === undefined
              && batch.executionId === execution.executionId
            )) {
              await this.#config.cancelSessionToolBatch(
                input.sessionId,
                input.workspaceRoot,
                "Execution terminated before its active Tool Batch settled",
              );
            }
            store.getState().append({
              type: "execution-end",
              executionId: execution.executionId,
              terminalStatus,
              ...(terminalStatus === "completed" && finalOutputStepId !== undefined
                ? { finalOutputStepId }
                : {}),
              endedAt: effectiveRunEndedAt,
              runEndedAt: effectiveRunEndedAt,
              runUsageDelta,
              runSettlement: {
                key: runSettlement.key,
                goalInstanceId,
              },
              terminalSettlement: {
                key: `terminal:${input.sessionId}:${execution.executionId}`,
                goalInstanceId,
              },
              ...(terminalError === undefined ? {} : { error: terminalError }),
            });
          } else {
            store.getState().append({
              type: "execution-suspended",
              executionId: execution.executionId,
              suspension,
              runEndedAt: effectiveRunEndedAt,
              runUsageDelta,
              runSettlement: {
                key: runSettlement.key,
                goalInstanceId,
              },
            });
          }
          await this.#config.flushSessionStore(input.sessionId, input.workspaceRoot);
          if (suspension === undefined) {
            this.#durableNonterminal.delete(key);
          } else {
            this.#durableNonterminal.set(key, {
              workspaceRoot: input.workspaceRoot,
              rootSessionId: execution.rootSessionId,
              sessionId: input.sessionId,
              suspension,
            });
          }
          await this.#config.onExecutionSettlement({
            workspaceRoot: input.workspaceRoot,
            rootSessionId: execution.rootSessionId,
            sessionId: input.sessionId,
            executionId: execution.executionId,
            settlements: suspension === undefined
              ? [
                  runSettlement,
                  {
                    key: `terminal:${input.sessionId}:${execution.executionId}`,
                    kind: "terminal",
                    usage: zeroUsage(),
                    executionTimeMs: 0,
                    goalInstanceId,
                    terminalStatus,
                  },
                ]
              : [runSettlement],
          });
          if (suspension !== undefined) {
            this.#config.sessionAgentManager.releaseAgent(input.workspaceRoot, input.sessionId);
          }
        }
      }
    }
  }

  async #resolveExecutionSkillSnapshots(
    input: InternalStartSessionExecutionInput,
    execution: PendingSessionExecution,
    state: SessionStoreState,
  ): Promise<ReadonlyMap<string, SkillPackageSnapshot>> {
    const key = executionSkillSnapshotKey(input.workspaceRoot, input.sessionId, execution.executionId);
    if (input.input.kind === "resume") {
      const cached = this.#executionSkillSnapshots.get(key);
      if (cached !== undefined) return cached;
      const record = state.executions.find((candidate) => candidate.id === execution.executionId);
      if (record === undefined) throw new Error(`Execution ${execution.executionId} is missing its Skill bindings`);
      const restored = new Map<string, SkillPackageSnapshot>();
      const allowedNames = this.#config.sessionAgentManager
        .getFactory(input.workspaceRoot)
        .getDefinition(execution.agentName).skills;
      for (const binding of record.executionSkills) {
        const snapshot = await this.#config.skillService.restoreSnapshotForAgent(
          binding.resolutionRoot,
          binding.name,
          { source: binding.source, digest: binding.digest },
          allowedNames,
        );
        restored.set(binding.name, snapshot);
      }
      if (restored.size > 0) this.#executionSkillSnapshots.set(key, restored);
      return restored;
    }

    const requestedNames = input.input.kind === "queue" || input.input.kind === "child_resume"
      ? [...new Set(execution.queueSnapshots?.flatMap((snapshot) => snapshot.pending.executionSkillNames) ?? [])]
      : [];
    if (requestedNames.length > 1) {
      throw new SessionInputConflictError("state", "A Queue execution may activate only one explicit Skill");
    }
    const snapshots = new Map<string, SkillPackageSnapshot>();
    const allowedNames = this.#config.sessionAgentManager
      .getFactory(input.workspaceRoot)
      .getDefinition(execution.agentName).skills;
    for (const name of requestedNames) {
      const snapshot = await this.#config.skillService.snapshotForAgent(
        execution.skillResolutionRoot,
        name,
        allowedNames,
      );
      if (snapshot === null) throw new SkillNotFoundError(name);
      snapshots.set(name, snapshot);
    }
    if (snapshots.size > 0) this.#executionSkillSnapshots.set(key, snapshots);
    return snapshots;
  }

  async #reconcileExecutionToolLoads(
    workspaceRoot: string,
    sessionId: string,
    executionId: string,
    invalidRefs: readonly LoadedToolRef[],
  ): Promise<void> {
    const invalidKeys = new Set(invalidRefs.map(toolRefKey));
    if (invalidKeys.size === 0) return;
    await this.#config.commitDurableSessionMutation(
      sessionId,
      workspaceRoot,
      (state) => {
        const owner = state.executions.find((candidate) => candidate.id === executionId);
        if (owner === undefined) throw new Error(`Execution ${executionId} has no durable tool-load owner`);
        const removed = owner.loadedToolRefs.filter((ref) => invalidKeys.has(toolRefKey(ref)));
        if (removed.length === 0) return { result: undefined };
        const loadedToolRefs = owner.loadedToolRefs.filter((ref) => !invalidKeys.has(toolRefKey(ref)));
        return {
          result: undefined,
          patch: {
            executions: state.executions.map((record) => record.id === executionId
              ? { ...record, loadedToolRefs }
              : record),
          },
          events: [{
            type: "system-notice",
            message: boundedToolLoadInvalidationNotice(removed),
          }],
        };
      },
    );
  }

  async #consumeSteers(execution: PendingSessionExecution): Promise<void> {
    const current = this.#active.get(scopedKey(execution.workspaceRoot, execution.sessionId));
    if (
      current?.executionToken !== execution.executionToken
      || !execution.ready
      || !execution.messageGateOpen
      || execution.steerMailbox.length === 0
    ) return;
    await this.#commitSteerMailbox(execution);
  }

  async #commitSteerMailbox(execution: PendingSessionExecution): Promise<void> {
    if (execution.steerMailbox.length === 0) return;
    const messages = execution.steerMailbox.splice(0, execution.steerMailbox.length);
    let operation!: Promise<void>;
    operation = this.#config.sessionInputService.commitSteers({
      sessionId: execution.sessionId,
      workspaceRoot: execution.workspaceRoot,
      executionId: execution.executionId,
      runOrdinal: execution.runOrdinal,
      snapshots: messages,
      binding: execution.binding.summary,
      signal: execution.abortController.signal,
    }).then(() => undefined).finally(() => {
      execution.messageOperations.delete(operation);
    });
    execution.messageOperations.add(operation);
    await operation;
  }

  #closeSteerGate(execution: PendingSessionExecution): void {
    if (!execution.messageGateOpen) return;
    execution.messageGateOpen = false;
    this.#publishSessionRuntimeChange(execution.workspaceRoot, execution.rootSessionId);
  }

  async #settleSteers(execution: PendingSessionExecution, commitForToolBatchContinuation: boolean): Promise<void> {
    while (execution.messageOperations.size > 0) {
      await Promise.allSettled([...execution.messageOperations]);
    }
    try {
      if (commitForToolBatchContinuation && !execution.abortController.signal.aborted) {
        await this.#commitSteerMailbox(execution);
      }
    } catch (error) {
      if (!execution.abortController.signal.aborted) throw error;
    } finally {
      execution.steerMailbox.splice(0);
      await this.#config.sessionInputService.rollbackSteers({
        sessionId: execution.sessionId,
        workspaceRoot: execution.workspaceRoot,
        executionId: execution.executionId,
      });
      const childStore = this.#config.getSessionStore(execution.sessionId, execution.workspaceRoot);
      if (childStore !== undefined) {
        await this.#registerCanonicalParentAgentLinks(
          execution.workspaceRoot,
          childStore,
          execution.executionId,
        );
      }
    }
  }

  #releaseNewlyActivatedAgent(execution: PendingSessionExecution): void {
    const agent = execution.newlyActivatedAgent;
    execution.newlyActivatedAgent = undefined;
    if (agent === undefined) return;
    if (this.#config.sessionAgentManager.get(execution.workspaceRoot, execution.sessionId) !== agent) return;
    this.#config.sessionAgentManager.releaseAgent(execution.workspaceRoot, execution.sessionId);
  }

  #finalizeExecution(key: string, execution: PendingSessionExecution): void {
    const ownedFamilyStopLease = execution.familyStopLease;
    execution.familyStopLease = undefined;
    const current = this.#active.get(key);
    const isCurrentExecution = current?.executionToken === execution.executionToken;
    if (isCurrentExecution) {
      this.#active.delete(key);
      if (execution.ready) {
        this.#publishSessionRuntimeChange(execution.workspaceRoot, execution.rootSessionId);
      }
    }
    const record = this.#config
      .getSessionStore(execution.sessionId, execution.workspaceRoot)
      ?.getState().executions.find((candidate) => candidate.id === execution.executionId);
    if (record?.status !== "suspended") {
      this.#executionSkillSnapshots.delete(executionSkillSnapshotKey(
        execution.workspaceRoot,
        execution.sessionId,
        execution.executionId,
      ));
    }

    if (ownedFamilyStopLease !== undefined) {
      void this.#finishExecutionOwnedFamilyStop(execution, ownedFamilyStopLease);
    }
  }

  /**
   * A child self-stop cannot wait for an ancestor that is synchronously waiting
   * on the child's result. Once the child releases its execution generation,
   * this detached tail drains those ancestors while retaining the same family
   * Stop lease, so runtime activity cannot flicker back to running.
   */
  async #finishExecutionOwnedFamilyStop(
    execution: PendingSessionExecution,
    lease: SessionFamilyStopLease,
  ): Promise<void> {
    try {
      await this.#stopSessionFamily(execution.workspaceRoot, execution.rootSessionId, undefined);
    } catch (error) {
      this.#logger.error("session.family_stop.final_drain_failed", {
        error,
        context: { sessionId: execution.sessionId, rootSessionId: execution.rootSessionId },
        meta: { workspaceRoot: execution.workspaceRoot },
      });
    } finally {
      lease.release();
    }
  }

  #cancelExecution(execution: ActiveSessionExecution | PendingSessionExecution, reason: string): void {
    const key = scopedKey(execution.workspaceRoot, execution.sessionId);
    const current = this.#active.get(key);
    if (current?.executionToken !== execution.executionToken) return;

    this.#markParentLinkCancelling(execution.workspaceRoot, execution.sessionId);
    this.#closeSteerGate(execution as PendingSessionExecution);
    execution.abortController.abort(new Error(reason));
  }

  #recordUserStop(workspaceRoot: string, rootSessionId: string): Promise<void> | undefined {
    const active = this.#active.get(scopedKey(workspaceRoot, rootSessionId));
    if (active !== undefined) this.#closeSteerGate(active as PendingSessionExecution);
    const store = this.#config.getSessionStore(rootSessionId, workspaceRoot);
    const state = store?.getState();
    const executionId = active?.executionId ?? state?.executions.at(-1)?.id;
    if (store === undefined || state === undefined || executionId === undefined) return undefined;
    if (!state.executions.some((execution) => execution.id === executionId)) return undefined;
    const stopState = store.getState();
    store.getState().append({
      type: "execution-stop-requested",
      executionId,
      timestamp: nextSessionTimestamp(stopState),
    });
    return this.#config.flushSessionStore(rootSessionId, workspaceRoot);
  }

  async #stopSessionFamily(
    workspaceRoot: string,
    rootSessionId: string,
    exemptSessionId: string | undefined,
  ): Promise<void> {
    const deadline = this.#deadlineScheduler.now()
      + (this.#config.sessionFamilyStopTimeoutMs ?? ABORT_AND_WAIT_TIMEOUT_MS);
    const key = scopedKey(workspaceRoot, rootSessionId);
    const deferredAncestorIds = this.#ancestorSessionIds(workspaceRoot, exemptSessionId);

    while (true) {
      const familyExecutions = [...this.#active.values()].filter((execution) => {
        if (execution.workspaceRoot !== workspaceRoot || execution.sessionId === exemptSessionId) return false;
        return execution.rootSessionId === rootSessionId;
      });
      const executions = familyExecutions.filter((execution) => !deferredAncestorIds.has(execution.sessionId));
      const pendingChildSessionIds = [...(this.#pendingChildLaunches.get(key)?.launches.values() ?? [])]
        .map((launch) => launch.sessionId);
      const command = inputCommandForStop(
        this.#activeCommands.get(key),
        exemptSessionId,
      );

      for (const execution of familyExecutions) this.#cancelExecution(execution, "Session family cancelled");
      command?.abortController.abort(new Error("Session family cancelled"));

      if (executions.length === 0 && pendingChildSessionIds.length === 0 && command === undefined) return;

      const remainingMs = deadline - this.#deadlineScheduler.now();
      if (remainingMs <= 0) {
        await this.#forceTerminalizeStuckFamily({
          workspaceRoot,
          rootSessionId,
          executions,
          command,
          pendingChildSessionIds,
        });
        return;
      }

      const pendingPromises = [
        ...executions.flatMap((execution) => execution.promise === undefined ? [] : [execution.promise]),
        ...(command === undefined ? [] : [command.completion]),
      ];
      if (pendingPromises.length === 0) {
        await this.#deadlineScheduler.sleep(Math.min(5, remainingMs));
      } else {
        await Promise.race([
          Promise.allSettled(pendingPromises).then(() => undefined),
          this.#deadlineScheduler.sleep(Math.min(5, remainingMs)),
        ]);
      }
    }
  }

  async #terminalizeSuspendedFamily(
    workspaceRoot: string,
    rootSessionId: string,
    reason: string,
  ): Promise<void> {
    const suspendedSessionIds = new Set(
      [...this.#durableNonterminal.values()]
        .filter((entry) => entry.workspaceRoot === workspaceRoot && entry.rootSessionId === rootSessionId)
        .map((entry) => entry.sessionId),
    );
    const loadedRoot = this.#config.getSessionStore(rootSessionId, workspaceRoot);
    if (loadedRoot?.getState().executions.some((execution) => execution.status === "suspended")) {
      suspendedSessionIds.add(rootSessionId);
    }
    if (suspendedSessionIds.size === 0) return;
    const tree = await this.#config.buildSessionTree(workspaceRoot, rootSessionId);
    const sessionIds = collectSessionTreeIds(tree.root).reverse();
    for (const sessionId of sessionIds) {
      if (!suspendedSessionIds.has(sessionId)) continue;
      const store = await this.#config.loadSessionStore(sessionId, workspaceRoot);
      const state = store.getState();
      const record = state.executions.find((candidate) => candidate.status === "suspended");
      if (record === undefined) {
        this.#durableNonterminal.delete(scopedKey(workspaceRoot, sessionId));
        this.#publishSessionRuntimeChange(workspaceRoot, rootSessionId);
        continue;
      }
      await this.#config.cancelSessionToolBatch(sessionId, workspaceRoot, reason);
      const goalInstanceId = await this.#config.resolveGoalInstanceId({
        workspaceRoot,
        rootSessionId,
      });
      const terminalSettlement = {
        key: `terminal:${sessionId}:${record.id}`,
        goalInstanceId,
      };
      const endedAt = Math.max(
        Date.now(),
        record.runs.at(-1)?.endedAt ?? record.startedAt,
      );
      store.getState().append({
        type: "execution-end",
        executionId: record.id,
        terminalStatus: "cancelled",
        endedAt,
        terminalSettlement,
        error: reason,
      });
      await this.#config.flushSessionStore(sessionId, workspaceRoot);
      this.#durableNonterminal.delete(scopedKey(workspaceRoot, sessionId));
      this.#executionSkillSnapshots.delete(executionSkillSnapshotKey(workspaceRoot, sessionId, record.id));
      this.#publishSessionRuntimeChange(workspaceRoot, rootSessionId);
      await this.#applySettlements({
        workspaceRoot,
        rootSessionId,
        sessionId,
        executionId: record.id,
        settlements: [{
          ...terminalSettlement,
          kind: "terminal",
          usage: zeroUsage(),
          executionTimeMs: 0,
          terminalStatus: "cancelled",
        }],
      });
      await this.#updateChildSessionLinkForExecution(workspaceRoot, sessionId, "cancelled");
    }
  }

  async #forceTerminalizeStuckFamily(input: {
    readonly workspaceRoot: string;
    readonly rootSessionId: string;
    readonly executions: readonly PendingSessionExecution[];
    readonly command: ActiveSessionCommand | undefined;
    readonly pendingChildSessionIds: readonly string[];
  }): Promise<void> {
    const stuckSessionIds = [...new Set([
      ...input.executions.map((execution) => execution.sessionId),
      ...input.pendingChildSessionIds,
      ...(input.command === undefined ? [] : [input.command.rootSessionId]),
    ])].sort();

    this.#logger.warn("session.family_stop.force_terminalize", {
      context: {
        rootSessionId: input.rootSessionId,
        stuckSessionIds,
      },
      meta: { workspaceRoot: input.workspaceRoot },
    });

    for (const execution of input.executions) {
      await this.#forceTerminalizeExecution(execution, "Session family cancelled");
    }

    if (input.command !== undefined) {
      this.#forceTerminalizeCommand(input.command, "Session family cancelled");
    }

    const launchKey = scopedKey(input.workspaceRoot, input.rootSessionId);
    const pendingLaunches = this.#pendingChildLaunches.get(launchKey);
    if (pendingLaunches !== undefined) {
      for (const launch of pendingLaunches.launches.values()) {
        launch.abortController.abort(new SessionFamilyStopInProgressError(
          launch.sessionId,
          input.rootSessionId,
        ));
        this.#config.sessionAgentManager.releaseAgent(input.workspaceRoot, launch.sessionId);
        if (launch.slotReserved) {
          launch.slotReserved = false;
          await this.#releaseChildSlot(input.workspaceRoot, launch.parentSessionId);
        }
      }
      this.#pendingChildLaunches.delete(launchKey);
    }

    this.#publishSessionRuntimeChange(input.workspaceRoot, input.rootSessionId);
  }

  #forceTerminalizeCommand(command: ActiveSessionCommand, reason: string): void {
    const familyKey = scopedKey(command.workspaceRoot, command.rootSessionId);
    const current = this.#activeCommands.get(familyKey);
    if (current?.token !== command.token) return;

    command.abortController.abort(new Error(reason));
    this.#activeCommands.delete(familyKey);
    command.rejectCompletion(new Error(reason));
  }

  async #forceTerminalizeExecution(execution: PendingSessionExecution, reason: string): Promise<void> {
    const key = scopedKey(execution.workspaceRoot, execution.sessionId);
    const current = this.#active.get(key);
    if (current?.executionToken !== execution.executionToken) return;

    this.#cancelExecution(execution, reason);
    this.#closeSteerGate(execution);
    if (!execution.ready) {
      execution.rejectStarted(new Error(reason));
    }
    // The live run may unwind as soon as cancellation is observed. Transfer
    // lifecycle ownership before this force path awaits durable teardown.
    this.#active.delete(key);
    const runAgent = execution.runAgent;
    execution.runAgent = undefined;
    if (
      runAgent !== undefined
      && this.#config.sessionAgentManager.get(execution.workspaceRoot, execution.sessionId) === runAgent
    ) {
      this.#config.sessionAgentManager.releaseAgent(execution.workspaceRoot, execution.sessionId);
    }
    this.#executionSkillSnapshots.delete(executionSkillSnapshotKey(
      execution.workspaceRoot,
      execution.sessionId,
      execution.executionId,
    ));

    const store = this.#config.getSessionStore(execution.sessionId, execution.workspaceRoot);
    if (
      store !== undefined
      && store.getState().isRunning
      && store.getState().currentExecutionId === execution.executionId
    ) {
      if (store.getState().toolBatches.some((batch) =>
        batch.archivedAt === undefined && batch.executionId === execution.executionId
      )) {
        await this.#config.cancelSessionToolBatch(
          execution.sessionId,
          execution.workspaceRoot,
          reason,
        );
      }
      const currentState = store.getState();
      const record = currentState.executions.find((candidate) => candidate.id === execution.executionId);
      const run = record?.runs[execution.runOrdinal];
      if (record?.status !== "running" || run === undefined || run.endedAt !== undefined) {
        throw new Error(`Execution ${execution.executionId} run ${execution.runOrdinal} has no canonical open run`);
      }
      const status = abortExecutionStatus(execution.abortController.signal);
      const endedAt = Math.max(Date.now(), run.startedAt);
      const goalInstanceId = await this.#config.resolveGoalInstanceId({
        workspaceRoot: execution.workspaceRoot,
        rootSessionId: execution.rootSessionId,
      });
      const runUsageDelta = subtractUsage(currentState.stats.usage, execution.initialUsage);
      const runSettlement = {
        key: `run:${execution.sessionId}:${execution.executionId}:${execution.runOrdinal}`,
        kind: "run" as const,
        runOrdinal: execution.runOrdinal,
        usage: runUsageDelta,
        executionTimeMs: endedAt - run.startedAt,
        goalInstanceId,
      };
      const terminalSettlement = {
        key: `terminal:${execution.sessionId}:${execution.executionId}`,
        goalInstanceId,
      };
      store.getState().append({
        type: "execution-end",
        executionId: execution.executionId,
        terminalStatus: status,
        endedAt,
        runEndedAt: endedAt,
        runUsageDelta,
        runSettlement: {
          key: runSettlement.key,
          goalInstanceId,
        },
        terminalSettlement,
        error: reason,
      });
      await this.#config.flushSessionStore(execution.sessionId, execution.workspaceRoot);
      await this.#applySettlements({
        workspaceRoot: execution.workspaceRoot,
        rootSessionId: execution.rootSessionId,
        sessionId: execution.sessionId,
        executionId: execution.executionId,
        settlements: [
          runSettlement,
          {
            ...terminalSettlement,
            kind: "terminal",
            usage: zeroUsage(),
            executionTimeMs: 0,
            terminalStatus: status,
          },
        ],
      });
    }

    await this.#forceTerminalizeParentChildLink(execution, reason);
    await this.#releaseExecutionChildSlot(execution);
  }

  #attachChildSlotOwnership(
    execution: ActiveSessionExecution | PendingSessionExecution,
    parentSessionId: string,
  ): void {
    const pending = execution as PendingSessionExecution;
    pending.childSlotParentSessionId = parentSessionId;
    pending.childSlotReleased = false;
  }

  async #releaseExecutionChildSlot(
    execution: ActiveSessionExecution | PendingSessionExecution,
  ): Promise<void> {
    const pending = execution as PendingSessionExecution;
    const parentSessionId = pending.childSlotParentSessionId;
    if (parentSessionId === undefined || pending.childSlotReleased) return;
    pending.childSlotReleased = true;
    await this.#releaseChildSlot(execution.workspaceRoot, parentSessionId);
  }

  async #forceTerminalizeParentChildLink(execution: PendingSessionExecution, reason: string): Promise<void> {
    const childStore = this.#config.getSessionStore(execution.sessionId, execution.workspaceRoot);
    const childState = childStore?.getState();
    const parentSessionId = childState?.parentSessionId;
    if (parentSessionId === undefined) return;

    const parentStore = this.#config.getSessionStore(parentSessionId, execution.workspaceRoot);
    if (parentStore === undefined) return;

    const links = parentStore.getState().childSessionLinks;
    let link: ToolChildSessionLink | undefined;
    for (let index = links.length - 1; index >= 0; index -= 1) {
      const candidate = links[index];
      if (candidate?.childSessionId === execution.sessionId && !isTerminalChildSessionStatus(candidate.status)) {
        link = candidate;
        break;
      }
    }
    if (link === undefined) return;

    const run = childState?.executions.at(-1);
    const status = childTerminalStatus(run, execution.abortController.signal);
    if (status === "waiting_for_human") return;
    const durationUpdatedAt = Date.now();

    parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        ...link,
        status,
        ...(run?.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run?.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        ...(run?.durationMs === undefined ? {} : {
          durationMs: run.durationMs,
          durationUpdatedAt,
        }),
        error: run?.error ?? reason,
      },
    });

    if (link.background) {
      appendTerminalReminder(parentStore, execution.sessionId, execution.executionId, status, run?.error ?? reason);
    }

    await this.#config.flushSessionStore(parentSessionId, execution.workspaceRoot);
  }

  #ancestorSessionIds(workspaceRoot: string, sessionId: string | undefined): Set<string> {
    const ancestors = new Set<string>();
    let current = sessionId === undefined
      ? undefined
      : this.#config.getSessionStore(sessionId, workspaceRoot)?.getState().parentSessionId;
    while (current !== undefined && !ancestors.has(current)) {
      ancestors.add(current);
      current = this.#config.getSessionStore(current, workspaceRoot)?.getState().parentSessionId;
    }
    return ancestors;
  }

  async #cancelAndWaitForSessions(workspaceRoot: string, sessionIds: readonly string[]): Promise<string[]> {
    const executions = sessionIds
      .map((sessionId) => this.#active.get(scopedKey(workspaceRoot, sessionId)))
      .filter((execution): execution is PendingSessionExecution => execution !== undefined);

    for (const execution of executions) this.#cancelExecution(execution, "Session cancelled");
    const sessionIdSet = new Set(sessionIds);
    const commands = [...this.#activeCommands.values()].filter((command) => (
      command.workspaceRoot === workspaceRoot && sessionIdSet.has(command.rootSessionId)
    ));
    for (const command of commands) command.abortController.abort(new Error("Session cancelled"));

    const settled = await Promise.all(executions.map(async (execution) => {
        try {
          await waitForExecutionToStop(execution, this.#deadlineScheduler);
          return undefined;
        } catch {
          return execution.sessionId;
        }
      }));

    const stuckCommands = await Promise.all(commands.map(async (command) => {
      try {
        await waitForCommandToStop(command, this.#deadlineScheduler);
        return undefined;
      } catch {
        return command.rootSessionId;
      }
    }));

    return [...settled, ...stuckCommands].filter((id): id is string => id !== undefined);
  }

  #isDirectlyRunning(workspaceRoot: string, sessionId: string): boolean {
    return this.#active.has(scopedKey(workspaceRoot, sessionId));
  }

  #countActiveChildren(workspaceRoot: string, parentSessionId: string): number {
    let count = 0;
    for (const execution of this.#active.values()) {
      if (execution.workspaceRoot !== workspaceRoot) continue;
      const store = this.#config.getSessionStore(execution.sessionId, workspaceRoot);
      if (store?.getState().parentSessionId === parentSessionId) count += 1;
    }
    return count;
  }

  #assertSessionStartAllowed(
    workspaceRoot: string,
    sessionId: string,
    state: SessionStoreState,
    allowBlockedToolBatch = false,
  ): void {
    if (!allowBlockedToolBatch) this.#assertSessionToolBatchReady(sessionId, state);
    const rootSessionId = state.rootSessionId;
    if (this.#familyStops.has(scopedKey(workspaceRoot, rootSessionId))) {
      throw new SessionFamilyStopInProgressError(sessionId, rootSessionId);
    }
    if (this.#deletions.has(scopedKey(workspaceRoot, rootSessionId))) {
      throw new SessionDeleteInProgressError(sessionId, rootSessionId);
    }
    if (this.#isStoppedSubtreeAdmission(workspaceRoot, rootSessionId, sessionId)) {
      throw new SessionFamilyStopInProgressError(sessionId, rootSessionId);
    }
    const directLease = this.#cwdTransitions.get(scopedKey(workspaceRoot, sessionId));
    if (directLease?.blockRootExecution === true) {
      throw new SessionCwdTransitionInProgressError(sessionId, sessionId);
    }
    if (state?.parentSessionId === undefined) return;
    if (this.#cwdTransitions.has(scopedKey(workspaceRoot, rootSessionId))) {
      throw new SessionCwdTransitionInProgressError(sessionId, rootSessionId);
    }
  }

  #assertSessionToolBatchReady(sessionId: string, state: SessionStoreState): void {
    const activeBatch = state.toolBatches.find((batch) => batch.archivedAt === undefined);
    if (activeBatch === undefined) return;
    const hitlIds = new Set(activeBatch?.calls.flatMap((call) => call.state === "blocked" && call.blocker?.hitlId !== undefined ? [call.blocker.hitlId] : []) ?? []);
    throw new SessionToolBatchActiveError(sessionId, [...hitlIds].sort());
  }

  #assertExecutionOriginReady(input: StartSessionExecutionInput, state: SessionStoreState): void {
    if (
      input.origin === "goal_continuation"
      && state.pendingMessages.length > 0
    ) {
      throw new SessionInputConflictError(
        "state",
        `Session continuation cannot bypass ${state.pendingMessages.length} pending input message(s)`,
      );
    }
    if (input.input.kind !== "resume") return;
    const activeBatch = state.toolBatches.find((batch) =>
      batch.archivedAt === undefined && batch.executionId === input.executionId
    );
    if (activeBatch === undefined) {
      throw new Error(`Session "${input.sessionId}" has no canonical active Tool Batch for Execution "${input.executionId ?? "none"}"`);
    }
    if (activeBatch.agentName !== state.agentName) {
      throw new Error(
        `Session "${input.sessionId}" active tool batch belongs to ${activeBatch.agentName}, not ${state.agentName}`,
      );
    }
  }

  /**
   * A dormant child keeps the checkout it was created in. Once the root moves,
   * neither a direct message nor a pending batch execution may revive that child in the
   * abandoned checkout. Callers load both identities before this synchronous
   * assertion so the check and the following ownership claim cannot interleave.
   */
  #assertSessionFamilyCwdAligned(
    workspaceRoot: string,
    sessionId: string,
    state: SessionStoreState,
  ): void {
    if (state.parentSessionId === undefined) return;
    const rootState = this.#config.getSessionStore(state.rootSessionId, workspaceRoot)?.getState();
    if (rootState === undefined) {
      throw new Error(
        `Root session "${state.rootSessionId}" must be loaded before session "${sessionId}" can claim execution ownership`,
      );
    }
    if (state.cwd === rootState.cwd) return;
    throw new ChildSessionCwdMismatchError(
      sessionId,
      state.rootSessionId,
      rootState.cwd,
      state.cwd,
    );
  }

  #reserveChildLaunch(
    workspaceRoot: string,
    rootSessionId: string,
    parentSessionId: string,
    childSessionId: string,
  ): {
    readonly signal: AbortSignal;
    readonly release: () => void;
    readonly markSlotReserved: () => void;
    readonly takeReservedSlot: () => boolean;
  } {
    this.#assertWorkspaceOpen(workspaceRoot);
    const key = scopedKey(workspaceRoot, rootSessionId);
    if (this.#familyStops.has(key)) {
      throw new SessionFamilyStopInProgressError(childSessionId, rootSessionId);
    }
    if (this.#deletions.has(key)) {
      throw new SessionDeleteInProgressError(childSessionId, rootSessionId);
    }
    if (this.#cwdTransitions.has(key)) {
      throw new SessionCwdTransitionInProgressError(childSessionId, rootSessionId);
    }
    if (
      this.#isStoppedSubtreeAdmission(workspaceRoot, rootSessionId, parentSessionId)
      || this.#isStoppedSubtreeAdmission(workspaceRoot, rootSessionId, childSessionId, parentSessionId)
    ) {
      throw new SessionFamilyStopInProgressError(childSessionId, rootSessionId);
    }

    const parentStore = this.#config.getSessionStore(parentSessionId, workspaceRoot);
    const existingChildIds = new Set(
      parentStore?.getState().childSessionLinks.map((link) => link.childSessionId) ?? [],
    );
    const pendingChildIds = new Set(
      [...(this.#pendingChildLaunches.get(key)?.launches.values() ?? [])]
        .filter((launch) => launch.parentSessionId === parentSessionId)
        .map((launch) => launch.sessionId),
    );
    const prospectiveChildIds = new Set([...existingChildIds, ...pendingChildIds, childSessionId]);
    if (prospectiveChildIds.size > MAX_DIRECT_CHILD_SESSIONS) {
      throw new DelegationExecutionAdmissionError(
        "DELEGATION_SESSION_CAPACITY_REACHED",
        `Session "${parentSessionId}" already owns the maximum ${MAX_DIRECT_CHILD_SESSIONS} direct child Sessions; resume an existing child instead of creating another one`,
      );
    }

    const token = Symbol(`child-launch:${childSessionId}`);
    const abortController = new AbortController();
    const family = this.#pendingChildLaunches.get(key) ?? {
      workspaceRoot,
      rootSessionId,
      launches: new Map<symbol, PendingChildLaunch>(),
    };
    const launch = {
      sessionId: childSessionId,
      parentSessionId,
      abortController,
      slotReserved: false,
    };
    family.launches.set(token, launch);
    this.#pendingChildLaunches.set(key, family);
    this.#publishSessionRuntimeChange(workspaceRoot, rootSessionId);
    let released = false;
    return {
      signal: abortController.signal,
      markSlotReserved: () => { launch.slotReserved = true; },
      takeReservedSlot: () => {
        if (!launch.slotReserved) return false;
        launch.slotReserved = false;
        return true;
      },
      release: () => {
      if (released) return;
      released = true;
      const current = this.#pendingChildLaunches.get(key);
      current?.launches.delete(token);
      if (current?.launches.size === 0) this.#pendingChildLaunches.delete(key);
      this.#publishSessionRuntimeChange(workspaceRoot, rootSessionId);
      },
    };
  }

  #publishSessionRuntimeChange(
    workspaceRoot: string,
    rootSessionId: string,
  ): void {
    const activity = this.getSessionFamilyActivity(workspaceRoot, rootSessionId);
    const steerTargetExecutionId = this.getSteerTargetExecutionId(workspaceRoot, rootSessionId);
    const key = scopedKey(workspaceRoot, rootSessionId);
    const previous = this.#publishedRuntime.get(key) ?? { activity: "idle" as const };
    if (
      activity === previous.activity
      && steerTargetExecutionId === previous.steerTargetExecutionId
    ) return;
    if (activity === "idle" && steerTargetExecutionId === undefined) this.#publishedRuntime.delete(key);
    else this.#publishedRuntime.set(key, {
      activity,
      ...(steerTargetExecutionId === undefined ? {} : { steerTargetExecutionId }),
    });
    const change: SessionRuntimeChange = {
      workspaceRoot,
      rootSessionId,
      activity,
      ...(steerTargetExecutionId === undefined ? {} : { steerTargetExecutionId }),
    };
    for (const listener of this.#runtimeChangeListeners) {
      try {
        listener(change);
      } catch (error) {
        this.#logger.warn("session.runtime.listener.failed", {
          error,
          context: { rootSessionId, activity },
          meta: { workspaceRoot },
        });
      }
    }
  }

  #assertWorkspaceOpen(workspaceRoot: string): void {
    if (!this.#acceptingExecutions) {
      throw new SessionExecutionManagerShuttingDownError();
    }
    if (this.#workspaceClosures.has(workspaceRoot)) {
      throw new SessionWorkspaceClosingError(workspaceRoot);
    }
  }

  #acquireSessionDeletion(workspaceRoot: string, rootSessionId: string, sessionId: string): () => void {
    this.#assertWorkspaceOpen(workspaceRoot);
    const key = scopedKey(workspaceRoot, rootSessionId);
    if (this.#familyStops.has(key)) {
      throw new SessionFamilyStopInProgressError(sessionId, rootSessionId);
    }
    if (this.#deletions.has(key)) {
      throw new SessionDeleteInProgressError(sessionId, rootSessionId);
    }
    const pendingChildSessionIds = [...(this.#pendingChildLaunches.get(key)?.launches.values() ?? [])]
      .map((launch) => launch.sessionId);
    if (pendingChildSessionIds.length > 0) {
      throw new SessionDeleteConflictError(pendingChildSessionIds.sort());
    }
    if ((this.#pendingSessionInputMutations.get(key)?.mutations.size ?? 0) > 0) {
      throw new SessionDeleteConflictError([rootSessionId]);
    }

    const token = Symbol(`session-delete:${key}`);
    this.#deletions.set(key, { token, rootSessionId });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#deletions.get(key)?.token === token) this.#deletions.delete(key);
    };
  }

  #tryAcquireSessionInputMutation(
    workspaceRoot: string,
    rootSessionId: string,
  ): { readonly kind: "acquired"; readonly release: () => Promise<void> } | { readonly kind: "wait"; readonly control: SessionFamilyControlState } {
    this.#assertWorkspaceOpen(workspaceRoot);
    const key = scopedKey(workspaceRoot, rootSessionId);
    if (this.#deletions.has(key)) {
      throw new SessionDeleteInProgressError(rootSessionId, rootSessionId);
    }
    const control = this.#familyControls.get(key);
    if (control !== undefined) return { kind: "wait", control };

    const token = Symbol(`session-input-mutation:${key}`);
    const pending = this.#pendingSessionInputMutations.get(key) ?? {
      workspaceRoot,
      rootSessionId,
      mutations: new Set<symbol>(),
    };
    pending.mutations.add(token);
    this.#pendingSessionInputMutations.set(key, pending);

    let released = false;
    return { kind: "acquired", release: async () => {
      if (released) return;
      released = true;
      const current = this.#pendingSessionInputMutations.get(key);
      current?.mutations.delete(token);
      if (current?.mutations.size !== 0) return;
      this.#pendingSessionInputMutations.delete(key);
      await this.#config.onSessionInputMutationReleased({
        workspaceRoot,
        rootSessionId,
      });
    } };
  }

  #reserveChildSlot(workspaceRoot: string, parentSessionId: string, maxConcurrent: number): void {
    const key = scopedKey(workspaceRoot, parentSessionId);
    const activeChildren = this.#countActiveChildren(workspaceRoot, parentSessionId);
    const reservedChildren = this.#childSlots.get(key) ?? 0;
    const totalChildren = Math.max(activeChildren, reservedChildren);
    if (totalChildren >= maxConcurrent) throw new ConcurrentLimitError(totalChildren);
    this.#childSlots.set(key, reservedChildren + 1);
  }

  async #releaseChildSlot(
    workspaceRoot: string,
    parentSessionId: string,
  ): Promise<void> {
    const key = scopedKey(workspaceRoot, parentSessionId);
    const reservedChildren = this.#childSlots.get(key) ?? 0;
    if (reservedChildren <= 1) this.#childSlots.delete(key);
    else this.#childSlots.set(key, reservedChildren - 1);
    await this.#config.onContinuationAdmissionReleased({
      workspaceRoot,
      sessionId: parentSessionId,
    });
  }

  #appendChildLinkStatus(
    workspaceRoot: string,
    request: ChildExecutionRequest,
    childSessionId: string,
    childAgentName: ToolChildSessionLink["childAgentName"],
    depth: number,
    status: ToolChildSessionLinkStatus,
    title: string,
    createdAt?: number,
    background?: boolean,
  ): void {
    const childState = this.#config.getSessionStore(childSessionId, workspaceRoot)?.getState();
    const delegation = childState?.delegationRequest;
    if (childState === undefined || delegation === undefined) {
      throw new DelegationExecutionAdmissionError(
        "DELEGATION_IDENTITY_REQUIRED",
        `Child Session "${childSessionId}" has no canonical Profile and Skill identity`,
      );
    }
    const run = childState.executions.at(-1);
    const durationUpdatedAt = Date.now();
    request.parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: request.parentSessionId,
        parentToolCallId: request.parentToolCallId,
        toolName: request.toolName,
        childSessionId,
        childExecutionId: request.childExecutionId,
        childAgentName,
        childProfile: delegation.profile,
        childSkillNames: [...childState.activeSkillNames],
        title,
        depth,
        background: background ?? request.request.background,
        status,
        createdAt: createdAt ?? durationUpdatedAt,
        ...(run?.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run?.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        ...(run?.durationMs === undefined ? {} : {
          durationMs: run.durationMs,
          durationUpdatedAt,
        }),
        ...(run?.error === undefined ? {} : { error: run.error }),
      },
    });
  }

  #appendResumeChildLinkStatus(
    workspaceRoot: string,
    request: ResumeChildRequest,
    existingLink: ToolChildSessionLink | undefined,
    childAgentName: ToolChildSessionLink["childAgentName"],
    childTitle: string,
    depth: number,
    status: ToolChildSessionLinkStatus,
    createdAt: number,
  ): void {
    const childState = this.#config.getSessionStore(request.sessionId, workspaceRoot)?.getState();
    const delegation = childState?.delegationRequest;
    if (childState === undefined || delegation === undefined) {
      throw new DelegationExecutionAdmissionError(
        "DELEGATION_IDENTITY_REQUIRED",
        `Child Session "${request.sessionId}" has no canonical Profile and Skill identity`,
      );
    }
    const run = childState.executions.at(-1);
    const now = Date.now();
    const isTerminal = isTerminalChildSessionStatus(status);
    const runMatchesStatus = childLinkStatusFromExecution(run) === status;
    const openRun = run?.status === "running" ? run.runs.at(-1) : undefined;
    const durationMs = run === undefined
      ? undefined
      : run.durationMs + (
          openRun !== undefined && openRun.endedAt === undefined
            ? Math.max(0, now - openRun.startedAt)
            : 0
        );
    const durationUpdatedAt = durationMs === undefined ? undefined : now;
    const endedAt = isTerminal
      ? runMatchesStatus ? run?.endedAt ?? now : now
      : undefined;
    const error = isTerminal && runMatchesStatus ? run?.error : undefined;
    request.parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: request.parentSessionId,
        parentToolCallId: request.parentToolCallId,
        toolName: request.toolName,
        childSessionId: request.sessionId,
        childExecutionId: request.childExecutionId,
        childAgentName,
        childProfile: delegation.profile,
        childSkillNames: [...childState.activeSkillNames],
        title: childTitle,
        depth,
        background: request.background,
        status,
        createdAt,
        ...(run?.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(endedAt === undefined ? {} : { endedAt }),
        ...(durationMs === undefined ? {} : { durationMs, durationUpdatedAt }),
        ...(error === undefined ? {} : { error }),
      },
    });
  }

  #markParentLinkCancelling(workspaceRoot: string, childSessionId: string): void {
    const childStore = this.#config.getSessionStore(childSessionId, workspaceRoot);
    const childState = childStore?.getState();
    const parentSessionId = childState?.parentSessionId;
    if (parentSessionId === undefined) return;
    const parentStore = this.#config.getSessionStore(parentSessionId, workspaceRoot);
    const links = parentStore?.getState().childSessionLinks ?? [];
    let link: ToolChildSessionLink | undefined;
    for (let index = links.length - 1; index >= 0; index -= 1) {
      const candidate = links[index];
      if (candidate?.childSessionId === childSessionId && !isTerminalChildSessionStatus(candidate.status)) {
        link = candidate;
        break;
      }
    }
    if (parentStore === undefined || link === undefined || link.status === "cancelling") return;
    parentStore.getState().append({
      type: "tool-child-session-link",
      link: { ...link, status: "cancelling" },
    });
  }

  #isDescendantOf(workspaceRoot: string, descendantSessionId: string, ancestorSessionId: string): boolean {
    if (descendantSessionId === ancestorSessionId) return false;
    let currentSessionId: string | undefined = descendantSessionId;
    const visited = new Set<string>();
    while (currentSessionId !== undefined && !visited.has(currentSessionId)) {
      visited.add(currentSessionId);
      const store = this.#config.getSessionStore(currentSessionId, workspaceRoot);
      const parentSessionId = store?.getState().parentSessionId;
      if (parentSessionId === undefined) return false;
      if (parentSessionId === ancestorSessionId) return true;
      currentSessionId = parentSessionId;
    }
    return false;
  }

  #isStoppedSubtreeAdmission(
    workspaceRoot: string,
    rootSessionId: string,
    sessionId: string,
    prospectiveParentSessionId?: string,
  ): boolean {
    for (const lease of this.#subtreeStops.values()) {
      if (lease.workspaceRoot !== workspaceRoot || lease.rootSessionId !== rootSessionId) continue;
      if (sessionId === lease.targetSessionId) return true;
      if (prospectiveParentSessionId !== undefined) {
        if (
          prospectiveParentSessionId === lease.targetSessionId
          || this.#isDescendantOf(workspaceRoot, prospectiveParentSessionId, lease.targetSessionId)
        ) return true;
      }
      if (this.#isDescendantOf(workspaceRoot, sessionId, lease.targetSessionId)) return true;
    }
    return false;
  }

  #findChildSessionLink(parentStore: StoreApi<SessionStoreState>, childSessionId: string): ToolChildSessionLink | undefined {
    const links = parentStore.getState().childSessionLinks;
    for (let index = links.length - 1; index >= 0; index -= 1) {
      const candidate = links[index];
      if (candidate?.childSessionId === childSessionId) return candidate;
    }
    return undefined;
  }

  #supersedeChildReminders(
    parentStore: StoreApi<SessionStoreState>,
    childSessionId: string,
  ): void {
    const reminderIds = parentStore.getState().reminders
      .filter((reminder) =>
        reminder.delivery === "on_demand"
        && reminder.consumedAt === null
        && reminder.sessionId === childSessionId
      )
      .map((reminder) => reminder.id);
    if (reminderIds.length === 0) return;
    parentStore.getState().append({ type: "reminder-consumed", reminderIds });
  }

  /**
   * Revalidates every durable authority needed to activate an existing child.
   * This is intentionally shared by cold/direct, Queue, Tool Batch, and resume
   * paths so a warm Agent cache can never substitute for persisted identity.
   */
  async #validateExistingChildActivation(
    workspaceRoot: string,
    childStore: StoreApi<SessionStoreState>,
  ): Promise<ExistingChildActivationAdmission>;
  async #validateExistingChildActivation<T>(
    workspaceRoot: string,
    childStore: StoreApi<SessionStoreState>,
    action: (admission: ExistingChildActivationAdmission) => Promise<T>,
  ): Promise<T>;
  async #validateExistingChildActivation<T>(
    workspaceRoot: string,
    childStore: StoreApi<SessionStoreState>,
    action?: (admission: ExistingChildActivationAdmission) => Promise<T>,
  ): Promise<ExistingChildActivationAdmission | T> {
    const claimedChild = childActivationIdentitySnapshot(childStore.getState());
    this.#assertDurableChildDelegationIdentity(childStore.getState());
    const parentSessionId = childStore.getState().parentSessionId;
    if (parentSessionId === undefined) {
      throw new DelegationExecutionAdmissionError(
        "DELEGATION_IDENTITY_REQUIRED",
        `Session "${childStore.getState().sessionId}" is not a durable child Session`,
      );
    }

    const parentStore = await this.#config.loadSessionStore(parentSessionId, workspaceRoot);
    if (childStore.getState().rootSessionId !== parentStore.getState().rootSessionId) {
      throw new Error(
        `Child Session "${childStore.getState().sessionId}" belongs to root "${childStore.getState().rootSessionId}", not "${parentStore.getState().rootSessionId}"`,
      );
    }
    const rootStore = await this.#config.loadSessionStore(childStore.getState().rootSessionId, workspaceRoot);
    const claimedParent = childActivationIdentitySnapshot(parentStore.getState());
    const claimedRoot = childActivationIdentitySnapshot(rootStore.getState());

    const validate = async (): Promise<ExistingChildActivationAdmission | T> => {
      const childState = childStore.getState();
      const parentState = parentStore.getState();
      const rootState = rootStore.getState();
      assertStableChildActivationIdentity("child", claimedChild, childActivationIdentitySnapshot(childState));
      assertStableChildActivationIdentity("parent", claimedParent, childActivationIdentitySnapshot(parentState));
      assertStableChildActivationIdentity("root", claimedRoot, childActivationIdentitySnapshot(rootState));
      if (
        this.#config.getSessionStore(childState.sessionId, workspaceRoot) !== childStore
        || this.#config.getSessionStore(parentState.sessionId, workspaceRoot) !== parentStore
        || this.#config.getSessionStore(rootState.sessionId, workspaceRoot) !== rootStore
      ) {
        throw new DelegationExecutionAdmissionError(
          "DELEGATION_IDENTITY_REQUIRED",
          `Child Session "${childState.sessionId}" activation identity was replaced during admission`,
        );
      }
      if (
        childState.parentSessionId !== parentState.sessionId
        || childState.rootSessionId !== parentState.rootSessionId
        || rootState.sessionId !== childState.rootSessionId
        || rootState.rootSessionId !== rootState.sessionId
        || rootState.parentSessionId !== undefined
      ) {
        throw new DelegationExecutionAdmissionError(
          "DELEGATION_IDENTITY_REQUIRED",
          `Child Session "${childState.sessionId}" does not belong to its exact durable parent and root family`,
        );
      }
      if (childState.cwd !== parentState.cwd || childState.cwd !== rootState.cwd) {
        throw new ChildSessionCwdMismatchError(
          childState.sessionId,
          parentState.sessionId,
          parentState.cwd,
          childState.cwd,
        );
      }
      const factory = this.#config.sessionAgentManager.getFactory(workspaceRoot);
      const parentDefinition = factory.getDefinition(parentState.agentName);
      const parentDepth = await this.#config.resolveSessionDepth(workspaceRoot, parentState.sessionId);
      const childDepth = await this.#config.resolveSessionDepth(workspaceRoot, childState.sessionId);
      const delegationCapabilities = factory.resolveDelegationCapabilities(parentState.agentName, parentDepth);
      const targetCapability = delegationCapabilities.targets.find((target) => target.agentName === childState.agentName);
      if (targetCapability === undefined) {
        throw new DelegateTargetNotAllowedError(parentState.agentName, childState.agentName, parentDepth);
      }
      const durableRequest = childState.delegationRequest!;
      if (!targetCapability.profiles.includes(durableRequest.profile)) {
        throw new DelegationExecutionAdmissionError(
          "DELEGATION_PROFILE_NOT_ALLOWED",
          `Child Agent "${targetCapability.agentName}" does not allow durable Profile "${durableRequest.profile}" at depth ${parentDepth}`,
        );
      }
      const configuredChildPolicy = parentDefinition.childPolicy;
      if (configuredChildPolicy === undefined) throw new AgentChildPolicyMissingError(parentState.agentName);
      const childPolicy = configuredChildPolicy;
      if (childDepth !== parentDepth + 1 || childDepth > childPolicy.maxDepth) {
        throw new DepthLimitError(parentDepth);
      }
      const activeSkillNames = await factory.resolveDelegatedSkillNames(
        targetCapability,
        childState.activeSkillNames,
        childState.cwd,
      );
      if (
        activeSkillNames.length !== childState.activeSkillNames.length
        || activeSkillNames.some((name, index) => name !== childState.activeSkillNames[index])
      ) {
        throw new DelegationExecutionAdmissionError(
          "DELEGATION_IDENTITY_REQUIRED",
          `Child Session "${childState.sessionId}" active Skills no longer match canonical authorization`,
        );
      }
      await this.#validateChildExecutionScope(workspaceRoot, childStore, false);
      assertStableChildActivationIdentity("child", claimedChild, childActivationIdentitySnapshot(childStore.getState()));
      assertStableChildActivationIdentity("parent", claimedParent, childActivationIdentitySnapshot(parentStore.getState()));
      assertStableChildActivationIdentity("root", claimedRoot, childActivationIdentitySnapshot(rootStore.getState()));
      const result: ExistingChildActivationAdmission = {
        childState: childStore.getState(),
        parentStore,
        parentState: parentStore.getState(),
        parentDepth,
        childDepth,
        childPolicy,
      };
      return action === undefined ? result : await action(result);
    };

    return await validate();
  }

  async #validateChildExecutionScope(
    workspaceRoot: string,
    store: StoreApi<SessionStoreState>,
    freshlyCreated: boolean,
  ): Promise<void> {
    const claimedState = store.getState();
    const claimedScope = executionScopeSnapshot(claimedState);
    await this.#config.executionScopeValidator.validate({
      projectRoot: workspaceRoot,
      subject: await resolveSessionExecutionIdentity({
        workspaceRoot,
        sessionId: claimedState.sessionId,
        sessions: {
          getOrLoad: this.#config.loadSessionStore,
          buildSessionTree: this.#config.buildSessionTree,
        },
        newChild: freshlyCreated,
      }),
    });
    const currentState = store.getState();
    const currentScope = executionScopeSnapshot(currentState);
    if (!sameExecutionScopeSnapshot(claimedScope, currentScope)) {
      throw executionScopeChanged(currentState.sessionId, claimedScope, currentScope);
    }
    if (this.#config.getSessionStore(currentState.sessionId, workspaceRoot) !== store) {
      throw executionScopeChanged(currentState.sessionId, claimedScope, currentScope, ["sessionRegistration"]);
    }
  }

  #assertDurableChildDelegationIdentity(state: SessionStoreState): void {
    if (state.parentSessionId === undefined) return;
    requireCanonicalChildTitle(state);
    const request = state.delegationRequest;
    if (request === undefined) {
      throw new DelegationExecutionAdmissionError(
        "DELEGATION_IDENTITY_REQUIRED",
        `Child Session "${state.sessionId}" has no durable delegation request`,
      );
    }
    if (request.agent_type !== state.agentName) {
      throw new DelegationExecutionAdmissionError(
        "DELEGATION_IDENTITY_REQUIRED",
        `Child Session "${state.sessionId}" delegation request does not match its durable Agent`,
      );
    }
    resolveDurableSessionModelOverride(state);
    const delegatedSkillNames = [...new Set(request.skills)];
    if (
      delegatedSkillNames.length !== state.activeSkillNames.length
      || delegatedSkillNames.some((name, index) => name !== state.activeSkillNames[index])
    ) {
      throw new DelegationExecutionAdmissionError(
        "DELEGATION_IDENTITY_REQUIRED",
        `Child Session "${state.sessionId}" active Skills do not match its durable delegation request`,
      );
    }
  }

  async #validateProspectiveChildExecutionScope(
    workspaceRoot: string,
    parentState: SessionStoreState,
    childSessionId: string,
    agentName: AgentName,
  ): Promise<void> {
    await this.#config.executionScopeValidator.validate({
      projectRoot: workspaceRoot,
      subject: {
        sessionId: childSessionId,
        rootSessionId: parentState.rootSessionId,
        parentSessionId: parentState.sessionId,
        parentAgentName: parentState.agentName,
        cwd: parentState.cwd,
        agentName,
      },
    });
  }

}

function requireCanonicalChildTitle(state: SessionStoreState): string {
  const parsed = DelegatedSessionTitleSchema.safeParse(state.title);
  if (!parsed.success) {
    throw new DelegationExecutionAdmissionError(
      "DELEGATION_IDENTITY_REQUIRED",
      `Child Session "${state.sessionId}" has an invalid canonical title`,
    );
  }
  return parsed.data;
}

function executionSkillSnapshotKey(
  workspaceRoot: string,
  sessionId: string,
  executionId: string,
): string {
  return `${scopedKey(workspaceRoot, sessionId)}\0${executionId}`;
}

function sanitizeBindingError(error: unknown, binding: ExecutionModelBinding): Error {
  if (error instanceof Error) {
    const safeName = binding.modelInfo.redactSensitiveText(error.name);
    const safeMessage = binding.modelInfo.redactSensitiveText(error.message);
    if (safeName === error.name && safeMessage === error.message) return error;
  }
  return sanitizeProviderError(error, (text) => binding.modelInfo.redactSensitiveText(text));
}

interface ExecutionScopeSnapshot {
  readonly cwd: string;
  readonly rootSessionId: string;
  readonly parentSessionId: string | undefined;
}

interface ChildActivationIdentitySnapshot extends ExecutionScopeSnapshot {
  readonly sessionId: string;
  readonly agentName: AgentName;
  readonly title: string | null;
  readonly activeSkillNames: readonly string[];
  readonly delegationRequest: string | undefined;
}

function childActivationIdentitySnapshot(state: SessionStoreState): ChildActivationIdentitySnapshot {
  return {
    sessionId: state.sessionId,
    agentName: state.agentName,
    title: state.title,
    activeSkillNames: [...state.activeSkillNames],
    delegationRequest: state.delegationRequest === undefined
      ? undefined
      : JSON.stringify(state.delegationRequest),
    ...executionScopeSnapshot(state),
  };
}

function assertStableChildActivationIdentity(
  label: "child" | "parent" | "root",
  expected: ChildActivationIdentitySnapshot,
  actual: ChildActivationIdentitySnapshot,
): void {
  if (
    expected.sessionId === actual.sessionId
    && expected.agentName === actual.agentName
    && expected.title === actual.title
    && expected.delegationRequest === actual.delegationRequest
    && sameExecutionScopeSnapshot(expected, actual)
    && expected.activeSkillNames.length === actual.activeSkillNames.length
    && expected.activeSkillNames.every((name, index) => name === actual.activeSkillNames[index])
  ) return;
  throw new DelegationExecutionAdmissionError(
    "DELEGATION_IDENTITY_REQUIRED",
    `Durable ${label} Session identity changed during child activation admission`,
  );
}

function executionScopeSnapshot(state: SessionStoreState): ExecutionScopeSnapshot {
  return {
    cwd: state.cwd,
    rootSessionId: state.rootSessionId,
    parentSessionId: state.parentSessionId,
  };
}

function sameExecutionScopeSnapshot(
  left: ExecutionScopeSnapshot,
  right: ExecutionScopeSnapshot,
): boolean {
  return executionScopeChangedFields(left, right).length === 0;
}

function executionScopeChanged(
  sessionId: string,
  previous: Partial<ExecutionScopeSnapshot>,
  current: ExecutionScopeSnapshot,
  changedFields: readonly string[] = executionScopeChangedFields(previous, current),
): SessionExecutionScopeConflictError {
  return new SessionExecutionScopeConflictError(
    "SESSION_EXECUTION_SCOPE_CHANGED",
    sessionId,
    `Session ${sessionId} changed identity or cwd while its execution scope was being validated`,
    { changedFields, previous, current },
  );
}

function executionScopeChangedFields(
  previous: Partial<ExecutionScopeSnapshot>,
  current: ExecutionScopeSnapshot,
): string[] {
  const fields: Array<keyof ExecutionScopeSnapshot> = [
    "cwd",
    "rootSessionId",
    "parentSessionId",
  ];
  return fields.filter((field) => previous[field] !== current[field]);
}

type SubAgentTerminalStatus = Extract<ToolChildSessionLinkStatus, "completed" | "failed" | "timed_out" | "cancelled" | "interrupted">;
type SubAgentExecutionStatus = SubAgentTerminalStatus | "waiting_for_human";

function childLinkStatusFromExecution(run: SessionExecutionRecord | undefined): SubAgentExecutionStatus | undefined {
  if (run?.status === "completed") return "completed";
  if (run?.status === "suspended") return "waiting_for_human";
  if (run?.status === "timed_out") return "timed_out";
  if (run?.status === "cancelled" || run?.status === "aborted") return "cancelled";
  if (run?.status === "interrupted") return "interrupted";
  if (run?.status === "failed" || run?.status === "max_steps") return "failed";
  return undefined;
}

function wireAbortCascade(parentAbort: AbortSignal | undefined, childController: AbortController): () => void {
  if (parentAbort === undefined) return () => {};
  const onAbort = () => childController.abort(parentAbort.reason);
  if (parentAbort.aborted) {
    onAbort();
    return () => {};
  }
  parentAbort.addEventListener("abort", onAbort, { once: true });
  return () => parentAbort.removeEventListener("abort", onAbort);
}

function parentAgentProvenanceKey(provenance: ParentAgentMessageProvenance): string {
  return JSON.stringify([
    provenance.senderSessionId,
    provenance.senderAgentName,
    provenance.senderExecutionId,
    provenance.senderRunOrdinal,
    provenance.senderToolBatchId,
    provenance.senderToolCallId,
  ]);
}

function hasExactSendMessageCall(
  parentState: Readonly<SessionStoreState>,
  provenance: ParentAgentMessageProvenance,
): boolean {
  if (
    provenance.senderSessionId !== parentState.sessionId
    || provenance.senderAgentName !== parentState.agentName
  ) return false;
  const batch = parentState.toolBatches.find((candidate) => (
    candidate.batchId === provenance.senderToolBatchId
    && candidate.executionId === provenance.senderExecutionId
    && candidate.runOrdinal === provenance.senderRunOrdinal
  ));
  return batch?.calls.some((call) => (
    call.toolCallId === provenance.senderToolCallId
    && call.toolName === "send_message"
  )) === true;
}

function childTerminalStatus(run: SessionExecutionRecord | undefined, signal: AbortSignal): SubAgentExecutionStatus {
  const status = childLinkStatusFromExecution(run);
  if (status !== undefined) return status;
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error && /timed out/i.test(reason.message)) return "timed_out";
    return "cancelled";
  }
  return "failed";
}

function sessionExecutionOrigin(origin: SessionExecutionOrigin | undefined): SessionExecutionOrigin {
  if (
    origin === "tool_call"
    || origin === "goal_continuation"
  ) return origin;
  return "user_message";
}

function subtractUsage(current: NormalizedUsage, initial: NormalizedUsage): NormalizedUsage {
  return {
    inputTokens: Math.max(0, current.inputTokens - initial.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - initial.outputTokens),
    totalTokens: Math.max(0, current.totalTokens - initial.totalTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - initial.reasoningTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - initial.cachedInputTokens),
  };
}

function zeroUsage(): NormalizedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
  };
}

function nextExecutionStep(state: SessionStoreState, executionId: string | undefined): number {
  if (executionId === undefined) return 0;
  let next = 0;
  for (const step of state.steps) {
    if (step.executionId === executionId) next = Math.max(next, step.step + 1);
  }
  return next;
}

function recoveryRunEndedAt(
  state: SessionStoreState,
  record: SessionExecutionRecord,
  batch: SessionStoreState["toolBatches"][number] | undefined,
): number {
  const run = record.runs.at(-1);
  if (run === undefined) return record.startedAt;
  let checkpoint = run.startedAt;
  if (
    batch?.executionId === record.id
    && batch.runOrdinal === run.ordinal
  ) {
    for (const call of batch.calls) {
      checkpoint = Math.max(checkpoint, call.checkpointAt);
    }
  }
  for (const step of state.steps) {
    if (
      step.executionId === record.id
      && step.runOrdinal === run.ordinal
      && step.completedAt !== undefined
    ) checkpoint = Math.max(checkpoint, step.completedAt);
  }
  for (const message of state.messages) {
    if (
      message.executionId === record.id
      && message.runOrdinal === run.ordinal
    ) {
      if (message.completedAt !== undefined) checkpoint = Math.max(checkpoint, message.completedAt);
      for (const part of message.parts) {
        if ("completedAt" in part && part.completedAt !== undefined) {
          checkpoint = Math.max(checkpoint, part.completedAt);
        }
        if (part.type !== "tool") continue;
        checkpoint = Math.max(
          checkpoint,
          part.state === "pending"
            ? part.createdAt
            : part.state === "running"
              ? part.startedAt
              : part.endedAt,
        );
      }
    }
  }
  return Math.min(Date.now(), checkpoint);
}

function recoveredRunUsage(
  state: SessionStoreState,
  record: SessionExecutionRecord,
): NormalizedUsage {
  const run = record.runs.at(-1);
  if (run === undefined) return zeroUsage();
  let usage = zeroUsage();
  for (const step of state.steps) {
    if (step.executionId !== record.id || step.runOrdinal !== run.ordinal) continue;
    usage = addUsage(usage, normalizedStepUsage(step.usage));
  }
  return usage;
}

function normalizeToolAuthorizationSnapshot(
  extraTools: readonly string[] | undefined,
  toolProjection: readonly string[] | undefined,
): ToolAuthorizationSnapshot {
  return {
    extraTools: normalizeToolNames(extraTools ?? []),
    toolProjection: toolProjection === undefined ? null : normalizeToolNames(toolProjection),
  };
}

function cloneToolAuthorizationSnapshot(snapshot: ToolAuthorizationSnapshot): ToolAuthorizationSnapshot {
  return {
    extraTools: [...snapshot.extraTools],
    toolProjection: snapshot.toolProjection === null ? null : [...snapshot.toolProjection],
  };
}

function cloneLoadedToolRefs(refs: readonly LoadedToolRef[]): LoadedToolRef[] {
  return refs.map((ref) => ({ ...ref }));
}

function normalizeToolNames(names: readonly string[]): string[] {
  for (const name of names) {
    if (name.trim().length === 0 || new TextEncoder().encode(name).byteLength > 128) {
      throw new Error("Tool authorization names must be non-blank and at most 128 UTF-8 bytes");
    }
  }
  return [...new Set(names)].sort();
}

function isCompleteToolAuthorizationSnapshot(snapshot: ToolAuthorizationSnapshot): boolean {
  return isSortedUniqueToolNames(snapshot.extraTools)
    && (snapshot.toolProjection === null || isSortedUniqueToolNames(snapshot.toolProjection));
}

function isSortedUniqueToolNames(names: readonly string[]): boolean {
  return names.every((name, index) => (
    name.trim().length > 0
    && new TextEncoder().encode(name).byteLength <= 128
    && (index === 0 || names[index - 1]! < name)
  ));
}

function hasRecoverableToolSearchCalls(batch: SessionToolBatch): boolean {
  const nonterminal = batch.calls.filter((call) => call.state !== "completed" && call.state !== "failed");
  return nonterminal.length > 0 && nonterminal.every((call) => (
    call.toolName === TOOL_TOOL_SEARCH
    && typeof call.catalogDigest === "string"
    && /^[a-f0-9]{64}$/.test(call.catalogDigest)
  ));
}

function toolRefKey(ref: LoadedToolRef): string {
  return `${ref.name}\u0000${ref.descriptorDigest}`;
}

function boundedToolLoadInvalidationNotice(refs: readonly LoadedToolRef[]): string {
  const names = [...new Set(refs.map((ref) => ref.name))].sort();
  const prefix = "Tool contracts changed or became unavailable and were unloaded: ";
  const suffix = ". Run tool_search again before using them.";
  let notice = prefix;
  let included = 0;
  for (const name of names) {
    const candidate = `${notice}${included === 0 ? "" : ", "}${name}${suffix}`;
    if (new TextEncoder().encode(candidate).byteLength > TOOL_LOAD_NOTICE_MAX_BYTES) break;
    notice += `${included === 0 ? "" : ", "}${name}`;
    included += 1;
  }
  if (included < names.length) notice += `${included === 0 ? "" : ", "}and ${names.length - included} more`;
  return `${notice}${suffix}`;
}

function normalizedStepUsage(value: unknown): NormalizedUsage {
  if (typeof value !== "object" || value === null) return zeroUsage();
  const record = value as Record<string, unknown>;
  const number = (key: keyof NormalizedUsage): number => {
    const candidate = record[key];
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(0, candidate)
      : 0;
  };
  return {
    inputTokens: number("inputTokens"),
    outputTokens: number("outputTokens"),
    totalTokens: number("totalTokens"),
    reasoningTokens: number("reasoningTokens"),
    cachedInputTokens: number("cachedInputTokens"),
  };
}

function addUsage(left: NormalizedUsage, right: NormalizedUsage): NormalizedUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  };
}

function resolveSingleBinding(
  snapshot: ModelRuntimeSnapshot,
  profile: ProfileName,
  sessionOverride: ModelSelectionRef | undefined,
  requested: RequestedModelSelection | undefined,
  resolver: ModelSelectionResolver,
): { readonly binding: ExecutionModelBinding; readonly snapshots?: undefined } {
  return {
    binding: resolver.resolve({ snapshot, profile, requested, sessionOverride }),
  };
}

function resolveQueuePrefix(
  queued: readonly PendingSessionMessage[],
  snapshot: ModelRuntimeSnapshot,
  profile: ProfileName,
  sessionOverride: ModelSelectionRef | undefined,
  resolver: ModelSelectionResolver,
): { readonly binding: ExecutionModelBinding; readonly snapshots: readonly ResolvedSessionInputSnapshot[] } {
  let binding: ExecutionModelBinding | undefined;
  const snapshots: ResolvedSessionInputSnapshot[] = [];
  for (const pending of queued) {
    const resolved = resolver.resolve({
      snapshot,
      profile,
      requested: pending.requestedModelSelection,
      sessionOverride,
    });
    if (binding !== undefined
      && !sameModelSelection(binding.summary.selection, resolved.summary.selection)) break;
    binding ??= resolved;
    snapshots.push({
      pending: {
        ...pending,
        requestedModelSelection: {
          ...pending.requestedModelSelection,
          selection: { ...pending.requestedModelSelection.selection },
        },
      },
      modelAudit: modelAuditFor(pending.requestedModelSelection, resolved),
    });
  }
  if (binding === undefined) throw new SessionInputConflictError("empty_queue", "Queue has no resolvable input");
  return { binding, snapshots };
}

function modelAuditFor(
  requested: RequestedModelSelection,
  binding: ExecutionModelBinding,
): MessageModelAudit {
  const actual = binding.summary.selection;
  return {
    requested: { ...requested, selection: { ...requested.selection } },
    actual: { ...actual },
    ...(sameModelSelection(requested.selection, actual) ? {} : { reason: "config_invalidated" as const }),
  };
}

function sameModelSelection(left: ModelSelectionRef, right: ModelSelectionRef): boolean {
  return left.model === right.model && left.variant === right.variant;
}

function effectiveDirectRequest(
  explicit: RequestedModelSelection | undefined,
  binding: ExecutionModelBinding,
): RequestedModelSelection {
  if (explicit !== undefined) {
    return { ...explicit, selection: { ...explicit.selection } };
  }
  return {
    mode: binding.summary.resolution === "session_override" ? "session_override" : "profile_default",
    selection: { ...binding.summary.selection },
  };
}

function queueDispatchEligible(
  lastExecution: SessionExecutionRecord | undefined,
  pendingMessages: readonly PendingSessionMessage[],
  queueDispatchBarrierAt: number | undefined,
): boolean {
  if (queueDispatchBarrierAt !== undefined
    && (lastExecution === undefined || lastExecution.startedAt <= queueDispatchBarrierAt)) {
    return pendingMessages.some((message) => message.acceptedAt > queueDispatchBarrierAt);
  }
  if (lastExecution === undefined) return true;
  if (lastExecution.status === "running" || lastExecution.status === "suspended") return false;
  const terminalExecution = lastExecution;
  if (lastExecution.status === "completed" && lastExecution.stopRequestedAt === undefined) return true;
  const dispatchBarrier = Math.max(
    terminalExecution.endedAt,
    terminalExecution.stopRequestedAt ?? 0,
  );
  return pendingMessages.some((message) => message.acceptedAt > dispatchBarrier);
}

function hasExactChildDependency(
  state: Pick<SessionStoreState, "toolBatches">,
  input: {
    readonly parentExecutionId: string;
    readonly parentRunOrdinal: number;
    readonly parentToolBatchId: string;
    readonly parentToolCallId: string;
    readonly childSessionId: string;
    readonly childExecutionId: string;
  },
): boolean {
  const batch = state.toolBatches.find((candidate) =>
    candidate.archivedAt === undefined
    && candidate.batchId === input.parentToolBatchId
    && candidate.executionId === input.parentExecutionId
    && candidate.runOrdinal === input.parentRunOrdinal
  );
  const call = batch?.calls.find((candidate) => candidate.toolCallId === input.parentToolCallId);
  const dependency = call?.childDependency;
  return call?.state === "child_dependency"
    && dependency?.kind === "child_dependency"
    && dependency.parentExecutionId === input.parentExecutionId
    && dependency.runOrdinal === input.parentRunOrdinal
    && dependency.toolCallId === input.parentToolCallId
    && dependency.childSessionId === input.childSessionId
    && dependency.childExecutionId === input.childExecutionId;
}

function isMissingSessionError(error: unknown): boolean {
  return error instanceof SessionFileNotFoundError
    || (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    );
}

function abortExecutionStatus(signal: AbortSignal): "aborted" | "cancelled" | "timed_out" {
  const reason = signal.reason;
  if (reason instanceof Error) {
    if (/timed out/i.test(reason.message)) return "timed_out";
    if (/cancelled|canceled|aborted/i.test(reason.message)) return "cancelled";
  }
  return "aborted";
}

function appendTerminalReminder(
  parentStore: StoreApi<SessionStoreState>,
  sessionId: string,
  childExecutionId: string,
  status: SubAgentTerminalStatus,
  error?: string,
): void {
  if (parentStore.getState().reminders.some((reminder) =>
    reminder.sessionId === sessionId
    && reminder.source.type.startsWith("subagent_")
    && "childExecutionId" in reminder.source
    && reminder.source.childExecutionId === childExecutionId
  )) return;
  const reminder: Reminder = {
    id: crypto.randomUUID(),
    source: status === "completed"
      ? { type: "subagent_completed", sessionId, childExecutionId }
      : status === "timed_out"
        ? { type: "subagent_timed_out", sessionId, childExecutionId }
        : status === "cancelled"
          ? { type: "subagent_cancelled", sessionId, childExecutionId }
          : { type: "subagent_failed", sessionId, childExecutionId },
    delivery: "on_demand",
    sessionId,
    terminalState: status,
    content: error ?? `Sub-agent ${sessionId} ${formatStatus(status)}. Use background_output(session_id="${sessionId}") to read the result.`,
    createdAt: Date.now(),
    consumedAt: null,
    targetSessionId: parentStore.getState().sessionId,
  };
  parentStore.getState().append({ type: "reminder", reminder });
}

function appendQueueDispatchBlockedReminder(
  parentStore: StoreApi<SessionStoreState>,
  sessionId: string,
  blockedAfterExecutionId: string,
  error: string,
): void {
  if (parentStore.getState().reminders.some((reminder) =>
    reminder.source.type === "queue_dispatch_blocked"
    && reminder.source.sessionId === sessionId
    && reminder.source.blockedAfterExecutionId === blockedAfterExecutionId
  )) return;
  parentStore.getState().append({
    type: "reminder",
    reminder: {
      id: crypto.randomUUID(),
      source: {
        type: "queue_dispatch_blocked",
        sessionId,
        blockedAfterExecutionId,
        error,
      },
      delivery: "on_demand",
      sessionId,
      terminalState: "queue_dispatch_blocked",
      content: `Sub-agent ${sessionId} Queue dispatch is blocked after execution ${blockedAfterExecutionId}: ${error}`,
      createdAt: Date.now(),
      consumedAt: null,
      targetSessionId: parentStore.getState().sessionId,
    },
  });
}

function formatStatus(status: SubAgentTerminalStatus): string {
  if (status === "timed_out") return "timed out";
  return status;
}

function queueDispatchErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500) || "Queue dispatch admission failed";
}

function assertQueuedChildDispatchInput(
  state: SessionStoreState,
  pending: readonly PendingSessionMessage[],
): void {
  if (state.parentSessionId === undefined || state.title === null) {
    throw new DelegationExecutionAdmissionError(
      "DELEGATION_IDENTITY_REQUIRED",
      `Queued child Session "${state.sessionId}" has no complete durable delegation identity`,
    );
  }
  if (pending.some((message) => (
    message.source !== "parent_agent"
    || message.parentAgentProvenance?.senderSessionId !== state.parentSessionId
  ))) {
    throw new DelegationExecutionAdmissionError(
      "DELEGATION_IDENTITY_REQUIRED",
      `Queued child Session "${state.sessionId}" contains input without exact direct-parent provenance`,
    );
  }
}

function toChildExecutionOutcome(
  store: StoreApi<SessionStoreState>,
  executionId: string,
): ChildExecutionOutcome {
  const state = store.getState();
  const execution = state.executions.find((candidate) => candidate.id === executionId);
  if (execution === undefined || execution.status === "running") {
    throw new Error(`Session "${state.sessionId}" has no stopped execution outcome for "${executionId}"`);
  }
  if (execution.status === "suspended") {
    if (execution.suspension.kind === "resume_pending") {
      throw new Error(`Session "${state.sessionId}" stopped after its dependency became resume-pending`);
    }
    return {
      outcome: "suspended",
      executionId,
      suspension: execution.suspension,
    };
  }
  const output = finalOutputForExecution(state, executionId);
  return {
    outcome: "terminal",
    executionId,
    executionStatus: execution.status,
    ...(output === undefined ? {} : { output }),
    ...(execution.error === undefined ? {} : { terminalError: execution.error }),
  };
}

function scheduleActiveExecutionTimeout(
  state: Readonly<SessionStoreState>,
  execution: ActiveSessionExecution,
  deadlineScheduler: SessionExecutionDeadlineScheduler,
): SessionExecutionDeadlineHandle | undefined {
  const record = state.executions.find((candidate) => candidate.id === execution.executionId);
  const run = record?.runs[execution.runOrdinal];
  if (
    record?.status !== "running"
    || record.activeTimeoutMs === undefined
    || run === undefined
    || run.endedAt !== undefined
  ) return undefined;
  const currentRunDurationMs = Math.max(0, deadlineScheduler.now() - run.startedAt);
  const remainingMs = record.activeTimeoutMs - record.durationMs - currentRunDurationMs;
  if (remainingMs <= 0) {
    execution.abortController.abort(new Error("Sub-agent timed out"));
    return undefined;
  }
  return deadlineScheduler.schedule(
    remainingMs,
    () => execution.abortController.abort(new Error("Sub-agent timed out")),
  );
}

async function waitForExecutionToStop(
  execution: ActiveSessionExecution | PendingSessionExecution,
  deadlineScheduler: SessionExecutionDeadlineScheduler,
): Promise<void> {
  let timeoutHandle: SessionExecutionDeadlineHandle | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = deadlineScheduler.schedule(
      ABORT_AND_WAIT_TIMEOUT_MS,
      () => reject(new Error(`Timed out waiting for session "${execution.sessionId}" to abort`)),
    );
  });
  try {
    await Promise.race([execution.promise ?? Promise.resolve(), timeout]);
  } finally {
    if (timeoutHandle !== undefined) deadlineScheduler.cancel(timeoutHandle);
  }
}

function inputCommandForStop(
  command: ActiveSessionCommand | undefined,
  exemptSessionId: string | undefined,
): ActiveSessionCommand | undefined {
  return command?.rootSessionId === exemptSessionId ? undefined : command;
}

async function waitForCommandToStop(
  command: ActiveSessionCommand,
  deadlineScheduler: SessionExecutionDeadlineScheduler,
): Promise<void> {
  let timeoutHandle: SessionExecutionDeadlineHandle | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = deadlineScheduler.schedule(
      ABORT_AND_WAIT_TIMEOUT_MS,
      () => reject(new Error(`Timed out waiting for session command "${command.clientRequestId}" to abort`)),
    );
  });
  try {
    await Promise.race([Promise.allSettled([command.completion]).then(() => undefined), timeout]);
  } finally {
    if (timeoutHandle !== undefined) deadlineScheduler.cancel(timeoutHandle);
  }
}

async function raceAbort<T>(promise: Promise<T>, abort: AbortSignal): Promise<T> {
  if (abort.aborted) throw createAbortError(abort);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError(abort));
    };
    const cleanup = () => {
      abort.removeEventListener("abort", onAbort);
    };
    abort.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function waitForMessageDisposition(
  store: StoreApi<SessionStoreState>,
  messageId: string,
  expectedExecutionId: string,
  executionPromise: Promise<void>,
): Promise<"steered" | "queued"> {
  const current = (): "steered" | "queued" | undefined => {
    const state = store.getState();
    const canonical = state.messages.find((message) => message.id === messageId);
    if (canonical !== undefined) {
      return canonical.executionId === expectedExecutionId ? "steered" : "queued";
    }
    const pending = state.pendingMessages.find((message) => message.id === messageId);
    return pending?.state === "queued" ? "queued" : undefined;
  };
  const immediate = current();
  if (immediate !== undefined) return immediate;
  return await new Promise<"steered" | "queued">((resolve) => {
    let settled = false;
    const finish = (delivery: "steered" | "queued") => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(delivery);
    };
    const check = () => {
      const delivery = current();
      if (delivery !== undefined) finish(delivery);
    };
    const unsubscribe = store.subscribe(check);
    void executionPromise.finally(check);
    check();
  });
}

function createAbortError(signal?: AbortSignal): DOMException {
  const reason = signal?.reason;
  if (reason instanceof DOMException) return reason;
  if (reason instanceof Error) return new DOMException(reason.message, "AbortError");
  return new DOMException("The operation was aborted.", "AbortError");
}
