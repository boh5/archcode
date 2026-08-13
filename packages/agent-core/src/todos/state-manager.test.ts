import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectRuntimePath } from "../projects/runtime-path";
import {
  ProjectTodoArchivedError,
  ProjectTodoInvalidMutationError,
  ProjectTodoRevisionConflictError,
  ProjectTodoSessionStateError,
} from "./errors";
import { ProjectTodoStateManager } from "./state-manager";

const TMP_ROOT = join(tmpdir(), "archcode-todo-state", crypto.randomUUID());

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("ProjectTodoStateManager", () => {
  test("persists only the canonical Todo and reloads its array order", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT, { now: () => 100 });
    const todo = await manager.createTodo({ content: "  Capture this  " });

    expect(todo).toEqual({
      id: expect.any(String),
      content: "Capture this",
      attachmentIds: [],
      status: "idea",
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(await new ProjectTodoStateManager(TMP_ROOT).listTodos()).toEqual([todo]);

    const path = projectRuntimePath(TMP_ROOT, "todos", "state.json");
    const raw = await Bun.file(path).json() as {
      todos: unknown[];
      runNowReceipts: unknown[];
      startDiscussionReceipts: unknown[];
    };
    expect(raw.todos).toEqual([todo]);
    expect(raw.runNowReceipts).toEqual([]);
    expect(raw.startDiscussionReceipts).toEqual([]);
  });

  test("allows free status movement while enforcing rejection and revision invariants", async () => {
    let now = 100;
    const manager = new ProjectTodoStateManager(TMP_ROOT, { now: () => ++now });
    const idea = await manager.createTodo({ content: "Shape it" });

    const done = await manager.updateTodo(idea.id, { expectedRevision: idea.revision, status: "done" });
    const inProgress = await manager.updateTodo(done.id, { expectedRevision: done.revision, status: "in_progress" });
    const ready = await manager.updateTodo(inProgress.id, { expectedRevision: inProgress.revision, status: "ready" });
    expect(ready).toMatchObject({ status: "ready", revision: 4 });

    await expect(manager.updateTodo(ready.id, {
      expectedRevision: ready.revision,
      status: "rejected",
    })).rejects.toBeInstanceOf(ProjectTodoInvalidMutationError);
    expect(await manager.readTodo(ready.id)).toEqual(ready);

    const rejected = await manager.updateTodo(ready.id, {
      expectedRevision: ready.revision,
      status: "rejected",
      rejectionReason: "Not aligned",
    });
    expect(rejected).toMatchObject({ status: "rejected", rejectionReason: "Not aligned", revision: 5 });

    const reopened = await manager.updateTodo(rejected.id, {
      expectedRevision: rejected.revision,
      status: "idea",
    });
    expect(reopened.rejectionReason).toBeUndefined();

    await expect(manager.updateTodo(reopened.id, {
      expectedRevision: rejected.revision,
      content: "stale",
    })).rejects.toBeInstanceOf(ProjectTodoRevisionConflictError);
    expect((await manager.readTodo(reopened.id)).revision).toBe(reopened.revision);
  });

  test("orders the target within its final lane without touching neighbour revisions", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT);
    const a = await manager.createTodo({ content: "A" });
    const b = await manager.createTodo({ content: "B" });
    const c = await manager.createTodo({ content: "C" });
    const d = await manager.createTodo({ content: "D" });

    const readyA = await manager.updateTodo(a.id, { expectedRevision: a.revision, status: "ready" });
    const readyB = await manager.updateTodo(b.id, { expectedRevision: b.revision, status: "ready" });
    const readyC = await manager.updateTodo(c.id, { expectedRevision: c.revision, status: "ready" });
    const doneD = await manager.updateTodo(d.id, { expectedRevision: d.revision, status: "done" });

    const movedC = await manager.updateTodo(c.id, {
      expectedRevision: readyC.revision,
      beforeTodoId: readyA.id,
    });
    expect(lane(await manager.listTodos(), "ready")).toEqual([c.id, a.id, b.id]);

    const appendedA = await manager.updateTodo(a.id, {
      expectedRevision: readyA.revision,
      beforeTodoId: null,
    });
    expect(lane(await manager.listTodos(), "ready")).toEqual([c.id, b.id, a.id]);

    const movedD = await manager.updateTodo(d.id, {
      expectedRevision: doneD.revision,
      status: "ready",
      beforeTodoId: b.id,
    });
    expect(lane(await manager.listTodos(), "ready")).toEqual([c.id, d.id, b.id, a.id]);
    expect((await manager.readTodo(b.id)).revision).toBe(readyB.revision);
    expect(movedC.revision).toBe(readyC.revision + 1);
    expect(appendedA.revision).toBe(readyA.revision + 1);
    expect(movedD.revision).toBe(doneD.revision + 1);

    const wrongLaneAnchor = await manager.createTodo({ content: "Wrong lane" });
    const archiveCandidate = await manager.createTodo({ content: "Archived anchor" });
    const readyArchiveCandidate = await manager.updateTodo(archiveCandidate.id, {
      expectedRevision: archiveCandidate.revision,
      status: "ready",
    });
    const archivedAnchor = await manager.updateTodo(archiveCandidate.id, {
      expectedRevision: readyArchiveCandidate.revision,
      archived: true,
    });
    const beforeInvalid = await manager.listTodos();
    for (const anchor of [b.id, crypto.randomUUID(), wrongLaneAnchor.id, archivedAnchor.id]) {
      await expect(manager.updateTodo(b.id, {
        expectedRevision: readyB.revision,
        beforeTodoId: anchor,
      })).rejects.toBeInstanceOf(ProjectTodoInvalidMutationError);
      expect(await manager.listTodos()).toEqual(beforeInvalid);
    }
  });

  test("keeps archive position and makes archive direction exclusive", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT, { now: () => 100 });
    const first = await manager.createTodo({ content: "First" });
    const second = await manager.createTodo({ content: "Second" });

    const archived = await manager.updateTodo(first.id, {
      expectedRevision: first.revision,
      archived: true,
    });
    expect(archived).toMatchObject({ status: "idea", archivedAt: 100, revision: 2 });
    await expect(manager.updateTodo(first.id, {
      expectedRevision: archived.revision,
      content: "blocked",
    })).rejects.toBeInstanceOf(ProjectTodoArchivedError);
    await expect(manager.updateTodo(second.id, {
      expectedRevision: second.revision,
      archived: false,
    })).rejects.toBeInstanceOf(ProjectTodoInvalidMutationError);
    await expect(manager.updateTodo(second.id, {
      expectedRevision: second.revision,
      archived: true,
      content: "Mixed",
    })).rejects.toThrow("archived cannot be combined");
    expect(await manager.readTodo(second.id)).toEqual(second);

    const restored = await manager.updateTodo(first.id, {
      expectedRevision: archived.revision,
      archived: false,
    });
    expect(restored.archivedAt).toBeUndefined();
    expect((await manager.listTodos()).map((todo) => todo.id)).toEqual([first.id, second.id]);
  });

  test("prepares work only from Ready or In Progress in the serialized state lane", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT);
    const idea = await manager.createTodo({ content: "Work" });
    await expect(manager.beginWork(idea.id, idea.revision)).rejects.toBeInstanceOf(ProjectTodoSessionStateError);

    const ready = await manager.updateTodo(idea.id, { expectedRevision: idea.revision, status: "ready" });
    const started = await manager.beginWork(ready.id, ready.revision);
    expect(started).toMatchObject({ status: "in_progress", revision: ready.revision + 1 });
    expect(await manager.beginWork(started.id, started.revision)).toEqual(started);
  });

  test("persists run-now receipts and supports scoped compensation deletion", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT);
    const clientRequestId = crypto.randomUUID();
    const { todo, receipt } = await manager.beginRunNow({
      content: "Run now",
      clientRequestId,
      requestHash: "a".repeat(64),
    });

    expect(todo.status).toBe("in_progress");
    expect(receipt).toMatchObject({ status: "preparing", sessionId: expect.any(String) });
    expect(await manager.listTodos()).toEqual([]);
    expect(await manager.completeRunNow(clientRequestId)).toMatchObject({
      status: "accepted",
      sessionId: receipt.sessionId,
    });
    expect(await new ProjectTodoStateManager(TMP_ROOT).readRunNowReceipt(clientRequestId))
      .toMatchObject({ status: "accepted", sessionId: receipt.sessionId });
    expect(await manager.listTodos()).toEqual([todo]);

    const compensationId = crypto.randomUUID();
    const { todo: compensated } = await manager.beginRunNow({
      content: "Compensate",
      clientRequestId: compensationId,
      requestHash: "b".repeat(64),
    });
    await manager.deletePendingRunNow(compensationId, compensated.id);
    expect((await manager.listTodos()).map((item) => item.id)).toEqual([todo.id]);
  });

  test("persists start-discussion identity and replays the exact Todo and Session reservation", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT);
    const clientRequestId = crypto.randomUUID();
    const { todo, receipt } = await manager.beginStartDiscussion({
      content: "Discuss this",
      clientRequestId,
      requestHash: "c".repeat(64),
    });

    expect(todo).toMatchObject({ status: "idea", revision: 1 });
    expect(receipt).toMatchObject({
      clientRequestId,
      todoId: todo.id,
      sessionId: expect.any(String),
      status: "preparing",
    });
    expect(await manager.listTodos()).toEqual([]);

    const restarted = new ProjectTodoStateManager(TMP_ROOT);
    expect(await restarted.readStartDiscussionReceipt(clientRequestId)).toEqual(receipt);
    expect(await restarted.readStartDiscussionTodo(clientRequestId)).toEqual(todo);
    expect(await restarted.completeStartDiscussion(clientRequestId)).toMatchObject({
      status: "accepted",
      sessionId: receipt.sessionId,
    });
    expect(await restarted.listTodos()).toEqual([todo]);

    const compensationId = crypto.randomUUID();
    const { todo: compensated } = await restarted.beginStartDiscussion({
      content: "Compensate discussion",
      clientRequestId: compensationId,
      requestHash: "d".repeat(64),
    });
    await restarted.deletePendingStartDiscussion(compensationId, compensated.id);
    expect((await restarted.listTodos()).map((item) => item.id)).toEqual([todo.id]);
  });

  test("owns ordered attachment references behind revision-safe narrow mutations", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT, { now: () => 100 });
    let todo = await manager.createTodo({ content: "Reference files" });
    const attachmentIds = Array.from({ length: 10 }, () => crypto.randomUUID());

    for (const attachmentId of attachmentIds) {
      todo = await manager.addAttachmentReference(todo.id, attachmentId, todo.revision);
    }
    expect(todo.attachmentIds).toEqual(attachmentIds);
    expect(todo.revision).toBe(11);
    await expect(manager.addAttachmentReference(
      todo.id,
      crypto.randomUUID(),
      todo.revision,
    )).rejects.toBeInstanceOf(ProjectTodoInvalidMutationError);
    await expect(manager.removeAttachmentReference(
      todo.id,
      attachmentIds[0]!,
      todo.revision - 1,
    )).rejects.toBeInstanceOf(ProjectTodoRevisionConflictError);

    const removed = await manager.removeAttachmentReference(
      todo.id,
      attachmentIds[0]!,
      todo.revision,
    );
    expect(removed.attachmentIds).toEqual(attachmentIds.slice(1));
    expect(removed.revision).toBe(12);
  });
});

function lane(
  todos: Awaited<ReturnType<ProjectTodoStateManager["listTodos"]>>,
  status: "idea" | "ready" | "in_progress" | "done",
): string[] {
  return todos.filter((todo) => todo.status === status && todo.archivedAt === undefined).map((todo) => todo.id);
}
