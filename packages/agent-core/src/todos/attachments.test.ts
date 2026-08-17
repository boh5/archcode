import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { ProjectAttachmentStorage } from "../attachments";
import { createInMemoryLogger } from "../logger";
import { ProjectTodoRevisionConflictError } from "./errors";
import { ProjectTodoAttachmentService } from "./attachments";
import { ProjectTodoStateManager } from "./state-manager";

const WORKSPACE = join(import.meta.dir, "__test_tmp__", "todo-attachments", crypto.randomUUID());

beforeEach(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
  await mkdir(WORKSPACE, { recursive: true });
});

afterAll(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
});

describe("ProjectTodoAttachmentService", () => {
  test("activates, lists, retries, and removes one ordered live reference", async () => {
    const state = new ProjectTodoStateManager(WORKSPACE);
    const service = new ProjectTodoAttachmentService({
      workspaceRoot: WORKSPACE,
      state,
      storage: new ProjectAttachmentStorage(),
    });
    const created = await state.createTodo({ content: "Read the attached brief" });
    const attachmentId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("brief");

    const uploaded = await service.upload({
      todoId: created.id,
      attachmentId,
      expectedRevision: created.revision,
      name: "brief.txt",
      sizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      body: byteStream(bytes),
    });
    expect(uploaded.todo).toMatchObject({ revision: 2, attachmentIds: [attachmentId] });
    expect(await service.list(created.id)).toEqual({
      todoRevision: 2,
      attachments: [uploaded.attachment],
    });

    const retried = await service.upload({
      todoId: created.id,
      attachmentId,
      expectedRevision: created.revision,
      name: "brief.txt",
      sizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      body: byteStream(bytes),
    });
    expect(retried.todo.revision).toBe(2);

    const removed = await service.remove({
      todoId: created.id,
      attachmentId,
      expectedRevision: retried.todo.revision,
    });
    expect(removed).toMatchObject({ revision: 3, attachmentIds: [] });
    expect(await service.list(created.id)).toEqual({ todoRevision: 3, attachments: [] });
    expect(await Bun.file(todoContentPath(created.id, attachmentId)).exists()).toBe(false);
  });

  test("cleans an unactivated object when the serialized revision mutation fails", async () => {
    const state = new ProjectTodoStateManager(WORKSPACE);
    const storage = new ProjectAttachmentStorage();
    const service = new ProjectTodoAttachmentService({ workspaceRoot: WORKSPACE, state, storage });
    const todo = await state.createTodo({ content: "Concurrent edit" });
    const attachmentId = crypto.randomUUID();
    const activation = spyOn(state, "addAttachmentReference").mockRejectedValueOnce(
      new ProjectTodoRevisionConflictError(todo.id, todo.revision, todo.revision + 1),
    );

    await expect(service.upload({
      todoId: todo.id,
      attachmentId,
      expectedRevision: todo.revision,
      name: "race.txt",
      sizeBytes: 1,
      body: byteStream(Uint8Array.of(1)),
    })).rejects.toBeInstanceOf(ProjectTodoRevisionConflictError);
    activation.mockRestore();
    expect(await Bun.file(todoContentPath(todo.id, attachmentId)).exists()).toBe(false);
    expect((await state.readTodo(todo.id)).attachmentIds).toEqual([]);
  });

  test("linearizes an in-flight idempotent retry before removing the same reference", async () => {
    const state = new ProjectTodoStateManager(WORKSPACE);
    const storage = new ProjectAttachmentStorage();
    const service = new ProjectTodoAttachmentService({ workspaceRoot: WORKSPACE, state, storage });
    const todo = await state.createTodo({ content: "Retry removal race" });
    const attachmentId = crypto.randomUUID();
    const bytes = Uint8Array.of(1);
    const uploaded = await service.upload({
      todoId: todo.id,
      attachmentId,
      expectedRevision: todo.revision,
      name: "race.txt",
      sizeBytes: bytes.byteLength,
      body: byteStream(bytes),
    });

    const originalUpload = storage.upload.bind(storage);
    let releaseRetry!: () => void;
    let markRetryStored!: () => void;
    const retryStored = new Promise<void>((resolve) => { markRetryStored = resolve; });
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const retryUpload = spyOn(storage, "upload").mockImplementationOnce(async (input) => {
      const result = await originalUpload(input);
      markRetryStored();
      await retryGate;
      return result;
    });

    const retry = service.upload({
      todoId: todo.id,
      attachmentId,
      expectedRevision: todo.revision,
      name: "race.txt",
      sizeBytes: bytes.byteLength,
      body: byteStream(bytes),
    });
    await retryStored;
    const removing = service.remove({
      todoId: todo.id,
      attachmentId,
      expectedRevision: uploaded.todo.revision,
    });
    releaseRetry();

    await expect(retry).resolves.toMatchObject({
      todo: { revision: uploaded.todo.revision, attachmentIds: [attachmentId] },
    });
    await expect(removing).resolves.toMatchObject({
      revision: uploaded.todo.revision + 1,
      attachmentIds: [],
    });
    expect(await Bun.file(todoContentPath(todo.id, attachmentId)).exists()).toBe(false);
    retryUpload.mockRestore();
  });

  test("does not recreate an object when removal linearizes before an idempotent retry", async () => {
    const state = new ProjectTodoStateManager(WORKSPACE);
    const storage = new ProjectAttachmentStorage();
    const service = new ProjectTodoAttachmentService({ workspaceRoot: WORKSPACE, state, storage });
    const todo = await state.createTodo({ content: "Removal before retry" });
    const attachmentId = crypto.randomUUID();
    const bytes = Uint8Array.of(1);
    const uploaded = await service.upload({
      todoId: todo.id,
      attachmentId,
      expectedRevision: todo.revision,
      name: "race.txt",
      sizeBytes: bytes.byteLength,
      body: byteStream(bytes),
    });

    const originalRemove = storage.removeAttachment.bind(storage);
    let releaseRemove!: () => void;
    let markRemoveStarted!: () => void;
    const removeStarted = new Promise<void>((resolve) => { markRemoveStarted = resolve; });
    const removeGate = new Promise<void>((resolve) => { releaseRemove = resolve; });
    const removeObject = spyOn(storage, "removeAttachment").mockImplementationOnce(async (input) => {
      markRemoveStarted();
      await removeGate;
      await originalRemove(input);
    });

    const removing = service.remove({
      todoId: todo.id,
      attachmentId,
      expectedRevision: uploaded.todo.revision,
    });
    await removeStarted;
    const retryObject = spyOn(storage, "upload");
    const retry = service.upload({
      todoId: todo.id,
      attachmentId,
      expectedRevision: todo.revision,
      name: "race.txt",
      sizeBytes: bytes.byteLength,
      body: byteStream(bytes),
    });
    releaseRemove();

    const removed = await removing;
    await expect(retry).rejects.toMatchObject({
      code: "PROJECT_TODO_REVISION_CONFLICT",
      actualRevision: removed.revision,
    });
    expect(retryObject).not.toHaveBeenCalled();
    expect(await Bun.file(todoContentPath(todo.id, attachmentId)).exists()).toBe(false);
    removeObject.mockRestore();
    retryObject.mockRestore();
  });

  test("keeps logical removal authoritative when physical cleanup fails", async () => {
    const state = new ProjectTodoStateManager(WORKSPACE);
    const { logger, entries } = createInMemoryLogger();
    const storage = new ProjectAttachmentStorage({
      removeDirectory: async () => { throw new Error("disk busy"); },
    });
    const service = new ProjectTodoAttachmentService({
      workspaceRoot: WORKSPACE,
      state,
      storage,
      logger,
    });
    const todo = await state.createTodo({ content: "Remove reference" });
    const attachmentId = crypto.randomUUID();
    const uploaded = await service.upload({
      todoId: todo.id,
      attachmentId,
      expectedRevision: todo.revision,
      name: "orphan.txt",
      sizeBytes: 1,
      body: byteStream(Uint8Array.of(1)),
    });

    const removed = await service.remove({
      todoId: todo.id,
      attachmentId,
      expectedRevision: uploaded.todo.revision,
    });
    expect(removed.attachmentIds).toEqual([]);
    expect(await service.list(todo.id)).toEqual({
      todoRevision: removed.revision,
      attachments: [],
    });
    expect(await Bun.file(todoContentPath(todo.id, attachmentId)).exists()).toBe(true);
    expect(entries).toContainEqual(expect.objectContaining({
      level: "warn",
      event: "todos.attachments.cleanup_failed",
      context: { todoId: todo.id, attachmentId },
    }));
  });
});

function todoContentPath(todoId: string, attachmentId: string): string {
  return join(
    WORKSPACE,
    ".archcode",
    "runtime",
    "attachments",
    "todos",
    todoId,
    attachmentId,
    "content",
  );
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
