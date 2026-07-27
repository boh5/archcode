import type {
  ProjectTodo,
  ProjectTodoCreateInput,
  ProjectTodoStatus,
  ProjectTodoUpdateInput,
} from "@archcode/protocol";

import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { projectRuntimePath } from "../projects/runtime-path";
import { atomicWrite } from "../utils/safe-file";
import {
  ProjectTodoArchivedError,
  ProjectTodoInvalidMutationError,
  ProjectTodoNotFoundError,
  ProjectTodoRevisionConflictError,
  ProjectTodoSessionStateError,
} from "./errors";
import {
  ProjectTodoCreateSchema,
  ProjectTodoStateFileSchema,
  ProjectTodoUpdateSchema,
  type ProjectTodoStateFile,
} from "./schema";

const BOARD_STATUSES: ReadonlySet<ProjectTodoStatus> = new Set([
  "idea",
  "ready",
  "in_progress",
  "done",
]);

type MutableProjectTodo = { -readonly [Key in keyof ProjectTodo]: ProjectTodo[Key] };

export interface ProjectTodoStateManagerOptions {
  readonly now?: () => number;
  readonly onCommitted?: (todo: ProjectTodo) => void | Promise<void>;
  readonly logger?: Logger;
}

/** Strict Todo persistence and serialized Todo-only mutations. */
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
    this.#filePath = projectRuntimePath(workspaceRoot, "todos", "state.json");
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
    const update = ProjectTodoUpdateSchema.parse(input);
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      assertRevision(todo, update.expectedRevision);

      if (update.archived !== undefined) {
        return this.#setArchived(todo, update.archived);
      }

      assertMutable(todo);
      const previousStatus = todo.status;
      const finalStatus = update.status ?? previousStatus;
      validateRejection(todo, finalStatus, update.rejectionReason);
      validateAnchor(state, todo, finalStatus, update.beforeTodoId);

      if (update.title !== undefined) todo.title = update.title;
      if (update.body !== undefined) todo.body = update.body;
      todo.status = finalStatus;
      if (finalStatus === "rejected") {
        todo.rejectionReason = update.rejectionReason ?? todo.rejectionReason;
      } else {
        todo.rejectionReason = undefined;
      }

      const shouldReorder = update.beforeTodoId !== undefined || finalStatus !== previousStatus;
      if (shouldReorder) reorderTodo(state.todos, todo, finalStatus, update.beforeTodoId ?? null);
      touch(todo, this.#now());
      return structuredClone(todo);
    });
  }

  /** Reads a Todo and verifies its revision inside the serialized mutation lane. */
  async readCurrentTodo(todoId: string, expectedRevision: number): Promise<ProjectTodo> {
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      assertMutable(todo);
      assertRevision(todo, expectedRevision);
      return structuredClone(todo);
    });
  }

  /**
   * Applies the only Todo consequence of starting work. Ready becomes
   * In Progress at that lane's end; In Progress is a validated no-op.
   */
  async beginWork(todoId: string, expectedRevision: number): Promise<ProjectTodo> {
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      assertMutable(todo);
      assertRevision(todo, expectedRevision);
      if (todo.status !== "ready" && todo.status !== "in_progress") {
        throw new ProjectTodoSessionStateError(todo.id, todo.status);
      }
      if (todo.status === "in_progress") return structuredClone(todo);

      todo.status = "in_progress";
      todo.rejectionReason = undefined;
      reorderTodo(state.todos, todo, "in_progress", null);
      touch(todo, this.#now());
      return structuredClone(todo);
    });
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

  #setArchived(todo: MutableProjectTodo, archived: boolean): ProjectTodo {
    if (archived) {
      if (todo.archivedAt !== undefined) {
        throw new ProjectTodoInvalidMutationError(todo.id, "Todo is already archived");
      }
      todo.archivedAt = this.#now();
    } else {
      if (todo.archivedAt === undefined) {
        throw new ProjectTodoInvalidMutationError(todo.id, "Todo is not archived");
      }
      todo.archivedAt = undefined;
    }
    touch(todo, this.#now());
    return structuredClone(todo);
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

function validateRejection(
  todo: ProjectTodo,
  finalStatus: ProjectTodoStatus,
  rejectionReason: string | undefined,
): void {
  if (finalStatus === "rejected") {
    if (rejectionReason === undefined && todo.status !== "rejected") {
      throw new ProjectTodoInvalidMutationError(todo.id, "entering Rejected requires a rejection reason");
    }
    return;
  }
  if (rejectionReason !== undefined) {
    throw new ProjectTodoInvalidMutationError(todo.id, "rejectionReason is only valid for Rejected");
  }
}

function validateAnchor(
  state: ProjectTodoStateFile,
  todo: ProjectTodo,
  finalStatus: ProjectTodoStatus,
  beforeTodoId: string | null | undefined,
): void {
  if (beforeTodoId === undefined) return;
  if (!BOARD_STATUSES.has(finalStatus)) {
    throw new ProjectTodoInvalidMutationError(todo.id, "Rejected Todo cannot be ordered on the Board");
  }
  if (beforeTodoId === null) return;
  if (beforeTodoId === todo.id) {
    throw new ProjectTodoInvalidMutationError(todo.id, "Todo cannot be ordered before itself");
  }
  const anchor = state.todos.find((candidate) => candidate.id === beforeTodoId);
  if (anchor === undefined) {
    throw new ProjectTodoInvalidMutationError(todo.id, `anchor does not exist: ${beforeTodoId}`);
  }
  if (anchor.archivedAt !== undefined) {
    throw new ProjectTodoInvalidMutationError(todo.id, `anchor is archived: ${beforeTodoId}`);
  }
  if (anchor.status !== finalStatus) {
    throw new ProjectTodoInvalidMutationError(todo.id, `anchor is not in ${finalStatus}: ${beforeTodoId}`);
  }
}

function reorderTodo(
  todos: ProjectTodo[],
  todo: MutableProjectTodo,
  finalStatus: ProjectTodoStatus,
  beforeTodoId: string | null,
): void {
  const currentIndex = todos.findIndex((candidate) => candidate.id === todo.id);
  todos.splice(currentIndex, 1);

  if (beforeTodoId !== null) {
    const anchorIndex = todos.findIndex((candidate) => candidate.id === beforeTodoId);
    todos.splice(anchorIndex, 0, todo);
    return;
  }

  let insertionIndex = todos.length;
  for (let index = todos.length - 1; index >= 0; index -= 1) {
    const candidate = todos[index]!;
    if (candidate.status === finalStatus && candidate.archivedAt === undefined) {
      insertionIndex = index + 1;
      break;
    }
  }
  todos.splice(insertionIndex, 0, todo);
}

function touch(todo: MutableProjectTodo, now: number): void {
  todo.revision += 1;
  todo.updatedAt = now;
}
