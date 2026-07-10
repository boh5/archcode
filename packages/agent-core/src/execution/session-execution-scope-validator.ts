import { resolve } from "node:path";

import type { GoalState, LoopState } from "@archcode/protocol";

import type { ProjectContextResolver } from "../projects/context-resolver";
import { resolveValidSessionCwd } from "../store/session-cwd";
import type { SessionRole } from "../store/types";
import type { ToolExecutionOrigin } from "../tools/types";
import {
  isArchCodeManagedBranch,
  isManagedWorktreeFor,
  managedWorktreeNames,
  WorktreeService,
  type WorktreeInfo,
} from "../worktrees";

export type SessionExecutionScopeConflictCode =
  | "SESSION_EXECUTION_SCOPE_CHANGED"
  | "SESSION_CWD_INVALID"
  | "SESSION_WORKTREE_OWNER_MISMATCH"
  | "SESSION_LOOP_EXECUTION_SCOPE_REQUIRED"
  | "SESSION_LOOP_HITL_ORIGIN_MISMATCH"
  | "SESSION_LOOP_RUN_CLAIM_INVALID"
  | "SESSION_LOOP_NOT_FOUND"
  | "SESSION_LOOP_OWNER_MISMATCH"
  | "SESSION_GOAL_NOT_FOUND"
  | "SESSION_GOAL_OWNER_MISMATCH"
  | "SESSION_GOAL_NOT_EXECUTABLE"
  | "SESSION_GOAL_REVIEWER_REQUIRED"
  | "SESSION_GOAL_CWD_MISMATCH"
  | "SESSION_GOAL_WORKTREE_CLAIM_INVALID"
  | "SESSION_GOAL_LOOP_SCOPE_MISMATCH";

export class SessionExecutionScopeConflictError extends Error {
  constructor(
    public readonly code: SessionExecutionScopeConflictCode,
    public readonly sessionId: string,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SessionExecutionScopeConflictError";
  }
}

export interface SessionExecutionScopeSubject {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  /** Proven by the caller from the persisted Session tree, not self-declared identity alone. */
  readonly isDescendantOfRoot?: boolean;
  readonly cwd: string;
  readonly goalId?: string;
  readonly loopId?: string;
  readonly sessionRole?: SessionRole;
}

export type SessionExecutionScopeEntry =
  | { readonly kind: "user_message"; readonly origin?: ToolExecutionOrigin }
  | { readonly kind: "hitl_replay"; readonly origin?: ToolExecutionOrigin };

export interface SessionExecutionScopeValidatorOptions {
  readonly projectContextResolver: Pick<ProjectContextResolver, "resolve">;
  readonly loopExecutionClaimResolver: SessionLoopExecutionClaimResolver;
  readonly worktreeServiceFactory?: (
    canonicalRoot: string,
  ) => Pick<WorktreeService, "validateManagedClaim">;
}

export interface SessionLoopExecutionClaimInput {
  readonly projectRoot: string;
  readonly loop: LoopState;
  readonly subject: SessionExecutionScopeSubject;
  readonly origin: ToolExecutionOrigin;
}

export type SessionLoopExecutionClaimDecision =
  | { readonly outcome: "allow" }
  | {
    readonly outcome: "deny";
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };

export interface SessionLoopExecutionClaimResolver {
  resolve(input: SessionLoopExecutionClaimInput): Promise<SessionLoopExecutionClaimDecision>;
}

export interface SessionExecutionScopeValidationInput {
  readonly projectRoot: string;
  readonly subject: SessionExecutionScopeSubject;
  readonly entry: SessionExecutionScopeEntry;
}

/**
 * Validates the persisted owner and execution domain of an existing Session.
 * Ordinary Sessions stay owner-free; Goal and Loop Sessions must prove their
 * current claim before a generic message or a persisted HITL replay can run.
 */
