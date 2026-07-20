export const PROJECT_TODO_TITLE_MAX_LENGTH = 200;
export const PROJECT_TODO_BODY_MAX_LENGTH = 20_000;
export const PROJECT_TODO_REJECTION_REASON_MAX_LENGTH = 4_000;

export type ProjectTodoStatus = "idea" | "ready" | "done" | "rejected";
export type ProjectTodoActivationKind = "session" | "automation";

export interface ProjectTodoActivation {
  readonly kind: ProjectTodoActivationKind;
  readonly sourceSessionId: string;
  readonly todoRevision: number;
  readonly snapshot: {
    readonly title: string;
    readonly body: string;
  };
  readonly resourceId?: string;
}

/** Project-owned intent, separate from a Session-scoped execution checklist. */
export interface ProjectTodo {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: ProjectTodoStatus;
  readonly rejectionReason?: string;
  readonly revision: number;
  readonly discussionSessionId?: string;
  readonly activation?: ProjectTodoActivation;
  readonly archivedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectTodoCreateInput {
  readonly title: string;
  readonly body?: string;
}

export interface ProjectTodoUpdatePatch {
  readonly title?: string;
  readonly body?: string;
  readonly status?: ProjectTodoStatus;
  readonly rejectionReason?: string;
}

export interface ProjectTodoDiscussionUpdatePatch {
  readonly title?: string;
  readonly body?: string;
  readonly status?: "idea" | "ready" | "rejected";
  readonly rejectionReason?: string;
}

export interface ProjectTodoMutationInput {
  readonly expectedRevision: number;
}

export interface ProjectTodoUpdateInput extends ProjectTodoMutationInput {
  readonly patch: ProjectTodoUpdatePatch;
}

export interface ProjectTodoDiscussInput extends ProjectTodoMutationInput {}

export interface ProjectTodoActivateInput extends ProjectTodoMutationInput {
  readonly kind: ProjectTodoActivationKind;
}

export interface ProjectTodoListResponse {
  readonly todos: readonly ProjectTodo[];
}

export interface ProjectTodoResponse {
  readonly todo: ProjectTodo;
}

export interface ProjectTodoSessionResponse extends ProjectTodoResponse {
  readonly sessionId: string;
}

export interface ProjectTodoSessionOwner {
  readonly sessionId: string;
  readonly ownerType: "project_todo";
  readonly ownerId: string;
}
