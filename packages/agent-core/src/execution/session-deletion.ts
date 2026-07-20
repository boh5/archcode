export interface SessionDeletionPreflightInput {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly sessionIds: readonly string[];
}

export interface SessionDeletionLifecycle {
  assertDeletable(input: SessionDeletionPreflightInput): Promise<void>;
  prepareForDeletion(input: SessionDeletionPreflightInput): Promise<void>;
}

export type SessionDeletionOwnerType = "project_todo";

export interface SessionDeletionOwnerDetail {
  readonly sessionId: string;
  readonly ownerType: SessionDeletionOwnerType;
  readonly ownerId?: string;
}

export class SessionDeleteOwnerConflictError extends Error {
  readonly code = "SESSION_DELETE_OWNER_CONFLICT";
  readonly sessionIds: string[];

  constructor(public readonly owners: readonly SessionDeletionOwnerDetail[]) {
    const sessionIds = [...new Set(owners.map((owner) => owner.sessionId))].sort();
    super(`Unable to delete owned Session subtree: ${sessionIds.join(", ")}`);
    this.name = "SessionDeleteOwnerConflictError";
    this.sessionIds = sessionIds;
  }
}

export class SessionDeleteInProgressError extends Error {
  readonly code = "SESSION_DELETE_IN_PROGRESS";

  constructor(
    public readonly sessionId: string,
    public readonly rootSessionId: string,
  ) {
    super(`Session "${sessionId}" cannot start or resume while Session family "${rootSessionId}" is being deleted`);
    this.name = "SessionDeleteInProgressError";
  }
}
