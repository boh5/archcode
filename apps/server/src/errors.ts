export type ServerErrorCode =
  | "PROJECT_NOT_FOUND"
  | "WORKSPACE_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "AUTOMATION_NOT_FOUND"
  | "HITL_NOT_FOUND"
  | "SESSION_CWD_INVALID"
  | "QUESTION_NOT_FOUND"
  | "PROJECT_SCOPED_HITL_REQUIRED"
  | "PERMISSION_TIMEOUT"
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "AUTH_CURRENT_PASSWORD_INVALID"
  | "AUTH_RATE_LIMITED"
  | "CSRF_ORIGIN_INVALID"
  | "SERVER_NOT_READY"
  | "SETUP_CONFLICT"
  | "INTERNAL_ERROR"
  | "DELETE_CONFLICT"
  | "SESSION_STOP_CONFLICT"
  | "PROJECT_REMOVE_CONFLICT"
  | "PROJECT_TODO_NOT_FOUND"
  | "PROJECT_TODO_REVISION_CONFLICT"
  | "PROJECT_TODO_INVALID_MUTATION"
  | "PROJECT_TODO_ARCHIVED"
  | "PROJECT_TODO_SESSION_STATE_CONFLICT"
  | "PROJECT_TODO_DISCUSSION_UNAUTHORIZED"
  | "CONFIG_REVISION_CONFLICT"
  | "CONFIG_VALIDATION_ERROR"
  | "CONFIG_RECOVERY_CONFLICT"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_REVISION_CONFLICT"
  | "MEMORY_CAPACITY_EXCEEDED"
  | "MEMORY_INVALID_INPUT"
  | "MEMORY_SECRET_DETECTED"
  | "MEMORY_OPERATION_FAILED"
  | "TOOL_OUTPUT_FORBIDDEN"
  | "TOOL_OUTPUT_NOT_FOUND"
  | "TOOL_OUTPUT_EXPIRED"
  | "TOOL_OUTPUT_EVICTED"
  | "TOOL_OUTPUT_UNAVAILABLE"
  | "TOOL_OUTPUT_INVALID_CURSOR"
  | "TOOL_OUTPUT_INVALID_PATTERN"
  | "TOOL_OUTPUT_SEARCH_TIMEOUT"
  | "TOOL_OUTPUT_POLICY_VIOLATION"
  | "ATTACHMENT_INVALID"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_CONFLICT"
  | "ATTACHMENT_NOT_FOUND"
  | "ATTACHMENT_CORRUPTED"
  | "ATTACHMENT_PATH_UNSAFE"
  | "UPDATE_BUSY"
  | "UPDATE_CHECK_FAILED"
  | "UPDATE_DOWNLOAD_FAILED"
  | "UPDATE_MANIFEST_INVALID"
  | "UPDATE_ATTESTATION_INVALID"
  | "UPDATE_UNSUPPORTED_PLATFORM"
  | "UPDATE_UNMANAGED_INSTALL"
  | "UPDATE_RECEIPT_MISMATCH"
  | "UPDATE_INCOMPATIBLE"
  | "UPDATE_ARCHIVE_INVALID"
  | "UPDATE_INSTALL_FAILED"
  | "UPDATE_NOT_AVAILABLE"
  | "UPDATE_RESTART_UNAVAILABLE"
  | "UPDATE_RUNTIME_BUSY"
  | "RUNTIME_BUSY"
  | "RUNTIME_CLEANUP_INCOMPLETE"
  | "EMPTY_PROJECT_SLUGS"
  | "DUPLICATE_PROJECT_SLUG"
  | "PROJECT_NOT_REGISTERED"
  | "PROJECT_HAS_NO_ISSUES"
  | "DELETE_TARGET_UNSAFE";

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

export class ConfigRevisionConflictHttpError extends ServerError {
  constructor(expectedRevision: string, currentRevision: string) {
    super(
      "CONFIG_REVISION_CONFLICT",
      "The configuration changed on disk. Reload it before saving.",
      409,
      { expectedRevision, currentRevision },
    );
    this.name = "ConfigRevisionConflictHttpError";
  }
}

export class ConfigValidationHttpError extends ServerError {
  constructor(issues: readonly { path: string; message: string }[]) {
    super("CONFIG_VALIDATION_ERROR", "Configuration validation failed", 422, { issues });
    this.name = "ConfigValidationHttpError";
  }
}
