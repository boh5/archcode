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
