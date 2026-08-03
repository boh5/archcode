import type { AttachmentDescriptor } from "./attachments";

export const PROJECT_TODO_CONTENT_MAX_LENGTH = 20_000;
export const PROJECT_TODO_DISPLAY_LABEL_MAX_LENGTH = 120;
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
      readonly todoId: string | null;
    };

export function rootSessionSourceTodoId(source: RootSessionSource): string | undefined {
  if (source.kind === "todo") return source.todoId;
  if (source.kind === "automation") return source.todoId ?? undefined;
  return undefined;
}

/** Project-owned intent, separate from a Session-scoped execution checklist. */
export interface ProjectTodo {
  readonly id: string;
  readonly content: string;
  readonly attachmentIds: string[];
  readonly status: ProjectTodoStatus;
  readonly rejectionReason?: string;
  readonly revision: number;
  readonly archivedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectTodoCreateInput {
  readonly content: string;
}

export interface ProjectTodoRunNowInput {
  readonly clientRequestId: string;
  readonly content: string;
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
  readonly content?: string;
  readonly status?: ProjectTodoStatus;
  readonly rejectionReason?: string;
  readonly archived?: boolean;
  readonly beforeTodoId?: string | null;
}

export interface ProjectTodoDiscussionUpdatePatch {
  readonly content?: string;
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

export interface ProjectTodoAttachmentListResponse {
  readonly todoRevision: number;
  readonly attachments: readonly AttachmentDescriptor[];
}

export interface ProjectTodoAttachmentMutationResponse extends ProjectTodoResponse {
  readonly attachment: AttachmentDescriptor;
}

export interface CreateProjectTodoSessionResponse extends ProjectTodoResponse {
  readonly sessionId: string;
}

/**
 * Deterministic, display-only label derived from canonical Todo Markdown.
 * It is never persisted and never becomes a second editable Todo field.
 */
export function projectTodoDisplayLabel(content: string, todoId?: string): string {
  const firstLine = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const cleaned = firstLine
    ?.replace(/^(?:#{1,6}|>|[-+*]|\d+[.)])\s+/u, "")
    .replace(/^\[[ xX]\]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const emptyContentLabel = todoId === undefined ? "Untitled Todo" : `Todo ${todoId.slice(0, 8)}`;
  if (!cleaned) return emptyContentLabel;
  if (cleaned.length <= PROJECT_TODO_DISPLAY_LABEL_MAX_LENGTH) return cleaned;
  return `${cleaned.slice(0, PROJECT_TODO_DISPLAY_LABEL_MAX_LENGTH - 1).trimEnd()}…`;
}
