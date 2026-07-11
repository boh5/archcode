import { rm } from "node:fs/promises";
import type { SessionExecutionRecord, SessionFamilyActivity, SessionTreeNode, SessionTreeResponse, ToolChildSessionLink, ToolChildSessionLinkStatus } from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import {
  AgentChildPolicyMissingError,
  AgentRunningError,
  ChildSessionAgentMismatchError,
  ChildSessionCwdMismatchError,
  ChildSessionLoopScopeMismatchError,
  ChildSessionNotFoundError,
  ChildSessionNotDescendantError,
  ChildSessionParentMismatchError,
  ConcurrentLimitError,
  DelegateTargetNotAllowedError,
  DelegationToolNotAllowedError,
  DepthLimitError,
  SessionCwdTransitionConflictError,
  SessionCwdTransitionInProgressError,
  SessionHitlBlockedError,
  SessionHitlCancelOnlyLeaseError,
  SessionHitlResumeIdentityMismatchError,
  SessionHitlResumeConflictError,
  SessionHitlResumeInProgressError,
  SessionHitlResumeLeaseExpiredError,
  SessionHitlResumeLeaseNotActivatedError,
} from "../agents/errors";
import type { AgentResult } from "../agents/types";
import type { SlashCommandResult } from "../commands/types";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";
import { SessionEventBridge } from "../events/session-event-bridge";
import type { SubscribeSessionEventsInput } from "../events/session-event-bridge";
import { getSessionDir } from "../store/sessions-dir";
import { NotRootSessionError, SessionDeleteConflictError } from "../store/errors";
import { scopedKey } from "../store/key";
import type { Reminder, SessionRole, SessionStoreState } from "../store/types";
import type { StoredMessage } from "../store/types";
import type { ToolExecutionOrigin } from "../tools/types";
import type { AgentName } from "../agents/names";
import type { Logger } from "../logger";
import {
  SessionExecutionScopeConflictError,
  type SessionExecutionScopeValidator,
} from "./session-execution-scope-validator";
import {
  SessionDeleteInProgressError,
  type SessionDeletionPreflight,
} from "./session-deletion";
import {
  SessionFamilyActiveError,
  SessionFamilyIdentityUnavailableError,
  SessionFamilyStopConflictError,
  SessionFamilyStopInProgressError,
  type AcquireSessionFamilyStopInput,
  type SessionFamilyStopLease,
} from "./session-family-control";
import {
  SessionWorkspaceClosingError,
  type SessionWorkspaceCloseLease,
} from "./session-workspace-control";

const ABORT_AND_WAIT_TIMEOUT_MS = 10000;
const MAX_CWD_TRANSITIONS_PER_EXECUTION = 4;

const TERMINAL_CHILD_LINK_STATUSES = new Set<ToolChildSessionLinkStatus>([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
]);

export type SessionExecutionOrigin =
  | "user_message"
  | "tool_call";

export interface ActiveSessionExecution {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly workspaceRoot: string;
  readonly agentName: AgentName;
  readonly origin: SessionExecutionOrigin;
  readonly abortController: AbortController;
  readonly promise: Promise<void>;
  readonly executionToken: symbol;
  readonly startedAt: number;
  /** Durable id shared with the Session execution-start record. */
  readonly executionId?: string;
}

export interface SessionHitlResumeLease {
  /** Unique in-process generation guarding stale releases. */
  readonly generation: symbol;
  readonly abortSignal: AbortSignal;
  /** Validates the asynchronously loaded Session identity before replay. */
  activate(): void;
  /** The only cwd transition allowed while this resume generation is active. */
  acquireSessionCwdTransition(workspaceRoot: string, sessionId: string): () => void;
  release(): void;
}

export interface ReserveSessionHitlResumeOptions {
  /**
   * Serializes a durable acknowledgement without permitting replay. This mode
   * may bypass stale child/root cwd alignment because the caller must not run
   * tools, the model, or a cwd transition.
   */
  readonly mode?: "replay" | "cancel_only";
}

// Session execution lifecycle:
//   active execution: starting -> running -> cancelling -> completed | failed | cancelled | timed_out | interrupted
//   parent link:      linked   -> running -> waiting_for_human -> running -> terminal
// `executionToken` is the generation guard for every manager-owned completion path:
// stale promises may resolve after abort/restart, but must not write terminal execution
// events, child links, reminders, or deferred-request cleanup for a newer generation.

export interface StartSessionExecutionInput {
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly userMessage: string;
  readonly origin?: SessionExecutionOrigin | ToolExecutionOrigin;
  readonly maxSteps?: number;
  readonly extraTools?: readonly string[];
  /** Caller-supplied durable attempt id when an owner must checkpoint before start. */
  readonly executionId?: string;
}

interface PendingSessionExecution extends Omit<ActiveSessionExecution, "promise"> {
  promise?: Promise<void>;
  familyStopLease?: SessionFamilyStopLease;
}

interface SessionCwdTransitionLeaseState {
  readonly token: symbol;
  readonly blockRootExecution: boolean;
}

interface SessionHitlResumeLeaseState {
  readonly token: symbol;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly mode: "replay" | "cancel_only";
  readonly abortController: AbortController;
  readonly completed: Promise<void>;
  readonly complete: () => void;
  activated: boolean;
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

interface PendingChildLaunchFamilyState {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly launches: Map<symbol, string>;
}

export interface SessionRuntimeChange {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly activity: SessionFamilyActivity;
}

export type SessionRuntimeChangeListener = (change: SessionRuntimeChange) => void;

interface SessionExecutionManagerConfig {
  readonly sessionAgentManager: SessionAgentManager;
  readonly createSessionStore: (
    sessionId: string,
    workspaceRoot: string,
    options: {
      readonly rootSessionId?: string;
      readonly parentSessionId?: string;
      readonly cwd?: string;
      readonly goalId?: string;
      readonly loopId?: string;
      readonly sessionRole?: SessionStoreState["sessionRole"];
      readonly agentName: AgentName;
      readonly title?: string;
    },
  ) => StoreApi<SessionStoreState>;
  /** Durability barrier for a freshly created Session snapshot. */
  readonly flushSessionStore: (sessionId: string, workspaceRoot: string) => Promise<void>;
  readonly getSessionStore: (sessionId: string, workspaceRoot: string) => StoreApi<SessionStoreState> | undefined;
  readonly loadSessionStore: (sessionId: string, workspaceRoot: string) => Promise<StoreApi<SessionStoreState>>;
  readonly deleteSessionStore: (
    sessionId: string,
    workspaceRoot: string,
    options?: { readonly forgetWorkspaceIndex?: boolean },
  ) => boolean;
  readonly resolveRootSessionId: (sessionId: string, workspaceRoot: string) => Promise<string>;
  readonly buildSessionTree: (workspaceRoot: string, rootSessionId: string) => Promise<SessionTreeResponse>;
  readonly trackSession: (workspaceRoot: string, sessionId: string) => void;
  readonly untrackSession: (workspaceRoot: string, sessionId: string) => void;
  readonly executionScopeValidator: Pick<SessionExecutionScopeValidator, "validate">;
  readonly executionClaimCoordinator?: SessionExecutionClaimCoordinator;
  readonly sessionHitlExecutionGate?: {
    assertAllowed(workspaceRoot: string, sessionId: string): Promise<void>;
  };
  readonly deletionPreflight?: SessionDeletionPreflight;
  readonly sessionFamilyStopTimeoutMs?: number;
  readonly logger: Logger;
}

export interface SessionExecutionClaimCoordinator {
  run<T>(ownerId: string, action: () => Promise<T>): Promise<T>;
}

export class SessionExecutionManager {
  readonly #active = new Map<string, ActiveSessionExecution | PendingSessionExecution>();
  readonly #childSlots = new Map<string, number>();
  readonly #cwdTransitions = new Map<string, SessionCwdTransitionLeaseState>();
  readonly #hitlResumes = new Map<string, SessionHitlResumeLeaseState>();
  readonly #pendingChildLaunches = new Map<string, PendingChildLaunchFamilyState>();
  readonly #deletions = new Map<string, SessionDeletionLeaseState>();
  readonly #familyStops = new Map<string, SessionFamilyStopLeaseState>();
  readonly #workspaceClosures = new Map<string, symbol>();
  readonly #pendingCheckedStarts = new Map<symbol, { workspaceRoot: string; sessionId: string }>();
  readonly #runtimeChangeListeners = new Set<SessionRuntimeChangeListener>();
  readonly #eventBridge: SessionEventBridge;
  readonly #config: SessionExecutionManagerConfig;
  readonly #logger: Logger;

