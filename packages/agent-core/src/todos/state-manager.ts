import type {
  ProjectTodo,
  ProjectTodoCreateInput,
  ProjectTodoStartDiscussionReceipt,
  ProjectTodoStatus,
  ProjectTodoUpdateInput,
} from "@archcode/protocol";
import { MAX_ATTACHMENTS_PER_TODO } from "@archcode/protocol";

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
  ProjectTodoAttachmentIdSchema,
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
type MutableProjectTodoRunNowReceipt = { -readonly [Key in keyof ProjectTodoRunNowReceipt]: ProjectTodoRunNowReceipt[Key] };
type MutableProjectTodoStartDiscussionReceipt = {
  -readonly [Key in keyof ProjectTodoStartDiscussionReceipt]: ProjectTodoStartDiscussionReceipt[Key]
};

export interface ProjectTodoRunNowReceipt {
  readonly clientRequestId: string;
  readonly requestHash: string;
  readonly todoId: string;
  readonly sessionId: string;
  readonly status: "preparing" | "recovery_required" | "accepted";
}

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
    const state = await this.#read();
    const hiddenTodoIds = new Set([
      ...state.runNowReceipts,
      ...state.startDiscussionReceipts,
    ].filter((receipt) => receipt.status === "preparing").map((receipt) => receipt.todoId));
    return structuredClone(state.todos.filter((todo) => !hiddenTodoIds.has(todo.id)));
  }

  async readTodo(todoId: string): Promise<ProjectTodo> {
    return structuredClone(requiredTodo(await this.#read(), todoId));
  }

  async createTodo(input: ProjectTodoCreateInput): Promise<ProjectTodo> {
    const validated = ProjectTodoCreateSchema.parse({ content: input.content });
    return this.#mutate((state) => {
      const now = this.#now();
      const todo: ProjectTodo = {
        id: crypto.randomUUID(),
        content: validated.content,
        attachmentIds: [],
        status: "idea",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      state.todos.push(todo);
      return structuredClone(todo);
    }, (todo) => todo);
  }

  async beginRunNow(
    input: ProjectTodoCreateInput & { readonly clientRequestId: string; readonly requestHash: string },
  ): Promise<{ readonly todo: ProjectTodo; readonly receipt: ProjectTodoRunNowReceipt }> {
    const validated = ProjectTodoCreateSchema.parse({ content: input.content });
    return this.#mutate((state) => {
      const now = this.#now();
      const todo: ProjectTodo = {
        id: crypto.randomUUID(),
        content: validated.content,
        attachmentIds: [],
        status: "in_progress",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      state.todos.push(todo);
      const receipt: ProjectTodoRunNowReceipt = {
        clientRequestId: input.clientRequestId,
        requestHash: input.requestHash,
        todoId: todo.id,
        sessionId: crypto.randomUUID(),
        status: "preparing",
      };
      state.runNowReceipts.push(receipt);
      return structuredClone({ todo, receipt });
    });
  }

  async readRunNowReceipt(clientRequestId: string): Promise<ProjectTodoRunNowReceipt | undefined> {
    const receipt = (await this.#read()).runNowReceipts.find((item) => item.clientRequestId === clientRequestId);
    return receipt === undefined ? undefined : structuredClone(receipt);
  }

  async readRunNowTodo(clientRequestId: string): Promise<ProjectTodo> {
    const state = await this.#read();
    const receipt = state.runNowReceipts.find((item) => item.clientRequestId === clientRequestId);
    if (receipt === undefined) throw new ProjectTodoNotFoundError(clientRequestId);
    return structuredClone(requiredTodo(state, receipt.todoId));
  }

  async completeRunNow(clientRequestId: string): Promise<ProjectTodoRunNowReceipt> {
    return this.#mutate((state) => {
      const receipt = requiredRunNowReceipt(state, clientRequestId);
      receipt.status = "accepted";
      return structuredClone(receipt);
    }, (receipt) => this.#state?.todos.find((todo) => todo.id === receipt.todoId));
  }

  async markRunNowRecoveryRequired(clientRequestId: string): Promise<ProjectTodoRunNowReceipt> {
    return this.#mutate((state) => {
      const receipt = requiredRunNowReceipt(state, clientRequestId);
      if (receipt.status === "accepted") return structuredClone(receipt);
      receipt.status = "recovery_required";
      return structuredClone(receipt);
    }, (receipt) => this.#state?.todos.find((todo) => todo.id === receipt.todoId));
  }

  async deletePendingRunNow(clientRequestId: string, todoId: string): Promise<void> {
    await this.#mutate((state) => {
      const receiptIndex = state.runNowReceipts.findIndex((item) => item.clientRequestId === clientRequestId);
      const receipt = state.runNowReceipts[receiptIndex];
      if (receipt === undefined || receipt.todoId !== todoId || receipt.status !== "preparing") {
        throw new ProjectTodoInvalidMutationError(todoId, "Run-now reservation is no longer compensatable");
      }
      const todoIndex = state.todos.findIndex((todo) => todo.id === todoId);
      const todo = state.todos[todoIndex];
      if (todo === undefined) throw new ProjectTodoNotFoundError(todoId);
      if (todo.revision !== 1 || todo.status !== "in_progress" || todo.attachmentIds.length !== 0) {
        throw new ProjectTodoInvalidMutationError(todoId, "Run-now Todo changed before compensation");
      }
      state.runNowReceipts.splice(receiptIndex, 1);
      state.todos.splice(todoIndex, 1);
    });
  }

  async beginStartDiscussion(
    input: ProjectTodoCreateInput & { readonly clientRequestId: string; readonly requestHash: string },
  ): Promise<{ readonly todo: ProjectTodo; readonly receipt: ProjectTodoStartDiscussionReceipt }> {
    const validated = ProjectTodoCreateSchema.parse({ content: input.content });
    return this.#mutate((state) => {
      const now = this.#now();
      const todo: ProjectTodo = {
        id: crypto.randomUUID(),
        content: validated.content,
        attachmentIds: [],
        status: "idea",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      state.todos.push(todo);
      const receipt: ProjectTodoStartDiscussionReceipt = {
        clientRequestId: input.clientRequestId,
        requestHash: input.requestHash,
        todoId: todo.id,
        sessionId: crypto.randomUUID(),
        status: "preparing",
      };
      state.startDiscussionReceipts.push(receipt);
      return structuredClone({ todo, receipt });
    });
  }

  async readStartDiscussionReceipt(
    clientRequestId: string,
  ): Promise<ProjectTodoStartDiscussionReceipt | undefined> {
    const receipt = (await this.#read()).startDiscussionReceipts.find(
      (item) => item.clientRequestId === clientRequestId,
    );
    return receipt === undefined ? undefined : structuredClone(receipt);
  }

  async readStartDiscussionTodo(clientRequestId: string): Promise<ProjectTodo> {
    const state = await this.#read();
    const receipt = state.startDiscussionReceipts.find(
      (item) => item.clientRequestId === clientRequestId,
    );
    if (receipt === undefined) throw new ProjectTodoNotFoundError(clientRequestId);
    return structuredClone(requiredTodo(state, receipt.todoId));
  }

  async completeStartDiscussion(clientRequestId: string): Promise<ProjectTodoStartDiscussionReceipt> {
    return this.#mutate((state) => {
      const receipt = requiredStartDiscussionReceipt(state, clientRequestId);
      receipt.status = "accepted";
      return structuredClone(receipt);
    }, (receipt) => this.#state?.todos.find((todo) => todo.id === receipt.todoId));
  }

  async markStartDiscussionRecoveryRequired(
    clientRequestId: string,
  ): Promise<ProjectTodoStartDiscussionReceipt> {
    return this.#mutate((state) => {
      const receipt = requiredStartDiscussionReceipt(state, clientRequestId);
      if (receipt.status === "accepted") return structuredClone(receipt);
      receipt.status = "recovery_required";
      return structuredClone(receipt);
    }, (receipt) => this.#state?.todos.find((todo) => todo.id === receipt.todoId));
  }

  async deletePendingStartDiscussion(clientRequestId: string, todoId: string): Promise<void> {
    await this.#mutate((state) => {
      const receiptIndex = state.startDiscussionReceipts.findIndex(
        (item) => item.clientRequestId === clientRequestId,
      );
      const receipt = state.startDiscussionReceipts[receiptIndex];
      if (receipt === undefined || receipt.todoId !== todoId || receipt.status !== "preparing") {
        throw new ProjectTodoInvalidMutationError(
          todoId,
          "Start-discussion reservation is no longer compensatable",
        );
      }
      const todoIndex = state.todos.findIndex((todo) => todo.id === todoId);
      const todo = state.todos[todoIndex];
      if (todo === undefined) throw new ProjectTodoNotFoundError(todoId);
      if (todo.revision !== 1 || todo.status !== "idea" || todo.attachmentIds.length !== 0) {
        throw new ProjectTodoInvalidMutationError(
          todoId,
          "Start-discussion Todo changed before compensation",
        );
      }
      state.startDiscussionReceipts.splice(receiptIndex, 1);
      state.todos.splice(todoIndex, 1);
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

      if (update.content !== undefined) todo.content = update.content;
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
    }, (todo) => todo);
  }

  async addAttachmentReference(
    todoId: string,
    attachmentId: string,
    expectedRevision: number,
  ): Promise<ProjectTodo> {
    const validatedAttachmentId = ProjectTodoAttachmentIdSchema.parse(attachmentId);
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      assertRevision(todo, expectedRevision);
      if (todo.attachmentIds.includes(validatedAttachmentId)) return structuredClone(todo);
      if (todo.attachmentIds.length >= MAX_ATTACHMENTS_PER_TODO) {
        throw new ProjectTodoInvalidMutationError(
          todo.id,
          `Todo cannot retain more than ${MAX_ATTACHMENTS_PER_TODO} attachments`,
        );
      }
      todo.attachmentIds.push(validatedAttachmentId);
      touch(todo, this.#now());
      return structuredClone(todo);
    }, (todo) => todo);
  }

  async removeAttachmentReference(
    todoId: string,
    attachmentId: string,
    expectedRevision: number,
  ): Promise<ProjectTodo> {
    const validatedAttachmentId = ProjectTodoAttachmentIdSchema.parse(attachmentId);
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      assertRevision(todo, expectedRevision);
      const index = todo.attachmentIds.indexOf(validatedAttachmentId);
      if (index < 0) {
        throw new ProjectTodoInvalidMutationError(
          todo.id,
          `Todo does not reference attachment: ${validatedAttachmentId}`,
        );
      }
      todo.attachmentIds.splice(index, 1);
      touch(todo, this.#now());
      return structuredClone(todo);
    }, (todo) => todo);
  }

  /** Reads a Todo and verifies its revision inside the serialized mutation lane. */
  async readCurrentTodo(todoId: string, expectedRevision: number): Promise<ProjectTodo> {
    return this.#mutate((state) => {
      const todo = requiredTodo(state, todoId);
      assertMutable(todo);
      assertRevision(todo, expectedRevision);
      return structuredClone(todo);
    }, (todo) => todo);
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
    }, (todo) => todo);
  }

  async #read(): Promise<ProjectTodoStateFile> {
    await this.#mutation;
    return this.#load();
  }

  async #load(): Promise<ProjectTodoStateFile> {
    if (this.#state !== undefined) return this.#state;
    const file = Bun.file(this.#filePath);
    if (!(await file.exists())) {
      this.#state = { todos: [], runNowReceipts: [], startDiscussionReceipts: [] };
      return this.#state;
    }
    this.#state = ProjectTodoStateFileSchema.parse(await file.json());
    return this.#state;
  }

  #mutate<T>(
    mutation: (state: ProjectTodoStateFile) => T | Promise<T>,
    committedTodo?: (result: T) => ProjectTodo | undefined,
  ): Promise<T> {
    const operation = this.#mutation.then(async () => {
      const state = structuredClone(await this.#load());
      const before = JSON.stringify(state);
      const result = await mutation(state);
      const parsed = ProjectTodoStateFileSchema.parse(state);
      if (JSON.stringify(parsed) === before) return result;
      await atomicWrite(this.#filePath, `${JSON.stringify(parsed, null, 2)}\n`);
      this.#state = parsed;
      const todo = committedTodo?.(result);
      if (todo !== undefined) this.#notifyCommitted(todo);
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

function requiredRunNowReceipt(
  state: ProjectTodoStateFile,
  clientRequestId: string,
): MutableProjectTodoRunNowReceipt {
  const receipt = state.runNowReceipts.find((item) => item.clientRequestId === clientRequestId);
  if (receipt === undefined) throw new ProjectTodoNotFoundError(clientRequestId);
  return receipt as MutableProjectTodoRunNowReceipt;
}

function requiredStartDiscussionReceipt(
  state: ProjectTodoStateFile,
  clientRequestId: string,
): MutableProjectTodoStartDiscussionReceipt {
  const receipt = state.startDiscussionReceipts.find(
    (item) => item.clientRequestId === clientRequestId,
  );
  if (receipt === undefined) throw new ProjectTodoNotFoundError(clientRequestId);
  return receipt as MutableProjectTodoStartDiscussionReceipt;
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
