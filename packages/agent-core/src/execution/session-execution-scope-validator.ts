import { resolveValidSessionCwd } from "../store/session-cwd";
import type { AgentName } from "../agents";
import {
  isArchCodeManagedBranch,
  isManagedWorktreeFor,
  type WorktreeInfo,
} from "../worktrees";

export type SessionExecutionScopeConflictCode =
  | "SESSION_EXECUTION_SCOPE_CHANGED"
  | "SESSION_CWD_INVALID"
  | "SESSION_WORKTREE_OWNER_MISMATCH";

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
  readonly parentAgentName?: AgentName;
  readonly cwd: string;
  readonly agentName?: AgentName;
}

export interface SessionExecutionScopeValidatorOptions {}

export interface SessionExecutionScopeValidationInput {
  readonly projectRoot: string;
  readonly subject: SessionExecutionScopeSubject;
}

/**
 * Validates the persisted owner and execution domain of an existing Session.
 * Session owns its execution directory. Goal is only root Session state and
 * therefore never creates a second execution-scope authority.
 */
export class SessionExecutionScopeValidator {
  constructor(_options: SessionExecutionScopeValidatorOptions = {}) {}

  async validate(input: SessionExecutionScopeValidationInput): Promise<void> {
    const { subject } = input;
    const worktree = await this.#assertRegisteredCwd(input.projectRoot, subject);
    this.#assertOrdinaryWorktreeOwner(subject, worktree);
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
      owner: { id: subject.rootSessionId },
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