export class SessionExecutionScopeValidator {
  readonly #projectContextResolver: Pick<ProjectContextResolver, "resolve">;
  readonly #loopExecutionClaimResolver: SessionLoopExecutionClaimResolver;
  readonly #worktreeServiceFactory: (
    canonicalRoot: string,
  ) => Pick<WorktreeService, "validateManagedClaim">;

  constructor(options: SessionExecutionScopeValidatorOptions) {
    this.#projectContextResolver = options.projectContextResolver;
    this.#loopExecutionClaimResolver = options.loopExecutionClaimResolver;
    this.#worktreeServiceFactory = options.worktreeServiceFactory
      ?? ((canonicalRoot) => new WorktreeService({ canonicalRoot }));
  }

  async validate(input: SessionExecutionScopeValidationInput): Promise<void> {
    const { subject, entry } = input;
    if (subject.goalId === undefined && subject.loopId === undefined) {
      if (entry.origin !== undefined) {
        throw conflict(
          "SESSION_LOOP_OWNER_MISMATCH",
          subject,
          "An owner-free Session cannot run with a Loop execution origin",
          { originLoopId: entry.origin.loopId },
        );
      }
      const worktree = await this.#assertRegisteredCwd(input.projectRoot, subject);
      this.#assertOrdinaryWorktreeOwner(subject, worktree);
      return;
    }

    const context = await this.#projectContextResolver.resolve(input.projectRoot);
    let goal: GoalState | undefined;
    if (subject.goalId !== undefined) {
      try {
        goal = await context.goalState.read(subject.goalId);
      } catch (error) {
        throw conflict(
          "SESSION_GOAL_NOT_FOUND",
          subject,
          `Goal ${subject.goalId} cannot be loaded for Session ${subject.sessionId}`,
          { goalId: subject.goalId },
          error,
        );
      }
      if (goal.projectId !== context.project.slug) {
        throw conflict(
          "SESSION_GOAL_OWNER_MISMATCH",
          subject,
          `Goal ${goal.id} belongs to a different project`,
          { goalId: goal.id, goalProjectId: goal.projectId, projectId: context.project.slug },
        );
      }
      this.#assertCurrentGoalAttempt(subject, goal);
    }

    const goalLoopId = goal?.loopId;
    if (goal !== undefined && subject.loopId !== goalLoopId) {
      throw conflict(
        "SESSION_GOAL_LOOP_SCOPE_MISMATCH",
        subject,
        `Session ${subject.sessionId} does not match Goal ${goal?.id}'s Loop owner`,
        { sessionLoopId: subject.loopId, goalLoopId },
      );
    }

    const loopId = subject.loopId ?? goalLoopId;
    if (loopId !== undefined) {
      this.#assertLoopOrigin(subject, entry, loopId);
      try {
        const loop = await context.loopState.read(loopId);
        if (loop.projectId !== context.project.slug) {
          throw conflict(
            "SESSION_LOOP_OWNER_MISMATCH",
            subject,
            `Loop ${loopId} belongs to a different project`,
            { loopId, loopProjectId: loop.projectId, projectId: context.project.slug },
          );
        }
        const claim = await this.#loopExecutionClaimResolver.resolve({
          projectRoot: input.projectRoot,
          loop,
          subject,
          origin: entry.origin!,
        });
        if (claim.outcome === "deny") {
          throw conflict(
            "SESSION_LOOP_RUN_CLAIM_INVALID",
            subject,
            claim.message,
            { loopId, runId: entry.origin?.runId, claimCode: claim.code, ...claim.details },
          );
        }
      } catch (error) {
        if (error instanceof SessionExecutionScopeConflictError) throw error;
        throw conflict(
          "SESSION_LOOP_NOT_FOUND",
          subject,
          `Loop ${loopId} cannot be loaded for Session ${subject.sessionId}`,
          { loopId },
          error,
        );
      }
      if (goal?.useWorktree !== true) {
        await this.#assertRegisteredCwd(input.projectRoot, subject);
      }
    } else if (entry.origin !== undefined) {
      throw conflict(
        "SESSION_LOOP_OWNER_MISMATCH",
        subject,
        `Session ${subject.sessionId} is not owned by Loop ${entry.origin.loopId}`,
        { originLoopId: entry.origin.loopId },
      );
    }

    if (goal !== undefined) {
      this.#assertGoalStatus(subject, goal, entry);
      await this.#assertGoalCwd(input.projectRoot, subject, goal, loopId !== undefined);
    }
  }

  async #assertRegisteredCwd(
    projectRoot: string,
    subject: SessionExecutionScopeSubject,
  ): Promise<WorktreeInfo | undefined> {
    try {
      return await resolveValidSessionCwd(projectRoot, subject.cwd);
    } catch (error) {
      throw conflict(
        "SESSION_CWD_INVALID",
        subject,
        `Session ${subject.sessionId} does not have a valid execution directory`,
        { projectRoot, cwd: subject.cwd },
        error,
      );
    }
  }

  #assertOrdinaryWorktreeOwner(
    subject: SessionExecutionScopeSubject,
    worktree: WorktreeInfo | undefined,
  ): void {
    if (worktree === undefined) return;
    const reserved = worktree.isManaged || isArchCodeManagedBranch(worktree.branchName);
    if (!reserved || isManagedWorktreeFor(worktree, {
      owner: { type: "session", id: subject.rootSessionId },
    })) return;

    throw conflict(
      "SESSION_WORKTREE_OWNER_MISMATCH",
      subject,
      `Session ${subject.sessionId} cannot execute in another ArchCode owner's worktree`,
      {
        rootSessionId: subject.rootSessionId,
        cwd: worktree.path,
        branchName: worktree.branchName,
      },
    );
  }

  #assertCurrentGoalAttempt(subject: SessionExecutionScopeSubject, goal: GoalState): void {
    const currentMainSessionId = goal.mainSessionId;
    const isMain = subject.sessionRole === "main";
    const isCurrentMain = isMain
      && currentMainSessionId !== undefined
      && subject.sessionId === currentMainSessionId
      && subject.rootSessionId === currentMainSessionId
      && subject.parentSessionId === undefined;
    const isCurrentDescendant = !isMain
      && currentMainSessionId !== undefined
      && subject.sessionId !== currentMainSessionId
      && subject.rootSessionId === currentMainSessionId
      && subject.parentSessionId !== undefined
      && subject.isDescendantOfRoot === true;
    if (isCurrentMain || isCurrentDescendant) return;

    throw conflict(
      "SESSION_GOAL_OWNER_MISMATCH",
      subject,
      `Session ${subject.sessionId} is not owned by the current attempt of Goal ${goal.id}`,
      {
        goalId: goal.id,
        currentMainSessionId,
        rootSessionId: subject.rootSessionId,
        parentSessionId: subject.parentSessionId,
        isDescendantOfRoot: subject.isDescendantOfRoot,
        sessionRole: subject.sessionRole,
      },
    );
  }

  #assertLoopOrigin(
    subject: SessionExecutionScopeSubject,
    entry: SessionExecutionScopeEntry,
    loopId: string,
  ): void {
    if (entry.origin?.loopId === loopId) return;
    const code = entry.kind === "hitl_replay"
      ? "SESSION_LOOP_HITL_ORIGIN_MISMATCH"
      : "SESSION_LOOP_EXECUTION_SCOPE_REQUIRED";
    throw conflict(
      code,
      subject,
      entry.kind === "hitl_replay"
        ? `Loop Session ${subject.sessionId} can replay HITL only from Loop ${loopId}`
        : `Loop Session ${subject.sessionId} can execute only inside Loop ${loopId}`,
      { loopId, originLoopId: entry.origin?.loopId },
    );
  }

  #assertGoalStatus(
    subject: SessionExecutionScopeSubject,
    goal: GoalState,
    entry: SessionExecutionScopeEntry,
  ): void {
    if (goal.status === "running") return;
    if (goal.status === "reviewing") {
      if (subject.sessionRole === "review") return;
      throw conflict(
        "SESSION_GOAL_REVIEWER_REQUIRED",
        subject,
        `Only a Reviewer Session can execute while Goal ${goal.id} is reviewing`,
        { goalId: goal.id, status: goal.status, entryKind: entry.kind },
      );
    }
    if (entry.kind === "hitl_replay" && goal.status === "blocked") return;
    throw conflict(
      "SESSION_GOAL_NOT_EXECUTABLE",
      subject,
      `Goal ${goal.id} cannot execute from status ${goal.status}`,
      { goalId: goal.id, status: goal.status, entryKind: entry.kind },
    );
  }

  async #assertGoalCwd(
    projectRoot: string,
    subject: SessionExecutionScopeSubject,
    goal: GoalState,
    isLoopOwned: boolean,
  ): Promise<void> {
    if (goal.useWorktree !== true) {
      if (!isLoopOwned && resolve(subject.cwd) !== resolve(projectRoot)) {
        throw conflict(
          "SESSION_GOAL_CWD_MISMATCH",
          subject,
          `Goal Session ${subject.sessionId} must execute in the canonical project checkout`,
          { goalId: goal.id, expectedCwd: resolve(projectRoot), actualCwd: resolve(subject.cwd) },
        );
      }
      return;
    }

    const worktree = goal.worktree;
    const expectedBranch = managedWorktreeNames({ owner: { type: "goal", id: goal.id } }).branchName;
    if (
      worktree === undefined
      || resolve(subject.cwd) !== resolve(worktree.path)
      || worktree.branchName !== expectedBranch
    ) {
      throw conflict(
        "SESSION_GOAL_WORKTREE_CLAIM_INVALID",
        subject,
        `Goal ${goal.id} does not have a matching persisted worktree claim`,
        {
          goalId: goal.id,
          expectedCwd: worktree?.path,
          actualCwd: subject.cwd,
          expectedBranch,
          actualBranch: worktree?.branchName,
        },
      );
    }

    try {
      const claim = await this.#worktreeServiceFactory(projectRoot).validateManagedClaim({
        path: worktree.path,
        branchName: expectedBranch,
        mode: "persisted",
        baseSha: worktree.baseSha,
      });
      if (
        !claim.worktree.isManaged
        || resolve(claim.worktree.path) !== resolve(worktree.path)
        || claim.worktree.branchName !== expectedBranch
      ) {
        throw new Error("Validated worktree does not match the persisted Goal claim");
      }
    } catch (error) {
      throw conflict(
        "SESSION_GOAL_WORKTREE_CLAIM_INVALID",
        subject,
        `Goal ${goal.id}'s persisted worktree claim is no longer valid`,
        { goalId: goal.id, path: worktree.path, branchName: expectedBranch, baseSha: worktree.baseSha },
        error,
      );
    }
  }
}

function conflict(
  code: SessionExecutionScopeConflictCode,
  subject: SessionExecutionScopeSubject,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): SessionExecutionScopeConflictError {
  return new SessionExecutionScopeConflictError(code, subject.sessionId, message, details, cause);
}
