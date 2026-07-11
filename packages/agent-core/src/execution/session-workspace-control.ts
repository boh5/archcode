export interface SessionWorkspaceCloseLease {
  readonly workspaceRoot: string;
  release(): void;
}

export class SessionWorkspaceClosingError extends Error {
  readonly code = "SESSION_WORKSPACE_CLOSING";

  constructor(public readonly workspaceRoot: string) {
    super(`Session workspace "${workspaceRoot}" is closing`);
    this.name = "SessionWorkspaceClosingError";
  }
}
