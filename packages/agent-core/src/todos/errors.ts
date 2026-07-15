import type { ProjectTodoActivationKind, ProjectTodoStatus } from "@archcode/protocol";

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

export class ProjectTodoInvalidTransitionError extends Error {
  readonly code = "PROJECT_TODO_INVALID_TRANSITION";

  constructor(
    public readonly todoId: string,
    public readonly from: ProjectTodoStatus,
    public readonly to: ProjectTodoStatus,
    reason?: string,
  ) {
    super(reason ?? `Project Todo ${todoId} cannot transition from ${from} to ${to}`);
    this.name = "ProjectTodoInvalidTransitionError";
  }
}

export class ProjectTodoArchivedError extends Error {
  readonly code = "PROJECT_TODO_ARCHIVED";

  constructor(public readonly todoId: string) {
    super(`Archived Project Todo must be restored before mutation: ${todoId}`);
    this.name = "ProjectTodoArchivedError";
  }
}

export class ProjectTodoActivationConflictError extends Error {
  readonly code = "PROJECT_TODO_ACTIVATION_CONFLICT";

  constructor(
    public readonly todoId: string,
    public readonly currentKind?: ProjectTodoActivationKind,
    message = `Project Todo cannot start another Activation: ${todoId}`,
  ) {
    super(message);
    this.name = "ProjectTodoActivationConflictError";
  }
}

export class ProjectTodoResourceBindingConflictError extends Error {
  readonly code = "PROJECT_TODO_RESOURCE_BINDING_CONFLICT";

  constructor(
    public readonly todoId: string,
    public readonly currentResourceId: string,
    public readonly requestedResourceId: string,
  ) {
    super(`Project Todo ${todoId} is already bound to resource ${currentResourceId}`);
    this.name = "ProjectTodoResourceBindingConflictError";
  }
}

export class ProjectTodoReturnToReadyConflictError extends Error {
  readonly code = "PROJECT_TODO_RETURN_TO_READY_CONFLICT";

  constructor(
    public readonly todoId: string,
    public readonly reason: string,
  ) {
    super(`Project Todo ${todoId} cannot return to Ready: ${reason}`);
    this.name = "ProjectTodoReturnToReadyConflictError";
  }
}

export class ProjectTodoDiscussionAuthorizationError extends Error {
  readonly code = "PROJECT_TODO_DISCUSSION_UNAUTHORIZED";

  constructor(public readonly reason: string) {
    super(`Project Todo discussion update denied: ${reason}`);
    this.name = "ProjectTodoDiscussionAuthorizationError";
  }
}
