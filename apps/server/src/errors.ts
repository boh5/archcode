export type ServerErrorCode =
  | "PROJECT_NOT_FOUND"
  | "WORKSPACE_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "LOOP_NOT_FOUND"
  | "SESSION_CWD_INVALID"
  | "QUESTION_NOT_FOUND"
  | "PROJECT_SCOPED_HITL_REQUIRED"
  | "PERMISSION_TIMEOUT"
  | "BAD_REQUEST"
  | "CONCURRENT_SESSION_LIMIT"
  | "UNAUTHORIZED"
  | "INTERNAL_ERROR"
  | "DELETE_CONFLICT"
  | "SESSION_STOP_CONFLICT"
  | "PROJECT_REMOVE_CONFLICT"
  | "LOOP_ACTIVE_CONFLICT";

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

export class WorkspaceNotFoundError extends ServerError {
  constructor(detail: string) {
    super("WORKSPACE_NOT_FOUND", detail, 410);
    this.name = "WorkspaceNotFoundError";
  }
}

export class SessionNotFoundError extends ServerError {
  constructor(sessionId: string) {
    super("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, 404);
    this.name = "SessionNotFoundError";
  }
}

export class QuestionNotFoundError extends ServerError {
  constructor(questionId: string) {
    super("QUESTION_NOT_FOUND", `Question not found: ${questionId}`, 404);
    this.name = "QuestionNotFoundError";
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

export class ConcurrentSessionLimitHttpError extends ServerError {
  constructor(current: number, max: number) {
    super("CONCURRENT_SESSION_LIMIT", `Workspace has ${current} active sessions (max: ${max})`, 429, {
      current,
      max,
    });
    this.name = "ConcurrentSessionLimitHttpError";
  }
}

export class ConflictError extends ServerError {
  constructor(sessionIds: string[], message?: string, details?: Record<string, unknown>) {
    super(
      "DELETE_CONFLICT",
      message ?? `Unable to delete session subtree; running sessions did not stop: ${sessionIds.join(", ")}`,
      409,
      { sessionIds, ...details },
    );
    this.name = "ConflictError";
  }
}

export class SessionStopConflictHttpError extends ServerError {
  constructor(rootSessionId: string, sessionIds: readonly string[], message: string) {
    super("SESSION_STOP_CONFLICT", message, 409, { rootSessionId, sessionIds });
    this.name = "SessionStopConflictHttpError";
  }
}

export class ProjectRemoveConflictHttpError extends ServerError {
  constructor(projectSlug: string, activeFamilies: readonly { rootSessionId: string; activity: string }[]) {
    super(
      "PROJECT_REMOVE_CONFLICT",
      `Project "${projectSlug}" has active Session families and cannot be removed`,
      409,
      { projectSlug, activeFamilies },
    );
    this.name = "ProjectRemoveConflictHttpError";
  }
}