  constructor(config: SessionExecutionManagerConfig) {
    this.#config = config;
    this.#logger = config.logger;
    this.#eventBridge = new SessionEventBridge({
      getStore: (workspaceRoot, sessionId) => this.#config.getSessionStore(sessionId, workspaceRoot),
    });
  }

  startExecution(input: StartSessionExecutionInput): ActiveSessionExecution {
    this.#assertWorkspaceOpen(input.workspaceRoot);
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    if (this.#active.has(key)) {
      throw new AgentRunningError();
    }
    const sessionState = this.#config.getSessionStore(input.sessionId, input.workspaceRoot)?.getState();
    if (sessionState === undefined) throw new SessionFamilyIdentityUnavailableError(input.sessionId);
    this.#assertSessionStartAllowed(input.workspaceRoot, input.sessionId, sessionState);
    const rootSessionId = sessionState.rootSessionId;
    const previousFamilyActivity = this.getSessionFamilyActivity(input.workspaceRoot, rootSessionId);

    const abortController = new AbortController();
    const executionToken = Symbol(`session-execution:${key}`);
    const pending: PendingSessionExecution = {
      sessionId: input.sessionId,
      rootSessionId,
      workspaceRoot: input.workspaceRoot,
      agentName: sessionState.agentName,
      origin: sessionExecutionOrigin(input.origin),
      abortController,
      executionToken,
      startedAt: Date.now(),
      executionId: input.executionId ?? crypto.randomUUID(),
    };

    this.#active.set(key, pending);
    this.#publishSessionRuntimeChange(input.workspaceRoot, rootSessionId, previousFamilyActivity);

    let slotAcquired = false;
    try {
      this.#config.sessionAgentManager.acquireSlot(input.workspaceRoot, input.sessionId);
      slotAcquired = true;
      this.#config.trackSession(input.workspaceRoot, input.sessionId);

      const promise = this.#runExecution(input, pending).finally(() => {
        this.#finalizeExecution(key, pending, slotAcquired);
      });
      const execution: ActiveSessionExecution = { ...pending, promise };
      this.#active.set(key, execution);
      return execution;
    } catch (error) {
      if (slotAcquired) this.#config.sessionAgentManager.releaseSlot(input.workspaceRoot, input.sessionId);
      const activityBeforeRollback = this.getSessionFamilyActivity(input.workspaceRoot, rootSessionId);
      this.#active.delete(key);
      this.#publishSessionRuntimeChange(input.workspaceRoot, rootSessionId, activityBeforeRollback);
      throw error;
    }
  }

  /**
   * User-message entry point. It cold-loads canonical Session identity before
   * synchronously claiming execution, so a child can never continue in a cwd
   * abandoned by its root Session.
   */
  async startCheckedExecution(input: StartSessionExecutionInput): Promise<ActiveSessionExecution> {
    this.#assertWorkspaceOpen(input.workspaceRoot);
    const pendingToken = Symbol(`checked-session-start:${input.sessionId}`);
    this.#pendingCheckedStarts.set(pendingToken, {
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
    });
    try {
      const store = await this.#config.loadSessionStore(input.sessionId, input.workspaceRoot);
      const loadedState = store.getState();
      if (loadedState.parentSessionId !== undefined) {
        await this.#config.loadSessionStore(loadedState.rootSessionId, input.workspaceRoot);
      }
      await this.#config.sessionHitlExecutionGate?.assertAllowed(input.workspaceRoot, input.sessionId);
      const claimedScope = executionScopeSnapshot(store.getState());
      const claimGoalId = claimedScope.goalId;
      const validateAndStart = async (): Promise<ActiveSessionExecution> => {
      const validationState = store.getState();
      const validationScope = executionScopeSnapshot(validationState);
      if (!sameExecutionScopeSnapshot(claimedScope, validationScope)) {
        throw executionScopeChanged(validationState.sessionId, claimedScope, validationScope);
      }
      const isDescendantOfRoot = validationState.goalId !== undefined && validationState.parentSessionId !== undefined
        ? flattenSessionTree((await this.#config.buildSessionTree(input.workspaceRoot, validationState.rootSessionId)).root)
          .includes(validationState.sessionId)
        : undefined;
      await this.#config.executionScopeValidator.validate({
        projectRoot: input.workspaceRoot,
        subject: executionScopeSubject(validationState, isDescendantOfRoot),
        entry: {
          kind: "user_message",
          ...(isToolExecutionOrigin(input.origin) ? { origin: input.origin } : {}),
        },
      });

      const currentState = store.getState();
      const previousScope = executionScopeSnapshot(validationState);
      const currentScope = executionScopeSnapshot(currentState);
      if (!sameExecutionScopeSnapshot(previousScope, currentScope)) {
        throw executionScopeChanged(currentState.sessionId, previousScope, currentScope);
      }
      if (this.#config.getSessionStore(currentState.sessionId, input.workspaceRoot) !== store) {
        throw executionScopeChanged(currentState.sessionId, previousScope, currentScope, ["sessionRegistration"]);
      }
      this.#assertSessionFamilyCwdAligned(input.workspaceRoot, input.sessionId, currentState);
      const activity = this.getSessionFamilyActivity(input.workspaceRoot, currentState.rootSessionId);
      if (activity !== "idle") {
        throw new SessionFamilyActiveError(input.sessionId, currentState.rootSessionId, activity);
      }

      // Deliberately no await between the final identity check and this claim.
      // startExecution re-checks cwd/HITL leases synchronously before publishing
      // the active generation.
      return this.startExecution(input);
      };

      return claimGoalId === undefined || this.#config.executionClaimCoordinator === undefined
        ? await validateAndStart()
        : await this.#config.executionClaimCoordinator.run(claimGoalId, validateAndStart);
    } finally {
      this.#pendingCheckedStarts.delete(pendingToken);
    }
  }

  #cancelSessionSubtree(workspaceRoot: string, sessionId: string): boolean {
    const executions = this.#collectActiveCascade(workspaceRoot, sessionId);
    const resumes = this.#collectHitlResumeCascade(workspaceRoot, sessionId);
    if (executions.length === 0 && resumes.length === 0) return false;

    for (const execution of executions) this.#cancelExecution(execution, "Session cancelled");
    for (const resume of resumes) resume.abortController.abort(new Error("Session cancelled"));
    return true;
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
    const key = scopedKey(input.workspaceRoot, input.rootSessionId);
    if (this.#familyStops.has(key)) {
      throw new SessionFamilyStopInProgressError(input.exemptSessionId ?? input.rootSessionId, input.rootSessionId);
    }
    if (this.#deletions.has(key)) {
      throw new SessionDeleteInProgressError(input.exemptSessionId ?? input.rootSessionId, input.rootSessionId);
    }

    const token = Symbol(`session-family-stop:${key}`);
    const previousFamilyActivity = this.getSessionFamilyActivity(input.workspaceRoot, input.rootSessionId);
    this.#familyStops.set(key, {
      token,
      workspaceRoot: input.workspaceRoot,
      rootSessionId: input.rootSessionId,
      ...(input.exemptSessionId === undefined ? {} : { exemptSessionId: input.exemptSessionId }),
    });
    this.#publishSessionRuntimeChange(input.workspaceRoot, input.rootSessionId, previousFamilyActivity);
    let released = false;
    return {
      rootSessionId: input.rootSessionId,
      stopAndWait: async () => {
        if (released || this.#familyStops.get(key)?.token !== token) {
          throw new SessionFamilyStopInProgressError(input.exemptSessionId ?? input.rootSessionId, input.rootSessionId);
        }
        await this.#stopSessionFamily(input.workspaceRoot, input.rootSessionId, input.exemptSessionId);
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.#familyStops.get(key)?.token === token) {
          const activityBeforeRelease = this.getSessionFamilyActivity(input.workspaceRoot, input.rootSessionId);
          this.#familyStops.delete(key);
          this.#publishSessionRuntimeChange(input.workspaceRoot, input.rootSessionId, activityBeforeRelease);
        }
      },
    };
  }

  /** Linearization gate used by project removal before it inspects live families. */
  acquireWorkspaceClose(workspaceRoot: string): SessionWorkspaceCloseLease {
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

  async abortAll(): Promise<void> {
    const executions = [...this.#active.values()];
    const resumes = [...this.#hitlResumes.values()];
    for (const execution of executions) this.#cancelExecution(execution, "Session cancelled");
    for (const resume of resumes) resume.abortController.abort(new Error("Session cancelled"));

    await Promise.allSettled([
      ...executions.map((execution) => execution.promise),
      ...resumes.map((resume) => resume.completed),
    ]);
  }

  getSessionFamilyActivity(workspaceRoot: string, rootSessionId: string): SessionFamilyActivity {
    const key = scopedKey(workspaceRoot, rootSessionId);
    if (this.#familyStops.has(key)) return "stopping";
    if ((this.#pendingChildLaunches.get(key)?.launches.size ?? 0) > 0) return "running";
    if (this.#hitlResumes.has(key)) return "running";
    for (const execution of this.#active.values()) {
      if (execution.workspaceRoot === workspaceRoot && execution.rootSessionId === rootSessionId) return "running";
    }
    return "idle";
  }

  listSessionFamilyActivities(): readonly SessionRuntimeChange[] {
    const families = new Map<string, { workspaceRoot: string; rootSessionId: string }>();
    for (const execution of this.#active.values()) {
      const key = scopedKey(execution.workspaceRoot, execution.rootSessionId);
      families.set(key, { workspaceRoot: execution.workspaceRoot, rootSessionId: execution.rootSessionId });
    }
    for (const pending of this.#pendingChildLaunches.values()) {
      const key = scopedKey(pending.workspaceRoot, pending.rootSessionId);
      families.set(key, { workspaceRoot: pending.workspaceRoot, rootSessionId: pending.rootSessionId });
    }
    for (const resume of this.#hitlResumes.values()) {
      const key = scopedKey(resume.workspaceRoot, resume.rootSessionId);
      families.set(key, { workspaceRoot: resume.workspaceRoot, rootSessionId: resume.rootSessionId });
    }
    for (const stop of this.#familyStops.values()) {
      const key = scopedKey(stop.workspaceRoot, stop.rootSessionId);
      families.set(key, { workspaceRoot: stop.workspaceRoot, rootSessionId: stop.rootSessionId });
    }
    return [...families.values()]
      .map(({ workspaceRoot, rootSessionId }) => ({
        workspaceRoot,
        rootSessionId,
        activity: this.getSessionFamilyActivity(workspaceRoot, rootSessionId),
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

  /**
   * Claims exclusive ownership of a Session family for durable HITL replay and
   * continuation. The returned capability permits exactly this generation to
   * nest the worktree transition required by an approved worktree tool.
   */
  reserveSessionHitlResume(
    workspaceRoot: string,
    sessionId: string,
    rootSessionId: string,
    options: ReserveSessionHitlResumeOptions = {},
  ): SessionHitlResumeLease {
    this.#assertWorkspaceOpen(workspaceRoot);
    const mode = options.mode ?? "replay";
    const loadedState = this.#config.getSessionStore(sessionId, workspaceRoot)?.getState();
    if (loadedState !== undefined && loadedState.rootSessionId !== rootSessionId) {
      throw new SessionHitlResumeIdentityMismatchError(sessionId, rootSessionId, loadedState.rootSessionId);
    }
    const key = scopedKey(workspaceRoot, rootSessionId);
    if (this.#familyStops.has(key)) {
      throw new SessionFamilyStopInProgressError(sessionId, rootSessionId);
    }
    if (this.#deletions.has(key)) {
      throw new SessionDeleteInProgressError(sessionId, rootSessionId);
    }
    if (this.#hitlResumes.has(key)) {
      throw new SessionHitlResumeInProgressError(sessionId, rootSessionId);
    }
    if (this.#cwdTransitions.has(key)) {
      throw new SessionCwdTransitionInProgressError(sessionId, rootSessionId);
    }

    const conflictingSessionIds = new Set(this.#pendingChildLaunches.get(key)?.launches.values() ?? []);
    for (const execution of this.#active.values()) {
      if (execution.workspaceRoot !== workspaceRoot) continue;
      if (execution.rootSessionId === rootSessionId) {
        conflictingSessionIds.add(execution.sessionId);
      }
    }
    if (conflictingSessionIds.size > 0) {
      throw new SessionHitlResumeConflictError(sessionId, [...conflictingSessionIds].sort());
    }

    const token = Symbol(`session-hitl-resume:${key}`);
    const abortController = new AbortController();
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    const previousFamilyActivity = this.getSessionFamilyActivity(workspaceRoot, rootSessionId);
    this.#hitlResumes.set(key, {
      token,
      workspaceRoot,
      sessionId,
      rootSessionId,
      mode,
      abortController,
      completed,
      complete,
      activated: false,
    });
    this.#publishSessionRuntimeChange(workspaceRoot, rootSessionId, previousFamilyActivity);
    let released = false;
    return {
      generation: token,
      abortSignal: abortController.signal,
      activate: () => {
        const current = this.#hitlResumes.get(key);
        if (released || current?.token !== token) {
          throw new SessionHitlResumeLeaseExpiredError(sessionId, rootSessionId);
        }
        abortController.signal.throwIfAborted();
        const state = this.#config.getSessionStore(sessionId, workspaceRoot)?.getState();
        if (state === undefined || state.rootSessionId !== rootSessionId) {
          throw new SessionHitlResumeIdentityMismatchError(sessionId, rootSessionId, state?.rootSessionId);
        }
        if (mode !== "cancel_only") this.#assertSessionFamilyCwdAligned(workspaceRoot, sessionId, state);
        current.activated = true;
      },
      acquireSessionCwdTransition: (nestedWorkspaceRoot, nestedSessionId) => {
        if (released || this.#hitlResumes.get(key)?.token !== token) {
          throw new SessionHitlResumeLeaseExpiredError(sessionId, rootSessionId);
        }
        if (this.#hitlResumes.get(key)?.activated !== true) {
          throw new SessionHitlResumeLeaseNotActivatedError(sessionId, rootSessionId);
        }
        if (mode === "cancel_only") {
          throw new SessionHitlCancelOnlyLeaseError(sessionId, rootSessionId);
        }
        if (nestedWorkspaceRoot !== workspaceRoot || nestedSessionId !== rootSessionId) {
          throw new SessionHitlResumeInProgressError(nestedSessionId, rootSessionId);
        }
        return this.#acquireSessionCwdTransition(workspaceRoot, rootSessionId, false, token);
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.#hitlResumes.get(key)?.token === token) {
          const activityBeforeRelease = this.getSessionFamilyActivity(workspaceRoot, rootSessionId);
          this.#hitlResumes.delete(key);
          this.#publishSessionRuntimeChange(workspaceRoot, rootSessionId, activityBeforeRelease);
        }
        complete();
      },
    };
  }

  #acquireSessionCwdTransition(
    workspaceRoot: string,
    sessionId: string,
    blockRootExecution: boolean,
    hitlResumeToken?: symbol,
  ): () => void {
    const key = scopedKey(workspaceRoot, sessionId);
    if (this.#familyStops.has(key)) {
      throw new SessionFamilyStopInProgressError(sessionId, sessionId);
    }
    if (this.#deletions.has(key)) {
      throw new SessionDeleteInProgressError(sessionId, sessionId);
    }
    const hitlResume = this.#hitlResumes.get(key);
    if (hitlResume !== undefined && hitlResume.token !== hitlResumeToken) {
      throw new SessionHitlResumeInProgressError(sessionId, hitlResume.rootSessionId);
    }
    if (this.#cwdTransitions.has(key)) {
      throw new SessionCwdTransitionInProgressError(sessionId, sessionId);
    }

    const conflictingSessionIds = new Set(this.#pendingChildLaunches.get(key)?.launches.values() ?? []);
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
    const factory = this.#config.sessionAgentManager.getFactory(workspaceRoot);
    const currentDepth = request.currentDepth ?? 0;
    const parentAgentName = request.parentStore.getState().agentName;
    const parentDefinition = factory.getDefinition(parentAgentName);
    const allowedTools = factory.resolveAllowedTools(parentDefinition, currentDepth);

    if (!allowedTools.includes("delegate")) {
      throw new DelegationToolNotAllowedError(parentAgentName, currentDepth);
    }

    const delegateTargets = factory.getDelegateTargetsFor(parentDefinition, currentDepth);
    if (!delegateTargets.includes(request.targetAgentName)) {
      throw new DelegateTargetNotAllowedError(parentAgentName, request.targetAgentName, currentDepth);
    }

    const targetDefinition = factory.getDefinition(request.targetAgentName);
    const childPolicy = parentDefinition.childPolicy;
    if (childPolicy === undefined) {
      throw new AgentChildPolicyMissingError(parentAgentName);
    }

    if (currentDepth >= childPolicy.maxDepth) {
      throw new DepthLimitError(currentDepth);
    }

    const parentState = request.parentStore.getState();
    assertChildLoopScope({
      parentSessionId: request.parentSessionId,
      parentLoopId: parentState.loopId,
      childLoopId: parentState.loopId,
      origin: request.origin,
    });
    const childSessionId = crypto.randomUUID();
    const releaseChildLaunch = this.#reserveChildLaunch(
      workspaceRoot,
      parentState.rootSessionId,
      childSessionId,
    );
    let childLaunchReserved = true;
    let childSlotReserved = false;
    let parentSlotReserved = false;
    const background = request.background ?? false;
    const childTitle = request.title ?? request.description;
    const createdAt = Date.now();
    let childStore: StoreApi<SessionStoreState> | undefined;
    let execution: ActiveSessionExecution;

    try {
      const activeSkills = await factory.resolveDelegatedSkills(targetDefinition, request.skills, parentState.cwd);
      this.#reserveChildSlot(workspaceRoot, request.parentSessionId, childPolicy.maxConcurrent);
      childSlotReserved = true;
      this.#config.sessionAgentManager.acquireSlot(workspaceRoot, request.parentSessionId);
      parentSlotReserved = true;
      childStore = this.#config.createSessionStore(childSessionId, workspaceRoot, {
        cwd: parentState.cwd,
        rootSessionId: parentState.rootSessionId,
        parentSessionId: request.parentSessionId,
        goalId: parentState.goalId,
        loopId: parentState.loopId,
        sessionRole: sessionRoleForAgent(targetDefinition.name),
        agentName: targetDefinition.name,
        ...(childTitle === undefined ? {} : { title: childTitle }),
      });
      // A parent must never durably reference a child whose identity snapshot can
      // still disappear in the same-process crash window.
      await this.#config.flushSessionStore(childSessionId, workspaceRoot);
      this.#appendChildLinkStatus(workspaceRoot, request, childSessionId, targetDefinition.name, currentDepth + 1, "linked", childTitle, createdAt, background);
      this.#eventBridge.attachSession(workspaceRoot, childSessionId, childStore);

      this.#config.sessionAgentManager.createChildAgent({
        workspaceRoot,
        sessionId: childSessionId,
        agentName: targetDefinition.name,
        store: childStore,
        depth: currentDepth + 1,
        parentSessionId: request.parentSessionId,
        ...(childTitle === undefined ? {} : { title: childTitle }),
        activeSkills,
      });

      this.#config.sessionAgentManager.releaseSlot(workspaceRoot, request.parentSessionId);
      parentSlotReserved = false;
      execution = this.startExecution({
        slug: "",
        workspaceRoot,
        sessionId: childSessionId,
        userMessage: request.prompt,
        origin: request.origin ?? "tool_call",
      });
      this.#appendChildLinkStatus(workspaceRoot, request, childSessionId, targetDefinition.name, currentDepth + 1, "running", childTitle, createdAt, background);
      releaseChildLaunch();
      childLaunchReserved = false;
    } catch (error) {
      if (childLaunchReserved) releaseChildLaunch();
      if (parentSlotReserved) this.#config.sessionAgentManager.releaseSlot(workspaceRoot, request.parentSessionId);
      if (childSlotReserved) this.#releaseChildSlot(workspaceRoot, request.parentSessionId);
      if (childStore !== undefined) {
        this.#eventBridge.detachSession(workspaceRoot, childSessionId);
        this.#config.deleteSessionStore(childSessionId, workspaceRoot);
      }
      throw error;
    }

    const timeout = childPolicy.timeoutMs > 0
      ? setTimeout(() => execution.abortController.abort(new Error("Sub-agent timed out")), childPolicy.timeoutMs)
      : undefined;
    const removeParentAbort = childPolicy.abortCascade
      ? wireAbortCascade(request.parentAbort, execution.abortController)
      : () => {};

    const result = execution.promise
      .then(() => toAgentResult(childStore))
      .finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
        removeParentAbort();
        if (childSlotReserved) {
          this.#releaseChildSlot(workspaceRoot, request.parentSessionId);
          childSlotReserved = false;
        }
        const current = this.#active.get(scopedKey(workspaceRoot, childSessionId));
        if (current !== undefined && current.executionToken !== execution.executionToken) return;
        const status = childTerminalStatus(childStore.getState().executions.at(-1), execution.abortController.signal);
        this.#appendChildLinkStatus(workspaceRoot, request, childSessionId, targetDefinition.name, currentDepth + 1, status, childTitle, createdAt, background);
        if (background && childPolicy.terminalReminders && status !== "waiting_for_human") {
          appendTerminalReminder(request.parentStore, childSessionId, status);
        }
      });

    return {
      sessionId: childSessionId,
      store: childStore,
      result,
      abort: () => this.#cancelExecution(execution, "Sub-agent aborted"),
    };
  }

  /**
   * Projects a child-owned Session HITL continuation back onto the original
   * delegate link. The child and its immediate parent are cold-loaded so a
   * restart does not leave a durable `waiting_for_human` card stale.
   */
  async updateChildSessionLinkForHitl(
    workspaceRoot: string,
    childSessionId: string,
    status: ToolChildSessionLinkStatus,
  ): Promise<void> {
    const childStore = await this.#config.loadSessionStore(childSessionId, workspaceRoot);
    const childState = childStore.getState();
    const parentSessionId = childState.parentSessionId;
    if (parentSessionId === undefined) return;

    const parentStore = await this.#config.loadSessionStore(parentSessionId, workspaceRoot);
    const existing = [...parentStore.getState().childSessionLinks]
      .reverse()
      .find((link) => link.childSessionId === childSessionId);
    if (existing === undefined) {
      this.#logger.warn("session.child_link.hitl_missing", {
        context: { sessionId: childSessionId, parentSessionId },
        meta: { workspaceRoot, status },
      });
      return;
    }

    const now = Date.now();
    const run = childState.executions.at(-1);
    const { startedAt: _startedAt, endedAt: _endedAt, durationMs: _durationMs, error: _error, ...base } = existing;
    const isTerminal = isSubAgentTerminalStatus(status);
    const runMatchesStatus = childLinkStatusFromExecution(run) === status;
    const startedAt = status === "running"
      ? now
      : runMatchesStatus ? run?.startedAt : existing.startedAt ?? now;
    const endedAt = isTerminal || status === "waiting_for_human"
      ? runMatchesStatus ? run?.endedAt ?? now : now
      : undefined;
    const durationMs = endedAt === undefined || startedAt === undefined
      ? undefined
      : Math.max(0, endedAt - startedAt);
    parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        ...base,
        status,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(endedAt === undefined ? {} : { endedAt }),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(isTerminal && runMatchesStatus && run?.error !== undefined ? { error: run.error } : {}),
      },
    });
    if (isTerminal && existing.background) {
      const parentAgentName = parentStore.getState().agentName;
      const parentDefinition = this.#config.sessionAgentManager.getFactory(workspaceRoot).getDefinition(parentAgentName);
      if (parentDefinition.childPolicy?.terminalReminders) {
        appendTerminalReminder(parentStore, childSessionId, status);
      }
    }
    await this.#config.flushSessionStore(parentSessionId, workspaceRoot);
  }

  cancelChildSession(workspaceRoot: string, parentSessionId: string, childSessionId: string): boolean {
    if (!this.#isDescendantOf(workspaceRoot, childSessionId, parentSessionId)) {
      throw new ChildSessionNotDescendantError(parentSessionId, childSessionId);
    }
    return this.#cancelSessionSubtree(workspaceRoot, childSessionId);
  }

  async resumeChildExecution(workspaceRoot: string, request: ResumeChildRequest): Promise<ChildExecutionHandle> {
    const key = scopedKey(workspaceRoot, request.sessionId);
    if (this.#active.has(key)) throw new AgentRunningError();

    const childStore = this.#config.getSessionStore(request.sessionId, workspaceRoot);
    if (childStore === undefined) {
      throw new ChildSessionNotFoundError(workspaceRoot, request.sessionId);
    }
    const childState = childStore.getState();
    this.#assertSessionNotBlockedByHitl(request.sessionId, childState);
    if (childState.agentName !== request.targetAgentName) {
      throw new ChildSessionAgentMismatchError(request.sessionId, request.targetAgentName, childState.agentName);
    }
    if (childState.parentSessionId !== request.parentSessionId) {
      throw new ChildSessionParentMismatchError(request.sessionId, request.parentSessionId, childState.parentSessionId);
    }
    const parentState = request.parentStore.getState();
    assertChildLoopScope({
      parentSessionId: request.parentSessionId,
      parentLoopId: parentState.loopId,
      childSessionId: request.sessionId,
      childLoopId: childState.loopId,
      origin: request.origin,
    });
    const parentCwd = parentState.cwd;
    if (childState.cwd !== parentCwd) {
      throw new ChildSessionCwdMismatchError(request.sessionId, request.parentSessionId, parentCwd, childState.cwd);
    }

    const background = request.background ?? false;
    const parentAgentName = request.parentStore.getState().agentName;
    const parentDefinition = this.#config.sessionAgentManager.getFactory(workspaceRoot).getDefinition(parentAgentName);
    const existingLink = this.#findChildSessionLink(request.parentStore, request.sessionId);
    const resumeLinkCreatedAt = Date.now();
    const releaseChildLaunch = this.#reserveChildLaunch(
      workspaceRoot,
      parentState.rootSessionId,
      request.sessionId,
    );
    let childLaunchReserved = true;
    let execution: ActiveSessionExecution;
    try {
      this.#appendResumeChildLinkStatus(workspaceRoot, request, existingLink, "running", resumeLinkCreatedAt);
      await this.#config.sessionAgentManager.getOrCreate(workspaceRoot, request.sessionId);
      execution = this.startExecution({
        slug: "",
        workspaceRoot,
        sessionId: request.sessionId,
        userMessage: request.prompt,
        origin: request.origin ?? "tool_call",
      });
      releaseChildLaunch();
      childLaunchReserved = false;
    } catch (error) {
      if (childLaunchReserved) releaseChildLaunch();
      throw error;
    }

    const removeParentAbort = wireAbortCascade(request.parentAbort, execution.abortController);

    const result = execution.promise
      .then(() => toAgentResult(childStore))
      .finally(() => {
        removeParentAbort();
        const current = this.#active.get(scopedKey(workspaceRoot, request.sessionId));
        if (current !== undefined && current.executionToken !== execution.executionToken) return;
        const status = childTerminalStatus(childStore.getState().executions.at(-1), execution.abortController.signal);
        this.#appendResumeChildLinkStatus(workspaceRoot, request, existingLink, status, resumeLinkCreatedAt);
        if (background && parentDefinition.childPolicy?.terminalReminders && status !== "waiting_for_human") {
          appendTerminalReminder(request.parentStore, request.sessionId, status);
        }
      });

    return {
      sessionId: request.sessionId,
      store: childStore,
      result,
      abort: () => this.#cancelExecution(execution, "Sub-agent aborted"),
    };
  }

  async dispatchCommand(
    workspaceRoot: string,
    sessionId: string,
    name: string,
    args?: string,
  ): Promise<SlashCommandResult | null> {
    // Root-family ownership makes the root observable as busy while a child
    // resumes, but commands must still target the Session that is actually
    // executing rather than an idle ancestor.
    if (!this.#isDirectlyRunning(workspaceRoot, sessionId)) return null;
    return await this.#config.sessionAgentManager.dispatchCommand(workspaceRoot, sessionId, name, args);
  }

  subscribe(input: SubscribeSessionEventsInput): () => void {
    return this.#eventBridge.subscribe(input);
  }

  attachSessionEvents(workspaceRoot: string, sessionId: string, store: StoreApi<SessionStoreState>): void {
    this.#eventBridge.attachSession(workspaceRoot, sessionId, store);
  }

  detachSessionEvents(workspaceRoot: string, sessionId: string): void {
    if (this.#eventBridge.hasSubscriptions(workspaceRoot, sessionId)) return;
    this.#eventBridge.detachSession(workspaceRoot, sessionId);
  }

  async deleteSession(workspaceRoot: string, sessionId: string): Promise<void> {
    const rootSessionId = await this.#config.resolveRootSessionId(sessionId, workspaceRoot);
    const releaseDeletion = this.#acquireSessionDeletion(workspaceRoot, rootSessionId, sessionId);
    try {
      const tree = await this.#config.buildSessionTree(workspaceRoot, rootSessionId);
      const sessionIds = sessionId === rootSessionId
        ? flattenSessionTree(tree.root)
        : collectSubtreeSessionIds(tree.root, sessionId);

      if (sessionIds.length === 0) {
        throw new Error(`Session "${sessionId}" was not found in tree rooted at "${rootSessionId}"`);
      }

      await this.#config.deletionPreflight?.assertDeletable({ workspaceRoot, rootSessionId, sessionIds });

      const stuckSessionIds = await this.#cancelAndWaitForSessions(workspaceRoot, sessionIds);
      if (stuckSessionIds.length > 0) {
        throw new SessionDeleteConflictError(stuckSessionIds);
      }

      // Tools already in flight at the first preflight may durably create HITL
      // while quiescing. Revalidate only after every execution has stopped.
      await this.#config.deletionPreflight?.assertDeletable({ workspaceRoot, rootSessionId, sessionIds });

      for (const id of sessionIds) {
        this.#config.sessionAgentManager.dispose(workspaceRoot, id);
        this.#config.untrackSession(workspaceRoot, id);
        this.#eventBridge.detachSession(workspaceRoot, id);
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

  async #runExecution(input: StartSessionExecutionInput, execution: PendingSessionExecution): Promise<void> {
    try {
      const loopOrigin = isToolExecutionOrigin(input.origin) ? input.origin : undefined;
      let userMessage = input.userMessage;
      for (let transitionCount = 0; transitionCount <= MAX_CWD_TRANSITIONS_PER_EXECUTION; transitionCount += 1) {
        const agent = await this.#config.sessionAgentManager.getOrCreate(input.workspaceRoot, input.sessionId);
        this.#assertSessionStartAllowed(input.workspaceRoot, input.sessionId, agent.store.getState());
        this.#eventBridge.attachSession(input.workspaceRoot, input.sessionId, agent.store);
        if (execution.abortController.signal.aborted) return;

        const current = this.#active.get(scopedKey(input.workspaceRoot, input.sessionId));
        if (current?.executionToken !== execution.executionToken) return;

        if (!agent.store.getState().isRunning) {
          agent.store.getState().append({ type: "execution-start", executionId: execution.executionId });
        }
        if (execution.abortController.signal.aborted) return;

        const result = await agent.run(userMessage, {
          abort: execution.abortController.signal,
          ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
          ...(input.extraTools === undefined ? {} : { extraTools: input.extraTools }),
          ...(loopOrigin === undefined ? {} : { origin: loopOrigin }),
        });
        if (result.executionControl?.action === "stop_session_family") {
          const rootSessionId = execution.rootSessionId;
          const familyKey = scopedKey(input.workspaceRoot, rootSessionId);
          if (!this.#familyStops.has(familyKey)) {
            execution.familyStopLease = this.acquireSessionFamilyStop({
              workspaceRoot: input.workspaceRoot,
              rootSessionId,
              exemptSessionId: execution.sessionId,
            });
            await execution.familyStopLease.stopAndWait();
          }
          return;
        }
        if (result.cwdChanged === undefined) return;
        if (transitionCount === MAX_CWD_TRANSITIONS_PER_EXECUTION) {
          throw new Error(`Session cwd changed more than ${MAX_CWD_TRANSITIONS_PER_EXECUTION} times in one execution`);
        }
        this.#config.sessionAgentManager.releaseAgent(input.workspaceRoot, input.sessionId);
        userMessage = "";
      }
    } catch (error) {
      if (!execution.abortController.signal.aborted) {
        const current = this.#active.get(scopedKey(input.workspaceRoot, input.sessionId));
        if (current?.executionToken !== execution.executionToken) return;
        const store = this.#config.getSessionStore(input.sessionId, input.workspaceRoot);
        if (store?.getState().isRunning) {
          store.getState().append({
            type: "execution-end",
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.#logger.error("session.execution.failed", {
          error,
          context: { sessionId: input.sessionId, agentName: execution.agentName, origin: execution.origin },
          meta: { workspaceRoot: input.workspaceRoot },
        });
      }
    }
  }

  #finalizeExecution(key: string, execution: PendingSessionExecution, slotAcquired: boolean): void {
    const ownedFamilyStopLease = execution.familyStopLease;
    execution.familyStopLease = undefined;
    const current = this.#active.get(key);
    const isCurrentExecution = current?.executionToken === execution.executionToken;
    if (isCurrentExecution) {
      const store = this.#config.getSessionStore(execution.sessionId, execution.workspaceRoot);
      if (store?.getState().isRunning) {
        store.getState().append({
          type: "execution-end",
          status: execution.abortController.signal.aborted ? abortExecutionStatus(execution.abortController.signal) : "completed",
        });
      }
      const previousFamilyActivity = this.getSessionFamilyActivity(execution.workspaceRoot, execution.rootSessionId);
      this.#active.delete(key);
      this.#publishSessionRuntimeChange(execution.workspaceRoot, execution.rootSessionId, previousFamilyActivity);
    }

    if (isCurrentExecution) {
      if (slotAcquired) this.#config.sessionAgentManager.releaseSlot(execution.workspaceRoot, execution.sessionId);
      this.#detachIfIdle(execution.workspaceRoot, execution.sessionId);
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
    execution.abortController.abort(new Error(reason));
  }

  async #stopSessionFamily(
    workspaceRoot: string,
    rootSessionId: string,
    exemptSessionId: string | undefined,
  ): Promise<void> {
    const deadline = Date.now() + (this.#config.sessionFamilyStopTimeoutMs ?? ABORT_AND_WAIT_TIMEOUT_MS);
    const key = scopedKey(workspaceRoot, rootSessionId);
    const deferredAncestorIds = this.#ancestorSessionIds(workspaceRoot, exemptSessionId);

    while (true) {
      const familyExecutions = [...this.#active.values()].filter((execution) => {
        if (execution.workspaceRoot !== workspaceRoot || execution.sessionId === exemptSessionId) return false;
        return execution.rootSessionId === rootSessionId;
      });
      const executions = familyExecutions.filter((execution) => !deferredAncestorIds.has(execution.sessionId));
      const resumes = [...this.#hitlResumes.values()].filter((resume) => (
        resume.workspaceRoot === workspaceRoot && resume.rootSessionId === rootSessionId
      ));
      const pendingChildSessionIds = [...(this.#pendingChildLaunches.get(key)?.launches.values() ?? [])];

      for (const execution of familyExecutions) this.#cancelExecution(execution, "Session family cancelled");
      for (const resume of resumes) resume.abortController.abort(new Error("Session family stopped"));

      if (executions.length === 0 && resumes.length === 0 && pendingChildSessionIds.length === 0) return;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const stuckSessionIds = [...new Set([
          ...executions.map((execution) => execution.sessionId),
          ...resumes.map((resume) => resume.sessionId),
          ...pendingChildSessionIds,
        ])].sort();
        throw new SessionFamilyStopConflictError(rootSessionId, stuckSessionIds);
      }

      const pendingPromises = [
        ...executions.flatMap((execution) => execution.promise === undefined ? [] : [execution.promise]),
        ...resumes.map((resume) => resume.completed),
      ];
      if (pendingPromises.length === 0) {
        await Bun.sleep(Math.min(5, remainingMs));
      } else {
        await Promise.race([
          Promise.allSettled(pendingPromises).then(() => undefined),
          Bun.sleep(Math.min(5, remainingMs)),
        ]);
      }
    }
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
    const sessionIdSet = new Set(sessionIds);
    const executions = sessionIds
      .map((sessionId) => this.#active.get(scopedKey(workspaceRoot, sessionId)))
      .filter((execution): execution is ActiveSessionExecution | PendingSessionExecution => execution !== undefined);
    const resumes = [...this.#hitlResumes.values()].filter((resume) => (
      resume.workspaceRoot === workspaceRoot
      && (sessionIdSet.has(resume.sessionId) || sessionIdSet.has(resume.rootSessionId))
    ));

    for (const execution of executions) this.#cancelExecution(execution, "Session cancelled");
    for (const resume of resumes) resume.abortController.abort(new Error("Session cancelled"));

    const settled = await Promise.all([
      ...executions.map(async (execution) => {
        try {
          await waitForExecutionToStop(execution);
          return undefined;
        } catch {
          return execution.sessionId;
        }
      }),
      ...resumes.map(async (resume) => {
        try {
          await waitForHitlResumeToStop(resume);
          return undefined;
        } catch {
          return resume.sessionId;
        }
      }),
    ]);

    return settled.filter((id): id is string => id !== undefined);
  }

  #collectActiveCascade(workspaceRoot: string, sessionId: string): Array<ActiveSessionExecution | PendingSessionExecution> {
    const direct = this.#active.get(scopedKey(workspaceRoot, sessionId));
    const sessionIds = new Set<string>([sessionId]);
    const activeSessionIds = [...this.#active.values()]
      .filter((execution) => execution.workspaceRoot === workspaceRoot)
      .map((execution) => execution.sessionId);

    for (const activeSessionId of activeSessionIds) {
      const store = this.#config.getSessionStore(activeSessionId, workspaceRoot);
      let parentSessionId = store?.getState().parentSessionId;
      while (parentSessionId !== undefined) {
        if (parentSessionId === sessionId) {
          sessionIds.add(activeSessionId);
          break;
        }
        parentSessionId = this.#config.getSessionStore(parentSessionId, workspaceRoot)?.getState().parentSessionId;
      }
    }

    const executions = [...sessionIds]
      .map((id) => this.#active.get(scopedKey(workspaceRoot, id)))
      .filter((execution): execution is ActiveSessionExecution | PendingSessionExecution => execution !== undefined);
    if (executions.length > 0 || direct === undefined) return executions;
    return [direct];
  }

  #collectHitlResumeCascade(
    workspaceRoot: string,
    sessionId: string,
  ): SessionHitlResumeLeaseState[] {
    const resumes: SessionHitlResumeLeaseState[] = [];
    for (const resume of this.#hitlResumes.values()) {
      if (resume.workspaceRoot !== workspaceRoot) continue;
      if (resume.sessionId === sessionId || resume.rootSessionId === sessionId) {
        resumes.push(resume);
        continue;
      }
      if (this.#isDescendantOf(workspaceRoot, resume.sessionId, sessionId)) resumes.push(resume);
    }
    return resumes;
  }

  #detachIfIdle(workspaceRoot: string, sessionId: string): void {
    if (this.#isDirectlyRunning(workspaceRoot, sessionId)) return;
    // The SSE subscription, not the execution generation, owns live delivery.
    // Parent links and HITL continuations may append after the root goes idle.
    if (this.#eventBridge.hasSubscriptions(workspaceRoot, sessionId)) return;
    this.#eventBridge.detachSession(workspaceRoot, sessionId);
  }

  #isDirectlyRunning(workspaceRoot: string, sessionId: string): boolean {
    if (this.#active.has(scopedKey(workspaceRoot, sessionId))) return true;
    for (const resume of this.#hitlResumes.values()) {
      if (resume.workspaceRoot === workspaceRoot && resume.sessionId === sessionId) return true;
    }
    return false;
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
  ): void {
    this.#assertSessionNotBlockedByHitl(sessionId, state);
    const rootSessionId = state.rootSessionId;
    if (this.#familyStops.has(scopedKey(workspaceRoot, rootSessionId))) {
      throw new SessionFamilyStopInProgressError(sessionId, rootSessionId);
    }
    if (this.#deletions.has(scopedKey(workspaceRoot, rootSessionId))) {
      throw new SessionDeleteInProgressError(sessionId, rootSessionId);
    }
    const hitlResume = this.#hitlResumes.get(scopedKey(workspaceRoot, rootSessionId));
    if (hitlResume !== undefined) {
      throw new SessionHitlResumeInProgressError(sessionId, rootSessionId);
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

  #assertSessionNotBlockedByHitl(sessionId: string, state: SessionStoreState): void {
    const hitlIds = new Set(state.blockedByHitlIds ?? []);
    if (state.blockedHitl !== undefined) hitlIds.add(state.blockedHitl.hitlId);
    if (hitlIds.size === 0) return;
    throw new SessionHitlBlockedError(sessionId, [...hitlIds].sort());
  }

  /**
   * A dormant child keeps the checkout it was created in. Once the root moves,
   * neither a direct message nor a durable replay may revive that child in the
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

  #reserveChildLaunch(workspaceRoot: string, rootSessionId: string, childSessionId: string): () => void {
    this.#assertWorkspaceOpen(workspaceRoot);
    const key = scopedKey(workspaceRoot, rootSessionId);
    if (this.#familyStops.has(key)) {
      throw new SessionFamilyStopInProgressError(childSessionId, rootSessionId);
    }
    if (this.#deletions.has(key)) {
      throw new SessionDeleteInProgressError(childSessionId, rootSessionId);
    }
    if (this.#hitlResumes.has(key)) {
      throw new SessionHitlResumeInProgressError(childSessionId, rootSessionId);
    }
    if (this.#cwdTransitions.has(key)) {
      throw new SessionCwdTransitionInProgressError(childSessionId, rootSessionId);
    }

    const token = Symbol(`child-launch:${childSessionId}`);
    const previousFamilyActivity = this.getSessionFamilyActivity(workspaceRoot, rootSessionId);
    const family = this.#pendingChildLaunches.get(key) ?? {
      workspaceRoot,
      rootSessionId,
      launches: new Map<symbol, string>(),
    };
    family.launches.set(token, childSessionId);
    this.#pendingChildLaunches.set(key, family);
    this.#publishSessionRuntimeChange(workspaceRoot, rootSessionId, previousFamilyActivity);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#pendingChildLaunches.get(key);
      const activityBeforeRelease = this.getSessionFamilyActivity(workspaceRoot, rootSessionId);
      current?.launches.delete(token);
      if (current?.launches.size === 0) this.#pendingChildLaunches.delete(key);
      this.#publishSessionRuntimeChange(workspaceRoot, rootSessionId, activityBeforeRelease);
    };
  }

  #publishSessionRuntimeChange(
    workspaceRoot: string,
    rootSessionId: string,
    previousActivity: SessionFamilyActivity,
  ): void {
    const activity = this.getSessionFamilyActivity(workspaceRoot, rootSessionId);
    if (activity === previousActivity) return;
    const change: SessionRuntimeChange = { workspaceRoot, rootSessionId, activity };
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
    if (this.#workspaceClosures.has(workspaceRoot)) {
      throw new SessionWorkspaceClosingError(workspaceRoot);
    }
  }

  #acquireSessionDeletion(workspaceRoot: string, rootSessionId: string, sessionId: string): () => void {
    const key = scopedKey(workspaceRoot, rootSessionId);
    if (this.#familyStops.has(key)) {
      throw new SessionFamilyStopInProgressError(sessionId, rootSessionId);
    }
    if (this.#deletions.has(key)) {
      throw new SessionDeleteInProgressError(sessionId, rootSessionId);
    }
    const pendingChildSessionIds = [...(this.#pendingChildLaunches.get(key)?.launches.values() ?? [])];
    if (pendingChildSessionIds.length > 0) {
      throw new SessionDeleteConflictError(pendingChildSessionIds.sort());
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

  #reserveChildSlot(workspaceRoot: string, parentSessionId: string, maxConcurrent: number): void {
    const key = scopedKey(workspaceRoot, parentSessionId);
    const activeChildren = this.#countActiveChildren(workspaceRoot, parentSessionId);
    const reservedChildren = this.#childSlots.get(key) ?? 0;
    const totalChildren = Math.max(activeChildren, reservedChildren);
    if (totalChildren >= maxConcurrent) throw new ConcurrentLimitError(totalChildren);
    this.#childSlots.set(key, reservedChildren + 1);
  }

  #releaseChildSlot(workspaceRoot: string, parentSessionId: string): void {
    const key = scopedKey(workspaceRoot, parentSessionId);
    const reservedChildren = this.#childSlots.get(key) ?? 0;
    if (reservedChildren <= 1) this.#childSlots.delete(key);
    else this.#childSlots.set(key, reservedChildren - 1);
  }

  #appendChildLinkStatus(
    workspaceRoot: string,
    request: ChildExecutionRequest,
    childSessionId: string,
    childAgentName: string,
    depth: number,
    status: ToolChildSessionLinkStatus,
    title: string | undefined,
    createdAt?: number,
    background?: boolean,
  ): void {
    const run = this.#config.getSessionStore(childSessionId, workspaceRoot)?.getState().executions.at(-1);
    request.parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: request.parentSessionId,
        parentToolCallId: request.parentToolCallId,
        toolName: request.toolName,
        childSessionId,
        childAgentName,
        ...(title === undefined ? {} : { title }),
        ...(request.description === undefined ? {} : { description: request.description }),
        depth,
        background: background ?? request.background ?? false,
        status,
        createdAt: createdAt ?? Date.now(),
        ...(run?.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run?.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        ...(run?.durationMs === undefined ? {} : { durationMs: run.durationMs }),
        ...(run?.error === undefined ? {} : { error: run.error }),
      },
    });
  }

  #appendResumeChildLinkStatus(
    workspaceRoot: string,
    request: ResumeChildRequest,
    existingLink: ToolChildSessionLink | undefined,
    status: ToolChildSessionLinkStatus,
    createdAt: number,
  ): void {
    const run = this.#config.getSessionStore(request.sessionId, workspaceRoot)?.getState().executions.at(-1);
    const includeRunMetadata = TERMINAL_CHILD_LINK_STATUSES.has(status);
    request.parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: request.parentSessionId,
        parentToolCallId: request.parentToolCallId,
        toolName: request.toolName,
        childSessionId: request.sessionId,
        childAgentName: request.targetAgentName,
        ...(existingLink?.title === undefined ? {} : { title: existingLink.title }),
        ...(existingLink?.description === undefined ? {} : { description: existingLink.description }),
        depth: existingLink?.depth ?? (request.currentDepth ?? 0) + 1,
        background: request.background ?? false,
        status,
        createdAt,
        ...(includeRunMetadata && run?.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
        ...(includeRunMetadata && run?.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
        ...(includeRunMetadata && run?.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
        ...(includeRunMetadata && run?.error !== undefined ? { error: run.error } : {}),
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
      if (candidate?.childSessionId === childSessionId && !TERMINAL_CHILD_LINK_STATUSES.has(candidate.status)) {
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

  #findChildSessionLink(parentStore: StoreApi<SessionStoreState>, childSessionId: string): ToolChildSessionLink | undefined {
    const links = parentStore.getState().childSessionLinks;
    for (let index = links.length - 1; index >= 0; index -= 1) {
      const candidate = links[index];
      if (candidate?.childSessionId === childSessionId) return candidate;
    }
    return undefined;
  }

}

function executionScopeSubject(
  state: SessionStoreState,
  isDescendantOfRoot?: boolean,
) {
  return {
    sessionId: state.sessionId,
    rootSessionId: state.rootSessionId,
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
    ...(isDescendantOfRoot === undefined ? {} : { isDescendantOfRoot }),
    cwd: state.cwd,
    ...(state.goalId === undefined ? {} : { goalId: state.goalId }),
    ...(state.loopId === undefined ? {} : { loopId: state.loopId }),
    ...(state.sessionRole === undefined ? {} : { sessionRole: state.sessionRole }),
  };
}

interface ExecutionScopeSnapshot {
  readonly cwd: string;
  readonly goalId: string | undefined;
  readonly loopId: string | undefined;
  readonly rootSessionId: string;
  readonly parentSessionId: string | undefined;
  readonly sessionRole: SessionRole | undefined;
}

function executionScopeSnapshot(state: SessionStoreState): ExecutionScopeSnapshot {
  return {
    cwd: state.cwd,
    goalId: state.goalId,
    loopId: state.loopId,
    rootSessionId: state.rootSessionId,
    parentSessionId: state.parentSessionId,
    sessionRole: state.sessionRole,
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
    "goalId",
    "loopId",
    "rootSessionId",
    "parentSessionId",
    "sessionRole",
  ];
  return fields.filter((field) => previous[field] !== current[field]);
}

interface ChildLoopScopeInput {
  readonly parentSessionId: string;
  readonly parentLoopId: string | undefined;
  readonly childSessionId?: string;
  readonly childLoopId: string | undefined;
  readonly origin: ToolExecutionOrigin | undefined;
}

function assertChildLoopScope(input: ChildLoopScopeInput): void {
  const originLoopId = input.origin?.loopId;
  if (input.parentLoopId === input.childLoopId && input.parentLoopId === originLoopId) return;

  throw new ChildSessionLoopScopeMismatchError(
    input.parentSessionId,
    input.childSessionId,
    input.parentLoopId,
    input.childLoopId,
    originLoopId,
  );
}

type SubAgentTerminalStatus = Extract<ToolChildSessionLinkStatus, "completed" | "failed" | "timed_out" | "cancelled" | "interrupted">;
type SubAgentExecutionStatus = SubAgentTerminalStatus | "waiting_for_human";

function isSubAgentTerminalStatus(status: ToolChildSessionLinkStatus): status is SubAgentTerminalStatus {
  return TERMINAL_CHILD_LINK_STATUSES.has(status);
}

function childLinkStatusFromExecution(run: SessionExecutionRecord | undefined): SubAgentExecutionStatus | undefined {
  if (run?.status === "completed") return "completed";
  if (run?.status === "waiting_for_human") return "waiting_for_human";
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

function sessionExecutionOrigin(origin: SessionExecutionOrigin | ToolExecutionOrigin | undefined): SessionExecutionOrigin {
  if (origin === "tool_call") return "tool_call";
  return "user_message";
}

function isToolExecutionOrigin(origin: SessionExecutionOrigin | ToolExecutionOrigin | undefined): origin is ToolExecutionOrigin {
  return typeof origin === "object" && origin !== null && origin.kind === "loop";
}

function sessionRoleForAgent(agentName: AgentName): SessionRole | undefined {
  if (agentName === "plan" || agentName === "build" || agentName === "explore" || agentName === "librarian") return agentName;
  if (agentName === "reviewer") return "review";
  return undefined;
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
  status: SubAgentTerminalStatus,
): void {
  const reminder: Reminder = {
    id: crypto.randomUUID(),
    source: status === "completed"
      ? { type: "subagent_completed", sessionId }
      : status === "timed_out"
        ? { type: "subagent_timed_out", sessionId }
        : status === "cancelled"
          ? { type: "subagent_cancelled", sessionId }
          : { type: "subagent_failed", sessionId },
    delivery: "on_demand",
    sessionId,
    terminalState: status,
    content: `Sub-agent ${sessionId} ${formatStatus(status)}. Use background_output(session_id="${sessionId}") to read the result.`,
    createdAt: Date.now(),
    consumedAt: null,
    targetSessionId: parentStore.getState().sessionId,
  };
  parentStore.getState().append({ type: "reminder", reminder });
}

function formatStatus(status: SubAgentTerminalStatus): string {
  if (status === "timed_out") return "timed out";
  return status;
}

function toAgentResult(store: StoreApi<SessionStoreState>): AgentResult {
  return { text: getLastAssistantText(store.getState().messages), steps: store.getState().steps.length };
}

function getLastAssistantText(messages: readonly StoredMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.length > 0) return text;
  }
  return "";
}

async function waitForExecutionToStop(execution: ActiveSessionExecution | PendingSessionExecution): Promise<void> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for session "${execution.sessionId}" to abort`)), ABORT_AND_WAIT_TIMEOUT_MS);
  });
  await Promise.race([execution.promise ?? Promise.resolve(), timeout]);
}

async function waitForHitlResumeToStop(resume: SessionHitlResumeLeaseState): Promise<void> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for Session HITL resume "${resume.sessionId}" to abort`)), ABORT_AND_WAIT_TIMEOUT_MS);
  });
  await Promise.race([resume.completed, timeout]);
}

function flattenSessionTree(node: SessionTreeNode): string[] {
  return [node.session.sessionId, ...node.children.flatMap((child) => flattenSessionTree(child))];
}

function collectSubtreeSessionIds(node: SessionTreeNode, targetSessionId: string): string[] {
  if (node.session.sessionId === targetSessionId) return flattenSessionTree(node);
  for (const child of node.children) {
    const found = collectSubtreeSessionIds(child, targetSessionId);
    if (found.length > 0) return found;
  }
  return [];
}
