import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type {
  CreateProjectTodoSessionInput,
  ProjectTodo,
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
  test("lists, creates, and flat-updates Project Todos", async () => {
    const todo = makeTodo();
    const fixture = createFixture(todo);
    const base = `/api/projects/${fixture.project.slug}/todos`;

    const list = await fixture.app.request(base);
    const create = await fixture.app.request(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New idea", body: "Details" }),
    });
    const update = await fixture.app.request(`${base}/${todo.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        status: "in_progress",
        beforeTodoId: null,
      }),
    });

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ todos: [todo] });
    expect(create.status).toBe(201);
    expect(fixture.createTodo).toHaveBeenCalledWith({ title: "New idea", body: "Details" });
    expect(update.status).toBe(200);
    expect(fixture.updateTodo).toHaveBeenCalledWith(todo.id, {
      expectedRevision: 1,
      status: "in_progress",
      beforeTodoId: null,
    });
  });

  test("creates each Todo Session entry through one backend-owned endpoint", async () => {
    const todo = makeTodo({ status: "ready" });
    const fixture = createFixture(todo);
    const base = `/api/projects/${fixture.project.slug}/todos/${todo.id}/sessions`;

    for (const entry of ["discussion", "work", "automation"] as const) {
      const response = await fixture.app.request(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1, entry }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        todo,
        sessionId: "11111111-1111-4111-8111-111111111111",
      });
      expect(fixture.createSession).toHaveBeenCalledWith(todo.id, {
        expectedRevision: 1,
        entry,
      });
    }

    const planDiscussion = await fixture.app.request(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        entry: "discussion",
        initialIntent: "plan",
      }),
    });
    expect(planDiscussion.status).toBe(201);
    expect(fixture.createSession).toHaveBeenLastCalledWith(todo.id, {
      expectedRevision: 1,
      entry: "discussion",
      initialIntent: "plan",
    });
  });

  test("strictly validates flat mutation and Session request bodies", async () => {
    const fixture = createFixture(makeTodo());
    const base = `/api/projects/${fixture.project.slug}/todos`;
    const headers = { "content-type": "application/json" };

    const emptyMutation = await fixture.app.request(`${base}/${fixture.todo.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    const mixedArchive = await fixture.app.request(`${base}/${fixture.todo.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ expectedRevision: 1, archived: true, title: "Mixed" }),
    });
    const invalidEntry = await fixture.app.request(`${base}/${fixture.todo.id}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 1, entry: "invalid" }),
    });
    const invalidPlanIntent = await fixture.app.request(`${base}/${fixture.todo.id}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedRevision: 1,
        entry: "work",
        initialIntent: "plan",
      }),
    });

    expect(emptyMutation.status).toBe(400);
    expect(mixedArchive.status).toBe(400);
    expect(invalidEntry.status).toBe(400);
    expect(invalidPlanIntent.status).toBe(400);
  });

  test("maps not-found and current-domain conflicts", async () => {
    const fixture = createFixture(makeTodo());
    const base = `/api/projects/${fixture.project.slug}/todos/${fixture.todo.id}`;
    fixture.updateTodo.mockRejectedValueOnce(Object.assign(new Error("missing"), {
      code: "PROJECT_TODO_NOT_FOUND",
      todoId: fixture.todo.id,
    }));
    const missing = await fixture.app.request(base, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, body: "Change" }),
    });
    fixture.updateTodo.mockRejectedValueOnce(Object.assign(new Error("stale"), {
      code: "PROJECT_TODO_REVISION_CONFLICT",
      todoId: fixture.todo.id,
    }));
    const conflict = await fixture.app.request(base, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, body: "Change" }),
    });

    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "PROJECT_TODO_NOT_FOUND", message: "missing" },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "PROJECT_TODO_REVISION_CONFLICT", message: "stale" },
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
    createTodo: mock(async (input: ProjectTodoCreateInput) => ({ ...todo, ...input })),
    updateTodo: mock(async (_todoId: string, _input: ProjectTodoUpdateInput) => todo),
    createSession: mock(async (_todoId: string, _input: CreateProjectTodoSessionInput) => ({
      todo,
      sessionId: "11111111-1111-4111-8111-111111111111",
    })),
  } satisfies ProjectTodoServiceLike;
  const runtime = {
    projectRegistry: { get: mock(async (slug: string) => slug === project.slug ? project : undefined) },
    contextResolver: { resolve: mock(async () => ({ todos: service })) },
  } as unknown as AgentRuntime;
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/projects", createTodosRoutes(runtime));
  return { app, project, todo, ...service };
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
