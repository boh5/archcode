import type { ProjectTodoStatus } from "@archcode/protocol";

export class ProjectTodoNotFoundError extends Error {
  readonly code = "PROJECT_TODO_NOT_FOUND";

  constructor(public readonly todoId: string) {
    super(`Project Todo not found: ${todoId}`);
    this.name = "ProjectTodoNotFoundError";
  }
}

export class ProjectTodoRevisionConflictError extends Error {
  readonly code = "PROJECT_TODO_REVISION_CONFLICT";

  constructor(
    public readonly todoId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(`Project Todo revision conflict for ${todoId}: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "ProjectTodoRevisionConflictError";
  }
}

export class ProjectTodoInvalidMutationError extends Error {
  readonly code = "PROJECT_TODO_INVALID_MUTATION";

  constructor(
    public readonly todoId: string,
    public readonly reason: string,
  ) {
    super(`Project Todo ${todoId} cannot be updated: ${reason}`);
    this.name = "ProjectTodoInvalidMutationError";
  }
}

export class ProjectTodoArchivedError extends Error {
  readonly code = "PROJECT_TODO_ARCHIVED";

  constructor(public readonly todoId: string) {
    super(`Archived Project Todo must be restored before mutation: ${todoId}`);
    this.name = "ProjectTodoArchivedError";
  }
}

export class ProjectTodoSessionStateError extends Error {
  readonly code = "PROJECT_TODO_SESSION_STATE_CONFLICT";

  constructor(
    public readonly todoId: string,
    public readonly status: ProjectTodoStatus,
  ) {
    super(`Project Todo ${todoId} cannot start work from status ${status}`);
    this.name = "ProjectTodoSessionStateError";
  }
}

export class ProjectTodoDiscussionAuthorizationError extends Error {
  readonly code = "PROJECT_TODO_DISCUSSION_UNAUTHORIZED";

  constructor(public readonly reason: string) {
    super(`Project Todo discussion update denied: ${reason}`);
    this.name = "ProjectTodoDiscussionAuthorizationError";
  }
}

export class ProjectTodoRunNowConflictError extends Error {
  readonly code = "PROJECT_TODO_RUN_NOW_CONFLICT";

  constructor(public readonly clientRequestId: string) {
    super(`Run now request ${clientRequestId} was already used with different input`);
    this.name = "ProjectTodoRunNowConflictError";
  }
}

export class ProjectTodoRunNowRecoveryError extends Error {
  readonly code = "PROJECT_TODO_RUN_NOW_RECOVERY_REQUIRED";

  constructor(
    public readonly todoId: string,
    public readonly sessionId: string | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectTodoRunNowRecoveryError";
  }
}

export class ProjectTodoStartDiscussionConflictError extends Error {
  readonly code = "PROJECT_TODO_START_DISCUSSION_CONFLICT";

  constructor(public readonly clientRequestId: string) {
    super(`Start discussion request ${clientRequestId} was already used with different input`);
    this.name = "ProjectTodoStartDiscussionConflictError";
  }
}

export class ProjectTodoStartDiscussionRecoveryError extends Error {
  readonly code = "PROJECT_TODO_START_DISCUSSION_RECOVERY_REQUIRED";

  constructor(
    public readonly todoId: string,
    public readonly sessionId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectTodoStartDiscussionRecoveryError";
  }
}
