import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  ProjectTodoActivationConflictError,
  ProjectTodoInvalidTransitionError,
  ProjectTodoRevisionConflictError,
} from "./errors";
import { ProjectTodoStateManager } from "./state-manager";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "state-manager", crypto.randomUUID());

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("ProjectTodoStateManager", () => {
  test("persists a strict project-owned Todo and reloads it", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT, { now: () => 100 });
    const todo = await manager.createTodo({ title: "  Capture this  " });

    expect(todo).toMatchObject({
      title: "Capture this",
      body: "",
      status: "idea",
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
    });
    const reloaded = new ProjectTodoStateManager(TMP_ROOT);
    expect(await reloaded.readTodo(todo.id)).toEqual(todo);

    const path = join(TMP_ROOT, ".archcode", "todos", "state.json");
    const raw = await Bun.file(path).json() as { todos: Array<Record<string, unknown>> };
    raw.todos[0]!.closed = true;
    await Bun.write(path, JSON.stringify(raw));
    await expect(new ProjectTodoStateManager(TMP_ROOT).listTodos()).rejects.toThrow();
  });

  test("enforces the exact transition graph, rejection reason, and revision conflicts", async () => {
    let now = 100;
    const manager = new ProjectTodoStateManager(TMP_ROOT, { now: () => ++now });
    const idea = await manager.createTodo({ title: "Shape it" });

    await expect(manager.updateTodo(idea.id, {
      expectedRevision: idea.revision,
      patch: { status: "done" },
    })).rejects.toBeInstanceOf(ProjectTodoInvalidTransitionError);
    const unchanged = await manager.readTodo(idea.id);
    expect(unchanged.revision).toBe(1);

    await expect(manager.updateTodo(idea.id, {
      expectedRevision: idea.revision,
      patch: { status: "rejected" },
    })).rejects.toThrow("requires a rejection reason");

    await expect(manager.updateTodo(idea.id, {
      expectedRevision: idea.revision,
      patch: { status: "idea", rejectionReason: "Not applicable" },
    })).rejects.toThrow("only valid for rejected status");
    expect((await manager.readTodo(idea.id)).revision).toBe(idea.revision);

    const rejected = await manager.updateTodo(idea.id, {
      expectedRevision: idea.revision,
      patch: { status: "rejected", rejectionReason: "Not aligned" },
    });
    expect(rejected).toMatchObject({ status: "rejected", rejectionReason: "Not aligned", revision: 2 });

    await expect(manager.updateTodo(idea.id, {
      expectedRevision: 1,
      patch: { body: "stale" },
    })).rejects.toBeInstanceOf(ProjectTodoRevisionConflictError);
    expect((await manager.readTodo(idea.id)).revision).toBe(2);

    const restoredIdea = await manager.updateTodo(idea.id, {
      expectedRevision: rejected.revision,
      patch: { status: "idea" },
    });
    expect(restoredIdea.rejectionReason).toBeUndefined();
    expect(restoredIdea.revision).toBe(3);
  });

  test("keeps active Activation gates and only done to ready clears the result link", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT);
    const idea = await manager.createTodo({ title: "Build it" });
    const ready = await manager.updateTodo(idea.id, { expectedRevision: idea.revision, patch: { status: "ready" } });
    const active = await manager.checkpointActivation(ready.id, ready.revision, "session", crypto.randomUUID());

    await expect(manager.updateTodo(active.id, {
      expectedRevision: active.revision,
      patch: { status: "ready" },
    })).resolves.toMatchObject({ activation: active.activation, revision: active.revision + 1 });
    const stillActive = await manager.readTodo(active.id);
    expect(stillActive.activation).toEqual(active.activation);

    await expect(manager.checkpointActivation(
      stillActive.id,
      stillActive.revision,
      "session",
      crypto.randomUUID(),
    )).rejects.toBeInstanceOf(ProjectTodoActivationConflictError);
    await expect(manager.checkpointActivation(
      stillActive.id,
      active.activation!.todoRevision,
      "session",
      crypto.randomUUID(),
    )).resolves.toEqual(stillActive);

    await expect(manager.updateTodo(active.id, {
      expectedRevision: stillActive.revision,
      patch: { status: "idea" },
    })).rejects.toBeInstanceOf(ProjectTodoActivationConflictError);
    await expect(manager.archiveTodo(active.id, stillActive.revision)).rejects.toBeInstanceOf(ProjectTodoActivationConflictError);

    const done = await manager.updateTodo(active.id, {
      expectedRevision: stillActive.revision,
      patch: { status: "done" },
    });
    expect(done.activation).toEqual(active.activation);
    await expect(manager.checkpointActivation(
      done.id,
      done.activation!.todoRevision,
      "session",
      crypto.randomUUID(),
    )).rejects.toBeInstanceOf(ProjectTodoActivationConflictError);
    const archived = await manager.archiveTodo(done.id, done.revision);
    expect(archived.status).toBe("done");
    const restored = await manager.restoreTodo(done.id, archived.revision);
    const reopened = await manager.updateTodo(done.id, {
      expectedRevision: restored.revision,
      patch: { status: "ready" },
    });
    expect(reopened.activation).toBeUndefined();
  });

  test("checkpoints and same-resource binding are true idempotent no-ops", async () => {
    const committed: number[] = [];
    const manager = new ProjectTodoStateManager(TMP_ROOT, {
      onCommitted: (todo) => { committed.push(todo.revision); },
    });
    const idea = await manager.createTodo({ title: "Recover" });
    const sessionId = crypto.randomUUID();
    const discussion = await manager.checkpointDiscussion(idea.id, idea.revision, sessionId);
    const repeated = await manager.checkpointDiscussion(idea.id, idea.revision, crypto.randomUUID());
    expect(repeated).toEqual(discussion);

    const ready = await manager.updateTodo(idea.id, { expectedRevision: discussion.revision, patch: { status: "ready" } });
    const sourceSessionId = crypto.randomUUID();
    const active = await manager.checkpointActivation(idea.id, ready.revision, "automation", sourceSessionId);
    const retried = await manager.checkpointActivation(idea.id, ready.revision, "automation", crypto.randomUUID());
    expect(retried).toEqual(active);

    const resourceId = crypto.randomUUID();
    const bound = await manager.bindActivationResource(idea.id, sourceSessionId, resourceId);
    const rebound = await manager.bindActivationResource(idea.id, sourceSessionId, resourceId);
    expect(rebound).toEqual(bound);
    await Bun.sleep(0);
    expect(committed).toEqual([1, 2, 3, 4, 5]);
  });

  test("reports both Discussion and retained Activation Session owners", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT);
    const idea = await manager.createTodo({ title: "Owned" });
    const discussionSessionId = crypto.randomUUID();
    const discussed = await manager.checkpointDiscussion(idea.id, idea.revision, discussionSessionId);
    const ready = await manager.updateTodo(idea.id, { expectedRevision: discussed.revision, patch: { status: "ready" } });
    const sourceSessionId = crypto.randomUUID();
    const active = await manager.checkpointActivation(idea.id, ready.revision, "session", sourceSessionId);

    expect(await manager.findSessionOwners([discussionSessionId, sourceSessionId])).toEqual([
      { sessionId: discussionSessionId, ownerType: "project_todo" as const, ownerId: idea.id },
      { sessionId: sourceSessionId, ownerType: "project_todo" as const, ownerId: idea.id },
    ].sort((left, right) => left.sessionId.localeCompare(right.sessionId)));

    const cleared = await manager.clearActivation(idea.id, active.revision, sourceSessionId);
    expect(cleared.status).toBe("ready");
    expect(await manager.findSessionOwners([discussionSessionId, sourceSessionId])).toEqual([
      { sessionId: discussionSessionId, ownerType: "project_todo", ownerId: idea.id },
    ]);
  });

  test("observer failure cannot turn a durable mutation into an API failure", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT, {
      onCommitted: () => { throw new Error("observer unavailable"); },
    });
    const todo = await manager.createTodo({ title: "Durable" });
    expect(await manager.readTodo(todo.id)).toEqual(todo);
    expect(await new ProjectTodoStateManager(TMP_ROOT).readTodo(todo.id)).toEqual(todo);
  });

  test("rejects persisted reuse across the combined Todo-owned Session namespace", async () => {
    const manager = new ProjectTodoStateManager(TMP_ROOT);
    const discussionTodo = await manager.createTodo({ title: "Discussion owner" });
    const sharedSessionId = crypto.randomUUID();
    await manager.checkpointDiscussion(discussionTodo.id, discussionTodo.revision, sharedSessionId);
    const activationTodo = await manager.createTodo({ title: "Activation owner" });
    const ready = await manager.updateTodo(activationTodo.id, {
      expectedRevision: activationTodo.revision,
      patch: { status: "ready" },
    });
    const active = await manager.checkpointActivation(ready.id, ready.revision, "session", crypto.randomUUID());

    const path = join(TMP_ROOT, ".archcode", "todos", "state.json");
    const raw = await Bun.file(path).json() as {
      todos: Array<{ id?: string; activation?: { sourceSessionId: string; resourceId?: string } }>;
    };
    const persistedActivation = raw.todos.find((todo) => todo.id === active.id)?.activation;
    if (persistedActivation === undefined) throw new Error("Missing persisted Activation");
    persistedActivation.sourceSessionId = sharedSessionId;
    persistedActivation.resourceId = sharedSessionId;
    await Bun.write(path, JSON.stringify(raw));

    await expect(new ProjectTodoStateManager(TMP_ROOT).listTodos()).rejects.toThrow("Todo-owned Session must be unique");
  });
});
