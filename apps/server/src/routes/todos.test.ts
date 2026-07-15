import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type {
  ProjectTodo,
  ProjectTodoActivateInput,
  ProjectTodoCreateInput,
  ProjectTodoUpdateInput,
} from "@archcode/protocol";
import type { AgentRuntime } from "@archcode/agent-core";

import { errorHandler } from "../error-handler";
import { createTodosRoutes, type ProjectTodoServiceLike } from "./todos";

const roots: string[] = [];
let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "archcode-todos-route-"));
  roots.push(workspaceRoot);
});

afterAll(async () => {
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("Project Todo routes", () => {
  test("lists, creates, reads, and updates Project Todos", async () => {
    const todo = makeTodo();
    const fixture = createFixture(todo);
    const base = `/api/projects/${fixture.project.slug}/todos`;

    const list = await fixture.app.request(base);
    const create = await fixture.app.request(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New idea", body: "Details" }),
    });
    const read = await fixture.app.request(`${base}/${todo.id}`);
    const update = await fixture.app.request(`${base}/${todo.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, patch: { status: "ready" } }),
    });

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ todos: [todo] });
    expect(create.status).toBe(201);
    expect(fixture.createTodo).toHaveBeenCalledWith({ title: "New idea", body: "Details" });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ todo });
    expect(update.status).toBe(200);
    expect(fixture.updateTodo).toHaveBeenCalledWith(todo.id, {
      expectedRevision: 1,
      patch: { status: "ready" },
    });
  });

  test("routes lifecycle actions and returns the bound Session ID", async () => {
    const todo = makeTodo();
    const fixture = createFixture(todo);
    const base = `/api/projects/${fixture.project.slug}/todos/${todo.id}`;
    const headers = { "content-type": "application/json" };

    const archive = await fixture.app.request(`${base}/archive`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    const restore = await fixture.app.request(`${base}/restore`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    const discuss = await fixture.app.request(`${base}/discuss`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 3 }),
    });
    const activate = await fixture.app.request(`${base}/activate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 4, kind: "session" }),
    });
    const returnToReady = await fixture.app.request(`${base}/return-to-ready`, { method: "POST" });

    expect(archive.status).toBe(200);
    expect(fixture.archiveTodo).toHaveBeenCalledWith(todo.id, 1);
    expect(restore.status).toBe(200);
    expect(fixture.restoreTodo).toHaveBeenCalledWith(todo.id, 2);
    expect(discuss.status).toBe(200);
    expect(await discuss.json()).toMatchObject({ sessionId: "11111111-1111-4111-8111-111111111111" });
    expect(fixture.discussTodo).toHaveBeenCalledWith(todo.id, 3);
    expect(activate.status).toBe(200);
    expect(await activate.json()).toMatchObject({ sessionId: "22222222-2222-4222-8222-222222222222" });
    expect(fixture.activateTodo).toHaveBeenCalledWith(todo.id, { expectedRevision: 4, kind: "session" });
    expect(returnToReady.status).toBe(400);

    const validReturnToReady = await fixture.app.request(`${base}/return-to-ready`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 5 }),
    });
    expect(validReturnToReady.status).toBe(200);
    expect(fixture.returnToReady).toHaveBeenCalledWith(todo.id, 5);
  });

  test("strictly validates body and IDs", async () => {
    const fixture = createFixture(makeTodo());
    const base = `/api/projects/${fixture.project.slug}/todos`;
    const headers = { "content-type": "application/json" };

    const invalidId = await fixture.app.request(`${base}/not-a-uuid`);
    const unknownField = await fixture.app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Idea", extra: true }),
    });
    const invalidReturnBody = await fixture.app.request(`${base}/${fixture.todo.id}/return-to-ready`, {
      method: "POST",
      headers,
      body: JSON.stringify({ unexpected: true }),
    });

    expect(invalidId.status).toBe(400);
    expect(unknownField.status).toBe(400);
    expect(invalidReturnBody.status).toBe(400);
  });

  test("maps domain not-found and conflict errors", async () => {
    const fixture = createFixture(makeTodo());
    const base = `/api/projects/${fixture.project.slug}/todos/${fixture.todo.id}`;
    fixture.archiveTodo.mockRejectedValueOnce(Object.assign(new Error("missing"), {
      code: "PROJECT_TODO_NOT_FOUND",
      todoId: fixture.todo.id,
    }));
    const missing = await fixture.app.request(`${base}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    fixture.archiveTodo.mockRejectedValueOnce(Object.assign(new Error("stale"), {
      code: "PROJECT_TODO_REVISION_CONFLICT",
      todoId: fixture.todo.id,
    }));
    const conflict = await fixture.app.request(`${base}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    });

    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: {
        code: "PROJECT_TODO_NOT_FOUND",
        message: "missing",
      },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: {
        code: "PROJECT_TODO_REVISION_CONFLICT",
        message: "stale",
      },
    });
  });
});

function createFixture(todo: ProjectTodo) {
  const project = {
    slug: "test-project",
    name: "Test Project",
    workspaceRoot,
    addedAt: new Date().toISOString(),
  };
  const service = {
    listTodos: mock(async () => [todo]),
    readTodo: mock(async () => todo),
    createTodo: mock(async (input: ProjectTodoCreateInput) => ({ ...todo, ...input })),
    updateTodo: mock(async (_todoId: string, _input: ProjectTodoUpdateInput) => todo),
    archiveTodo: mock(async () => todo),
    restoreTodo: mock(async () => todo),
    discussTodo: mock(async () => ({ ...todo, discussionSessionId: "11111111-1111-4111-8111-111111111111" })),
    activateTodo: mock(async (_todoId: string, _input: ProjectTodoActivateInput) => ({
      ...todo,
      activation: {
        kind: "session" as const,
        sourceSessionId: "22222222-2222-4222-8222-222222222222",
        todoRevision: todo.revision,
        snapshot: { title: todo.title, body: todo.body },
        resourceId: "22222222-2222-4222-8222-222222222222",
      },
    })),
    returnToReady: mock(async () => todo),
  } satisfies ProjectTodoServiceLike;
  const runtime = {
    projectRegistry: { get: mock(async (slug: string) => slug === project.slug ? project : undefined) },
    contextResolver: { resolve: mock(async () => ({ todos: service })) },
  } as unknown as AgentRuntime;
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/projects", createTodosRoutes(runtime));
  return {
    app,
    project,
    todo,
    ...service,
  };
}

function makeTodo(overrides: Partial<ProjectTodo> = {}): ProjectTodo {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "Capture an idea",
    body: "Explore the idea.",
    status: "idea",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
