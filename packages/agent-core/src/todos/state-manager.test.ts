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
    const todo = await manager.createTodo({ title: "  Capture this  " });

    expect(todo).toEqual({
      id: expect.any(String),
      title: "Capture this",
      body: "",
      status: "idea",
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(await new ProjectTodoStateManager(TMP_ROOT).listTodos()).toEqual([todo]);

    const path = projectRuntimePath(TMP_ROOT, "todos", "state.json");
    const raw = await Bun.file(path).json() as { todos: unknown[] };
    expect(raw.todos).toEqual([todo]);
  });

  test("allows free status movement while enforcing rejection and revision invariants", async () => {
    let now = 100;
    const manager = new ProjectTodoStateManager(TMP_ROOT, { now: () => ++now });
    const idea = await manager.createTodo({ title: "Shape it" });

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
      body: "stale",
    })).rejects.toBeInstanceOf(ProjectTodoRevisionConflictError);
    expect((await manager.readTodo(reopened.id)).revision).toBe(reopened.revision);
  });

  test("orders the target within its final lane without touching neighbour revisions", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT);
    const a = await manager.createTodo({ title: "A" });
    const b = await manager.createTodo({ title: "B" });
    const c = await manager.createTodo({ title: "C" });
    const d = await manager.createTodo({ title: "D" });

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

    const wrongLaneAnchor = await manager.createTodo({ title: "Wrong lane" });
    const archiveCandidate = await manager.createTodo({ title: "Archived anchor" });
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
    const first = await manager.createTodo({ title: "First" });
    const second = await manager.createTodo({ title: "Second" });

    const archived = await manager.updateTodo(first.id, {
      expectedRevision: first.revision,
      archived: true,
    });
    expect(archived).toMatchObject({ status: "idea", archivedAt: 100, revision: 2 });
    await expect(manager.updateTodo(first.id, {
      expectedRevision: archived.revision,
      body: "blocked",
    })).rejects.toBeInstanceOf(ProjectTodoArchivedError);
    await expect(manager.updateTodo(second.id, {
      expectedRevision: second.revision,
      archived: false,
    })).rejects.toBeInstanceOf(ProjectTodoInvalidMutationError);
    await expect(manager.updateTodo(second.id, {
      expectedRevision: second.revision,
      archived: true,
      title: "Mixed",
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
    const idea = await manager.createTodo({ title: "Work" });
    await expect(manager.beginWork(idea.id, idea.revision)).rejects.toBeInstanceOf(ProjectTodoSessionStateError);

    const ready = await manager.updateTodo(idea.id, { expectedRevision: idea.revision, status: "ready" });
    const started = await manager.beginWork(ready.id, ready.revision);
    expect(started).toMatchObject({ status: "in_progress", revision: ready.revision + 1 });
    expect(await manager.beginWork(started.id, started.revision)).toEqual(started);
  });
});

function lane(
  todos: Awaited<ReturnType<ProjectTodoStateManager["listTodos"]>>,
  status: "idea" | "ready" | "in_progress" | "done",
): string[] {
  return todos.filter((todo) => todo.status === status && todo.archivedAt === undefined).map((todo) => todo.id);
}
