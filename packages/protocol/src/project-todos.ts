export const PROJECT_TODO_TITLE_MAX_LENGTH = 200;
export const PROJECT_TODO_BODY_MAX_LENGTH = 20_000;
export const PROJECT_TODO_REJECTION_REASON_MAX_LENGTH = 4_000;

export type ProjectTodoStatus = "idea" | "ready" | "in_progress" | "done" | "rejected";
export type ProjectTodoSessionEntry = "discussion" | "work" | "automation";

/** Immutable origin of every user-facing root Session. */
export type RootSessionSource =
  | { readonly kind: "direct" }
  | {
      readonly kind: "todo";
      readonly todoId: string;
      readonly entry: ProjectTodoSessionEntry;
    }
  | {
      readonly kind: "automation";
      readonly automationId: string;
      readonly invocationId: string;
    };

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

export interface ProjectTodoCreateInput {
  readonly title: string;
  readonly body?: string;
}

export interface ProjectTodoRunNowInput {
  readonly clientRequestId: string;
  readonly title: string;
  readonly body?: string;
}

export interface ProjectTodoPlan {
  readonly path: string;
  readonly markdown: string;
  readonly updatedAt: number;
}

export interface ProjectTodoPlanResponse {
  readonly plan: ProjectTodoPlan | null;
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

export type CreateProjectTodoSessionInput =
  | {
      readonly expectedRevision: number;
      readonly entry: "discussion";
      /** Makes the new Discussion's first message the deterministic Plan request. */
      readonly initialIntent?: "plan";
    }
  | {
      readonly expectedRevision: number;
      readonly entry: "work" | "automation";
    };

export interface ProjectTodoListResponse {
  readonly todos: readonly ProjectTodo[];
}

export interface ProjectTodoResponse {
  readonly todo: ProjectTodo;
}

export interface CreateProjectTodoSessionResponse extends ProjectTodoResponse {
  readonly sessionId: string;
}
