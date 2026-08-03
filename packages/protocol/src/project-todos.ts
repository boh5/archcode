import type { AttachmentDescriptor } from "./attachments";

export const PROJECT_TODO_CONTENT_MAX_LENGTH = 20_000;
export const PROJECT_TODO_CONTENT_EXCERPT_MAX_LENGTH = 80;
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

/** Compact, display-only prefix of canonical Todo Markdown. */
export function projectTodoContentExcerpt(content: string): string {
  const compact = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line) => line
      .replace(/^(?:#{1,6}|>|[-+*]|\d+[.)])\s+/u, "")
      .replace(/^\[[ xX]\]\s*/u, ""))
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(compact);
  if (characters.length <= PROJECT_TODO_CONTENT_EXCERPT_MAX_LENGTH) return compact;
  return `${characters.slice(0, PROJECT_TODO_CONTENT_EXCERPT_MAX_LENGTH - 1).join("").trimEnd()}…`;
}
