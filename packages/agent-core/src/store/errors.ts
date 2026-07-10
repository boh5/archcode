export class NotRootSessionError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly parentSessionId: string,
  ) {
    super(`Session "${sessionId}" is not a root session; parent is "${parentSessionId}"`);
    this.name = "NotRootSessionError";
  }
}

export class SessionDeleteConflictError extends Error {
  constructor(public readonly sessionIds: string[]) {
    super(`Unable to delete session subtree; running sessions did not stop: ${sessionIds.join(", ")}`);
    this.name = "SessionDeleteConflictError";
  }
}

export class SessionFileNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session file not found for "${sessionId}"`);
    this.name = "SessionFileNotFoundError";
  }
}

export class SessionInitialPersistenceError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly workspaceRoot: string,
    public readonly cause: unknown,
  ) {
    super(`Failed to persist new Session "${sessionId}" before publishing it`);
    this.name = "SessionInitialPersistenceError";
  }
}

export class InvalidSessionCwdError extends Error {
  constructor(
    public readonly cwd: string,
    reason = "must be an absolute path",
    public readonly cause?: unknown,
  ) {
    super(`Session cwd ${reason}: "${cwd}"`);
    this.name = "InvalidSessionCwdError";
  }
}

export class SessionCwdPathBarrierError extends Error {
  constructor(
    public readonly cwd: string,
    public readonly reason: "already_held" | "target_blocked" | "lease_expired",
  ) {
    super(`Session cwd path barrier ${reason.replaceAll("_", " ")}: "${cwd}"`);
    this.name = "SessionCwdPathBarrierError";
  }
}

export class SessionCwdReferenceScanError extends Error {
  constructor(
    public readonly workspaceRoot: string,
    public readonly filePath: string | undefined,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SessionCwdReferenceScanError";
  }
}

export class SessionCwdReferenceMigrationError extends Error {
  constructor(
    public readonly fromCwd: string,
    public readonly toCwd: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SessionCwdReferenceMigrationError";
  }
}
