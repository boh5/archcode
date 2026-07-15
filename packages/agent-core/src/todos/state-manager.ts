import type {
  ProjectTodo,
  ProjectTodoActivationKind,
  ProjectTodoCreateInput,
  ProjectTodoSessionOwner,
  ProjectTodoUpdateInput,
} from "@archcode/protocol";
import { join } from "node:path";

import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { atomicWrite } from "../utils/safe-file";
import {
  ProjectTodoActivationConflictError,
  ProjectTodoArchivedError,
  ProjectTodoInvalidTransitionError,
  ProjectTodoNotFoundError,
  ProjectTodoResourceBindingConflictError,
  ProjectTodoRevisionConflictError,
} from "./errors";
import {
  ProjectTodoCreateSchema,
  ProjectTodoStateFileSchema,
  ProjectTodoUpdatePatchSchema,
  type ProjectTodoStateFile,
} from "./schema";

const ALLOWED_TRANSITIONS: Readonly<Record<ProjectTodo["status"], ReadonlySet<ProjectTodo["status"]>>> = {
  idea: new Set(["ready", "rejected"]),
  ready: new Set(["idea", "rejected", "done"]),
  rejected: new Set(["idea"]),
  done: new Set(["ready"]),
};

type MutableProjectTodo = {
  -readonly [Key in keyof ProjectTodo]: Key extends "activation"
    ? (ProjectTodo[Key] extends infer Activation | undefined
        ? Activation extends object ? { -readonly [ActivationKey in keyof Activation]: Activation[ActivationKey] } : never
        : never) | undefined
    : ProjectTodo[Key];
};

export interface ProjectTodoStateManagerOptions {
  readonly now?: () => number;
  readonly onCommitted?: (todo: ProjectTodo) => void | Promise<void>;
  readonly logger?: Logger;
}

