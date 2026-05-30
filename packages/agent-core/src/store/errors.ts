export class NotRootSessionError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly parentSessionId: string,
  ) {
    super(`Session "${sessionId}" is not a root session; parent is "${parentSessionId}"`);
    this.name = "NotRootSessionError";
  }
}
