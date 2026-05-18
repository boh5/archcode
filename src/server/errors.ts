export type ServerErrorCode =
  | "PROJECT_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "PERMISSION_TIMEOUT"
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "INTERNAL_ERROR";

export class ServerError extends Error {
  constructor(
    public readonly code: ServerErrorCode,
    message: string,
    public readonly httpStatus: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

export class ProjectNotFoundError extends ServerError {
  constructor(slug: string) {
    super("PROJECT_NOT_FOUND", `Project not found: ${slug}`, 404);
    this.name = "ProjectNotFoundError";
  }
}

export class SessionNotFoundError extends ServerError {
  constructor(sessionId: string) {
    super("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, 404);
    this.name = "SessionNotFoundError";
  }
}

export class PermissionTimeoutError extends ServerError {
  constructor(message: string) {
    super("PERMISSION_TIMEOUT", message, 408);
    this.name = "PermissionTimeoutError";
  }
}

export class BadRequestError extends ServerError {
  constructor(message: string, details?: unknown) {
    super("BAD_REQUEST", message, 400, details);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends ServerError {
  constructor(message: string = "Unauthorized") {
    super("UNAUTHORIZED", message, 401);
    this.name = "UnauthorizedError";
  }
}