export class ProjectTodoStateManager {
  readonly workspaceRoot: string;
  readonly #filePath: string;
  readonly #now: () => number;
  readonly #onCommitted: ProjectTodoStateManagerOptions["onCommitted"];
  readonly #logger: Logger;
  #state: ProjectTodoStateFile | undefined;
  #mutation: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string, options: ProjectTodoStateManagerOptions = {}) {
    this.workspaceRoot = workspaceRoot;
    this.#filePath = join(workspaceRoot, ".archcode", "todos", "state.json");
    this.#now = options.now ?? Date.now;
    this.#onCommitted = options.onCommitted;
    this.#logger = (options.logger ?? silentLogger).child({ module: "todos.state" });
  }

  async listTodos(): Promise<ProjectTodo[]> {
    return structuredClone((await this.#read()).todos);
  }

  async readTodo(todoId: string): Promise<ProjectTodo> {
    return structuredClone(requiredTodo(await this.#read(), todoId));
  }

  async createTodo(input: ProjectTodoCreateInput): Promise<ProjectTodo> {
    const validated = ProjectTodoCreateSchema.parse(input);
    return this.#mutate((state) => {
      const now = this.#now();
      const todo: ProjectTodo = {
        id: crypto.randomUUID(),
        title: validated.title,
        body: validated.body ?? "",
        status: "idea",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      state.todos.push(todo);
      return structuredClone(todo);
    });
  }

  async updateTodo(todoId: string, input: ProjectTodoUpdateInput): Promise<ProjectTodo> {
    const patch = ProjectTodoUpdatePatchSchema.parse(input.patch);
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      assertMutable(todo);
      assertRevision(todo, input.expectedRevision);

      const previousStatus = todo.status;
      const nextStatus = patch.status ?? todo.status;
      if (nextStatus !== todo.status && !ALLOWED_TRANSITIONS[todo.status].has(nextStatus)) {
        throw new ProjectTodoInvalidTransitionError(todo.id, todo.status, nextStatus);
      }
      if (todo.activation !== undefined && (nextStatus === "idea" || nextStatus === "rejected")) {
        throw new ProjectTodoActivationConflictError(todo.id, todo.activation.kind, "Active Project Todo cannot change to Idea or Rejected");
      }

      if (patch.title !== undefined) todo.title = patch.title;
      if (patch.body !== undefined) todo.body = patch.body;
      if (patch.status !== undefined) todo.status = patch.status;

      if (nextStatus === "rejected") {
        const reason = patch.rejectionReason ?? todo.rejectionReason;
        if (reason === undefined) {
          throw new ProjectTodoInvalidTransitionError(todo.id, todo.status, "rejected", "Rejected Project Todo requires a rejection reason");
        }
        todo.rejectionReason = reason;
      } else {
        todo.rejectionReason = undefined;
        if (patch.rejectionReason !== undefined) {
          throw new ProjectTodoInvalidTransitionError(todo.id, todo.status, nextStatus, "Rejection reason is only valid for rejected status");
        }
      }

      if (previousStatus === "done" && nextStatus === "ready" && todo.activation !== undefined) {
        // done -> ready is the only transition that clears an old result link.
        todo.activation = undefined;
      }
      touch(todo, this.#now());
      return structuredClone(todo);
    });
  }

  async archiveTodo(todoId: string, expectedRevision: number): Promise<ProjectTodo> {
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      assertRevision(todo, expectedRevision);
      if (todo.archivedAt !== undefined) throw new ProjectTodoArchivedError(todo.id);
      if (todo.activation !== undefined && todo.status === "ready") {
        throw new ProjectTodoActivationConflictError(todo.id, todo.activation.kind, "Active Project Todo cannot be archived");
      }
      todo.archivedAt = this.#now();
      touch(todo, this.#now());
      return structuredClone(todo);
    });
  }

  async restoreTodo(todoId: string, expectedRevision: number): Promise<ProjectTodo> {
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      assertRevision(todo, expectedRevision);
      if (todo.archivedAt === undefined) {
        throw new ProjectTodoInvalidTransitionError(todo.id, todo.status, todo.status, "Project Todo is not archived");
      }
      todo.archivedAt = undefined;
      touch(todo, this.#now());
      return structuredClone(todo);
    });
  }

  /** First checkpoint of the recoverable Discussion creation protocol. */
  async checkpointDiscussion(todoId: string, expectedRevision: number, proposedSessionId: string): Promise<ProjectTodo> {
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      if (todo.discussionSessionId !== undefined) return structuredClone(todo);
      assertMutable(todo);
      assertRevision(todo, expectedRevision);
      assertUniqueSessionReference(state, proposedSessionId);
      todo.discussionSessionId = proposedSessionId;
      touch(todo, this.#now());
      return structuredClone(todo);
    });
  }

  /** First checkpoint of the recoverable Activation creation protocol. */
  async checkpointActivation(
    todoId: string,
    expectedRevision: number,
    kind: ProjectTodoActivationKind,
    proposedSourceSessionId: string,
  ): Promise<ProjectTodo> {
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      if (todo.activation !== undefined) {
        if (
          todo.activation.kind === kind
          && todo.status === "ready"
          && todo.archivedAt === undefined
          && expectedRevision === todo.activation.todoRevision
        ) return structuredClone(todo);
        throw new ProjectTodoActivationConflictError(todo.id, todo.activation.kind);
      }
      assertMutable(todo);
      assertRevision(todo, expectedRevision);
      if (todo.status !== "ready") {
        throw new ProjectTodoInvalidTransitionError(todo.id, todo.status, todo.status, "Only a ready Project Todo can start");
      }
      assertUniqueSessionReference(state, proposedSourceSessionId);
      todo.activation = {
        kind,
        sourceSessionId: proposedSourceSessionId,
        todoRevision: todo.revision,
        snapshot: { title: todo.title, body: todo.body },
        ...(kind === "session" ? { resourceId: proposedSourceSessionId } : {}),
      };
      touch(todo, this.#now());
      return structuredClone(todo);
    });
  }

  async bindActivationResource(todoId: string, sourceSessionId: string, resourceId: string): Promise<ProjectTodo> {
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      const activation = todo.activation;
      if (activation === undefined || activation.sourceSessionId !== sourceSessionId || activation.kind === "session") {
        throw new ProjectTodoActivationConflictError(todo.id, activation?.kind, "Project Todo Activation does not match resource provenance");
      }
      if (activation.resourceId !== undefined) {
        if (activation.resourceId === resourceId) return structuredClone(todo);
        throw new ProjectTodoResourceBindingConflictError(todo.id, activation.resourceId, resourceId);
      }
      activation.resourceId = resourceId;
      touch(todo, this.#now());
      return structuredClone(todo);
    });
  }

  async clearActivation(todoId: string, expectedRevision: number, sourceSessionId: string): Promise<ProjectTodo> {
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      assertRevision(todo, expectedRevision);
      if (todo.activation?.sourceSessionId !== sourceSessionId) {
        throw new ProjectTodoActivationConflictError(todo.id, todo.activation?.kind, "Project Todo Activation changed during readiness check");
      }
      todo.activation = undefined;
      todo.status = "ready";
      todo.rejectionReason = undefined;
      touch(todo, this.#now());
      return structuredClone(todo);
    });
  }

  async findByDiscussionSessionId(sessionId: string): Promise<ProjectTodo | undefined> {
    const todo = (await this.#read()).todos.find((item) => item.discussionSessionId === sessionId);
    return todo === undefined ? undefined : structuredClone(todo);
  }

  async findByActivationSourceSessionId(sessionId: string): Promise<ProjectTodo | undefined> {
    const todo = (await this.#read()).todos.find((item) => item.activation?.sourceSessionId === sessionId);
    return todo === undefined ? undefined : structuredClone(todo);
  }

  async findSessionOwners(sessionIds: readonly string[]): Promise<ProjectTodoSessionOwner[]> {
    const requested = new Set(sessionIds);
    const owners: ProjectTodoSessionOwner[] = [];
    for (const todo of (await this.#read()).todos) {
      if (todo.discussionSessionId !== undefined && requested.has(todo.discussionSessionId)) {
        owners.push({ sessionId: todo.discussionSessionId, ownerType: "project_todo", ownerId: todo.id });
      }
      if (todo.activation !== undefined && requested.has(todo.activation.sourceSessionId)) {
        owners.push({ sessionId: todo.activation.sourceSessionId, ownerType: "project_todo", ownerId: todo.id });
      }
    }
    return owners.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  async #read(): Promise<ProjectTodoStateFile> {
    await this.#mutation;
    return this.#load();
  }

  async #load(): Promise<ProjectTodoStateFile> {
    if (this.#state !== undefined) return this.#state;
    const file = Bun.file(this.#filePath);
    if (!(await file.exists())) {
      this.#state = { todos: [] };
      return this.#state;
    }
    this.#state = ProjectTodoStateFileSchema.parse(await file.json());
    return this.#state;
  }

  #mutate<T extends ProjectTodo>(mutation: (state: ProjectTodoStateFile) => T | Promise<T>): Promise<T> {
    const operation = this.#mutation.then(async () => {
      const state = structuredClone(await this.#load());
      const before = JSON.stringify(state);
      const result = await mutation(state);
      const parsed = ProjectTodoStateFileSchema.parse(state);
      if (JSON.stringify(parsed) === before) return result;
      await atomicWrite(this.#filePath, `${JSON.stringify(parsed, null, 2)}\n`);
      this.#state = parsed;
      this.#notifyCommitted(result);
      return result;
    });
    this.#mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #notifyCommitted(todo: ProjectTodo): void {
    if (this.#onCommitted === undefined) return;
    try {
      void Promise.resolve(this.#onCommitted(structuredClone(todo))).catch((error: unknown) => {
        this.#logger.warn("todos.commit.notification_failed", { error, context: { todoId: todo.id } });
      });
    } catch (error) {
      this.#logger.warn("todos.commit.notification_failed", { error, context: { todoId: todo.id } });
    }
  }
}

function requiredTodo(state: ProjectTodoStateFile, todoId: string): MutableProjectTodo {
  const todo = state.todos.find((item) => item.id === todoId);
  if (todo === undefined) throw new ProjectTodoNotFoundError(todoId);
  return todo as MutableProjectTodo;
}

function assertMutable(todo: ProjectTodo): void {
  if (todo.archivedAt !== undefined) throw new ProjectTodoArchivedError(todo.id);
}

function assertRevision(todo: ProjectTodo, expectedRevision: number): void {
  if (todo.revision !== expectedRevision) {
    throw new ProjectTodoRevisionConflictError(todo.id, expectedRevision, todo.revision);
  }
}

function assertUniqueSessionReference(state: ProjectTodoStateFile, sessionId: string): void {
  const referenced = state.todos.some((todo) => (
    todo.discussionSessionId === sessionId || todo.activation?.sourceSessionId === sessionId
  ));
  if (referenced) throw new Error(`Session is already owned by a Project Todo: ${sessionId}`);
}

function touch(todo: MutableProjectTodo, now: number): void {
  todo.revision += 1;
  todo.updatedAt = now;
}
