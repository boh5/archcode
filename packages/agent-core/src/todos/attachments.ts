import type {
  AttachmentDescriptor,
  ProjectTodo,
  ProjectTodoAttachmentListResponse,
  ProjectTodoAttachmentMutationResponse,
} from "@archcode/protocol";

import {
  AsyncKeyedMutex,
  AttachmentNotFoundError,
  type OpenProjectAttachmentResult,
  ProjectAttachmentStorage,
  type VerifiedProjectAttachment,
} from "../attachments";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import type { ProjectTodoStateManager } from "./state-manager";
import { ProjectTodoRevisionConflictError } from "./errors";

export interface UploadProjectTodoAttachmentInput {
  readonly todoId: string;
  readonly attachmentId: string;
  readonly expectedRevision: number;
  readonly name: string;
  readonly sizeBytes: number;
  readonly mediaType?: string;
  readonly contentLength?: number;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface OpenProjectTodoAttachmentInput {
  readonly todoId: string;
  readonly attachmentId: string;
}

export interface RemoveProjectTodoAttachmentInput extends OpenProjectTodoAttachmentInput {
  readonly expectedRevision: number;
}

export interface ProjectTodoAttachmentServiceOptions {
  readonly workspaceRoot: string;
  readonly state: ProjectTodoStateManager;
  readonly storage: ProjectAttachmentStorage;
  readonly logger?: Logger;
}

/** Todo ownership and revision semantics over the concrete project attachment storage. */
export class ProjectTodoAttachmentService {
  readonly #workspaceRoot: string;
  readonly #state: ProjectTodoStateManager;
  readonly #storage: ProjectAttachmentStorage;
  readonly #logger: Logger;
  readonly #referenceMutations = new AsyncKeyedMutex();

  constructor(options: ProjectTodoAttachmentServiceOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#state = options.state;
    this.#storage = options.storage;
    this.#logger = (options.logger ?? silentLogger).child({ module: "todos.attachments" });
  }

  async list(todoId: string): Promise<ProjectTodoAttachmentListResponse> {
    const todo = await this.#state.readTodo(todoId);
    return {
      todoRevision: todo.revision,
      attachments: await this.#storage.resolveDescriptors({
        workspaceRoot: this.#workspaceRoot,
        owner: todoOwner(todoId),
        attachmentIds: todo.attachmentIds,
      }),
    };
  }

  async upload(
    input: UploadProjectTodoAttachmentInput,
  ): Promise<ProjectTodoAttachmentMutationResponse> {
    return await this.#referenceMutations.withLock(
      referenceMutationKey(input),
      async () => await this.#upload(input),
    );
  }

  async #upload(
    input: UploadProjectTodoAttachmentInput,
  ): Promise<ProjectTodoAttachmentMutationResponse> {
    const current = await this.#state.readTodo(input.todoId);
    const alreadyReferenced = current.attachmentIds.includes(input.attachmentId);
    if (!alreadyReferenced) assertExpectedRevision(current, input.expectedRevision);
    const uploaded = await this.#storage.upload({
      workspaceRoot: this.#workspaceRoot,
      owner: todoOwner(input.todoId),
      attachmentId: input.attachmentId,
      name: input.name,
      sizeBytes: input.sizeBytes,
      mediaType: input.mediaType,
      contentLength: input.contentLength,
      body: input.body,
    });
    if (alreadyReferenced) {
      const latest = await this.#state.readTodo(input.todoId);
      if (latest.attachmentIds.includes(input.attachmentId)) {
        return { todo: latest, attachment: uploaded.descriptor };
      }
      throw new ProjectTodoRevisionConflictError(
        input.todoId,
        input.expectedRevision,
        latest.revision,
      );
    }
    try {
      const todo = await this.#state.addAttachmentReference(
        input.todoId,
        input.attachmentId,
        input.expectedRevision,
      );
      return { todo, attachment: uploaded.descriptor };
    } catch (error) {
      const attachmentWasActivated = (await this.#state.readTodo(input.todoId))
        .attachmentIds.includes(input.attachmentId);
      if (!current.attachmentIds.includes(input.attachmentId) && !attachmentWasActivated && uploaded.created) {
        try {
          await this.#storage.removeAttachment(objectInput(input.todoId, input.attachmentId, this.#workspaceRoot));
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Todo attachment activation failed and its unreferenced object could not be removed: ${input.attachmentId}`,
          );
        }
      }
      throw error;
    }
  }

  async openDownload(
    input: OpenProjectTodoAttachmentInput,
  ): Promise<OpenProjectAttachmentResult> {
    await this.#requireReference(input.todoId, input.attachmentId);
    return await this.#storage.openDownload(objectInput(
      input.todoId,
      input.attachmentId,
      this.#workspaceRoot,
    ));
  }

  async resolveReadPath(
    input: OpenProjectTodoAttachmentInput,
    expectedDescriptor: AttachmentDescriptor,
  ): Promise<string> {
    await this.#requireReference(input.todoId, input.attachmentId);
    return await this.#storage.resolveReadPath(
      objectInput(input.todoId, input.attachmentId, this.#workspaceRoot),
      expectedDescriptor,
    );
  }

  async readVerified(
    input: OpenProjectTodoAttachmentInput,
    expectedDescriptor: AttachmentDescriptor,
  ): Promise<VerifiedProjectAttachment> {
    await this.#requireReference(input.todoId, input.attachmentId);
    return await this.#storage.readVerified(
      objectInput(input.todoId, input.attachmentId, this.#workspaceRoot),
      expectedDescriptor,
    );
  }

  async remove(input: RemoveProjectTodoAttachmentInput): Promise<ProjectTodo> {
    return await this.#referenceMutations.withLock(
      referenceMutationKey(input),
      async () => await this.#remove(input),
    );
  }

  async #remove(input: RemoveProjectTodoAttachmentInput): Promise<ProjectTodo> {
    const todo = await this.#state.removeAttachmentReference(
      input.todoId,
      input.attachmentId,
      input.expectedRevision,
    );
    try {
      await this.#storage.removeAttachment(objectInput(
        input.todoId,
        input.attachmentId,
        this.#workspaceRoot,
      ));
    } catch (error) {
      this.#logger.warn("todos.attachments.cleanup_failed", {
        error,
        context: { todoId: input.todoId, attachmentId: input.attachmentId },
      });
    }
    return todo;
  }

  async #requireReference(todoId: string, attachmentId: string): Promise<void> {
    const todo = await this.#state.readTodo(todoId);
    if (!todo.attachmentIds.includes(attachmentId)) {
      throw new AttachmentNotFoundError(attachmentId);
    }
  }
}

function todoOwner(todoId: string): { readonly kind: "todo"; readonly id: string } {
  return { kind: "todo", id: todoId };
}

function objectInput(todoId: string, attachmentId: string, workspaceRoot: string) {
  return {
    workspaceRoot,
    owner: todoOwner(todoId),
    attachmentId,
  } as const;
}

function referenceMutationKey(input: OpenProjectTodoAttachmentInput): string {
  return `${input.todoId}:${input.attachmentId}`;
}

function assertExpectedRevision(todo: ProjectTodo, expectedRevision: number): void {
  if (todo.revision !== expectedRevision) {
    throw new ProjectTodoRevisionConflictError(
      todo.id,
      expectedRevision,
      todo.revision,
    );
  }
}
