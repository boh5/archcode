export type ServerErrorCode =
  | "PROJECT_NOT_FOUND"
  | "WORKSPACE_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "QUESTION_NOT_FOUND"
  | "PERMISSION_TIMEOUT"
  | "BAD_REQUEST"
  | "CONCURRENT_SESSION_LIMIT"
  | "UNAUTHORIZED"
  | "INTERNAL_ERROR"
  | "WORKFLOW_NOT_FOUND"
  | "ARTIFACT_NOT_FOUND";

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

export class WorkflowNotFoundError extends ServerError {
  constructor(detail?: string) {
    const message = detail ? `Workflow not found: ${detail}` : "Workflow not found for this session";
    super("WORKFLOW_NOT_FOUND", message, 404);
    this.name = "WorkflowNotFoundError";
  }
}

export class ArtifactNotFoundError extends ServerError {
  constructor(name: string, workflowId?: string) {
    const message = workflowId
      ? `Artifact not found: ${name} in workflow ${workflowId}`
      : `Artifact not found: ${name}`;
    super("ARTIFACT_NOT_FOUND", message, 404);
    this.name = "ArtifactNotFoundError";
  }
}
