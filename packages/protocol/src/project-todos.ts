export const PROJECT_TODO_TITLE_MAX_LENGTH = 200;
export const PROJECT_TODO_BODY_MAX_LENGTH = 20_000;
export const PROJECT_TODO_REJECTION_REASON_MAX_LENGTH = 4_000;

export type ProjectTodoStatus = "idea" | "ready" | "in_progress" | "done" | "rejected";
export type ProjectTodoSessionEntry = "discussion" | "work" | "automation";

/** Project-owned intent, separate from a Session-scoped execution checklist. */
export interface ProjectTodo {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: ProjectTodoStatus;
  readonly rejectionReason?: string;
  readonly revision: number;
  readonly archivedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Immutable source identity owned by a user-facing root Session. */
export interface ProjectTodoSessionSource {
  readonly todoId: string;
  readonly entry: ProjectTodoSessionEntry;
}

export interface ProjectTodoCreateInput {
  readonly title: string;
  readonly body?: string;
}

/**
 * The single Todo mutation contract. `beforeTodoId` orders the Todo in its
 * final status lane; `null` explicitly appends it to that lane.
 */
export interface ProjectTodoUpdateInput {
  readonly expectedRevision: number;
  readonly title?: string;
  readonly body?: string;
  readonly status?: ProjectTodoStatus;
  readonly rejectionReason?: string;
  readonly archived?: boolean;
  readonly beforeTodoId?: string | null;
}

export interface ProjectTodoDiscussionUpdatePatch {
  readonly title?: string;
  readonly body?: string;
  readonly status?: "idea" | "ready" | "rejected";
  readonly rejectionReason?: string;
}

export interface CreateProjectTodoSessionInput {
  readonly expectedRevision: number;
  readonly entry: ProjectTodoSessionEntry;
  /** Makes the new Discussion's first message the deterministic Plan request. */
  readonly initialIntent?: "plan";
}

export interface ProjectTodoListResponse {
  readonly todos: readonly ProjectTodo[];
}

export interface ProjectTodoResponse {
  readonly todo: ProjectTodo;
}

export interface CreateProjectTodoSessionResponse extends ProjectTodoResponse {
  readonly sessionId: string;
}
