export interface SessionDeletionPreflightInput {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  readonly sessionIds: readonly string[];
}

export interface SessionDeletionLifecycle {
  prepareForDeletion(input: SessionDeletionPreflightInput): Promise<void>;
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
