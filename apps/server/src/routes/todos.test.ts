import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type {
  AttachmentDescriptor,
  CreateProjectTodoSessionInput,
  ProjectTodo,
  ProjectTodoCreateInput,
  ProjectTodoRunNowInput,
  ProjectTodoStartDiscussionInput,
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
      body: JSON.stringify({ content: "New idea\n\nDetails" }),
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
    expect(fixture.createTodo).toHaveBeenCalledWith({ content: "New idea\n\nDetails" });
    expect(update.status).toBe(200);
    expect(fixture.updateTodo).toHaveBeenCalledWith(todo.id, {
      expectedRevision: 1,
      status: "in_progress",
      beforeTodoId: null,
    });
  });

  test("serves Todo reference mutations and safe inline/download dispositions", async () => {
    const todo = makeTodo();
    const fixture = createFixture(todo);
    const attachmentId = crypto.randomUUID();
    const base = `/api/projects/${fixture.project.slug}/todos/${todo.id}/attachments`;
    const bytes = new TextEncoder().encode("%PDF-1.7 fixture");

    const list = await fixture.app.request(base);
    expect(await list.json()).toEqual({ todoRevision: todo.revision, attachments: [] });

    const upload = await fixture.app.request(
      `${base}/${attachmentId}?name=brief.pdf&sizeBytes=${bytes.byteLength}&expectedRevision=${todo.revision}`,
      {
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        body: bytes,
      },
    );
    expect(upload.status).toBe(200);
    expect(fixture.uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({
      todoId: todo.id,
      attachmentId,
      expectedRevision: todo.revision,
      name: "brief.pdf",
      sizeBytes: bytes.byteLength,
    }));

    const contentPath = join(workspaceRoot, "opened-content");
    await writeFile(contentPath, bytes);
    fixture.openAttachment.mockResolvedValue({
      descriptor: {
        id: attachmentId,
        name: "brief.pdf",
        mediaType: "application/pdf",
        sizeBytes: bytes.byteLength,
        kind: "file",
      },
      contentPath,
    });
    const opened = await fixture.app.request(`${base}/${attachmentId}`);
    expect(opened.headers.get("content-disposition")).toStartWith("inline;");
    expect(opened.headers.get("x-content-type-options")).toBe("nosniff");

    fixture.openAttachment.mockResolvedValue({
      descriptor: {
        id: attachmentId,
        name: "unsafe.html",
        mediaType: "text/html",
        sizeBytes: bytes.byteLength,
        kind: "file",
      },
      contentPath,
    });
    const downloaded = await fixture.app.request(`${base}/${attachmentId}`);
    expect(downloaded.headers.get("content-disposition")).toStartWith("attachment;");

    const removed = await fixture.app.request(`${base}/${attachmentId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: todo.revision + 1 }),
    });
    expect(removed.status).toBe(200);
    expect(fixture.removeAttachment).toHaveBeenCalledWith({
      todoId: todo.id,
      attachmentId,
      expectedRevision: todo.revision + 1,
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

  test("runs a captured Todo through the single backend-owned command", async () => {
    const todo = makeTodo({ status: "in_progress" });
    const fixture = createFixture(todo);
    const input: ProjectTodoRunNowInput = {
      clientRequestId: crypto.randomUUID(),
      content: "Start now\n\nImplement it.",
    };

    const response = await fixture.app.request(`/api/projects/${fixture.project.slug}/todos/run-now`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      todo,
      session: { sessionId: "11111111-1111-4111-8111-111111111111", source: { kind: "todo", todoId: todo.id, entry: "work" } },
    });
    expect(fixture.runNow).toHaveBeenCalledWith(input);
  });

  test("starts a captured Discussion through the single backend-owned command", async () => {
    const todo = makeTodo();
    const fixture = createFixture(todo);
    const input: ProjectTodoStartDiscussionInput = {
      clientRequestId: crypto.randomUUID(),
      content: "Discuss now\n\nShape it.",
    };

    const response = await fixture.app.request(
      `/api/projects/${fixture.project.slug}/todos/start-discussion`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      todo,
      session: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        agentName: "discussion",
        source: { kind: "todo", todoId: todo.id, entry: "discussion" },
      },
    });
    expect(fixture.startDiscussion).toHaveBeenCalledWith(input);
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
      body: JSON.stringify({ expectedRevision: 1, archived: true, content: "Mixed" }),
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
    const invalidRunNow = await fixture.app.request(`${base}/run-now`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientRequestId: crypto.randomUUID(), content: "Start", origin: "forged" }),
    });
    const invalidStartDiscussion = await fixture.app.request(`${base}/start-discussion`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientRequestId: crypto.randomUUID(),
        content: "Discuss",
        expectedRevision: 1,
      }),
    });

    expect(emptyMutation.status).toBe(400);
    expect(mixedArchive.status).toBe(400);
    expect(invalidEntry.status).toBe(400);
    expect(invalidPlanIntent.status).toBe(400);
    expect(invalidRunNow.status).toBe(400);
    expect(invalidStartDiscussion.status).toBe(400);
    expect(fixture.runNow).not.toHaveBeenCalled();
    expect(fixture.startDiscussion).not.toHaveBeenCalled();
  });

  test("maps Run now key conflicts and recovery-required failures", async () => {
    const fixture = createFixture(makeTodo());
    const path = `/api/projects/${fixture.project.slug}/todos/run-now`;
    const clientRequestId = crypto.randomUUID();
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId, content: "Start" }),
    };
    fixture.runNow.mockRejectedValueOnce(Object.assign(new Error("different input"), {
      code: "PROJECT_TODO_RUN_NOW_CONFLICT",
      clientRequestId,
    }));
    const conflict = await fixture.app.request(path, request);
    fixture.runNow.mockRejectedValueOnce(Object.assign(new Error("manual recovery"), {
      code: "PROJECT_TODO_RUN_NOW_RECOVERY_REQUIRED",
      todoId: fixture.todo.id,
      sessionId: "11111111-1111-4111-8111-111111111111",
    }));
    const recovery = await fixture.app.request(path, request);

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "BAD_REQUEST", details: { scopeCode: "PROJECT_TODO_RUN_NOW_CONFLICT", clientRequestId } },
    });
    expect(recovery.status).toBe(500);
    expect(await recovery.json()).toMatchObject({
      error: { code: "INTERNAL_ERROR", details: { scopeCode: "PROJECT_TODO_RUN_NOW_RECOVERY_REQUIRED", todoId: fixture.todo.id } },
    });
  });

  test("maps Start discussion key conflicts and recovery-required failures with exact ids", async () => {
    const fixture = createFixture(makeTodo());
    const path = `/api/projects/${fixture.project.slug}/todos/start-discussion`;
    const clientRequestId = crypto.randomUUID();
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId, content: "Discuss" }),
    };
    fixture.startDiscussion.mockRejectedValueOnce(Object.assign(new Error("different input"), {
      code: "PROJECT_TODO_START_DISCUSSION_CONFLICT",
      clientRequestId,
    }));
    const conflict = await fixture.app.request(path, request);
    fixture.startDiscussion.mockRejectedValueOnce(Object.assign(new Error("manual recovery"), {
      code: "PROJECT_TODO_START_DISCUSSION_RECOVERY_REQUIRED",
      todoId: fixture.todo.id,
      sessionId: "11111111-1111-4111-8111-111111111111",
    }));
    const recovery = await fixture.app.request(path, request);

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        details: {
          scopeCode: "PROJECT_TODO_START_DISCUSSION_CONFLICT",
          clientRequestId,
        },
      },
    });
    expect(recovery.status).toBe(500);
    expect(await recovery.json()).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        details: {
          scopeCode: "PROJECT_TODO_START_DISCUSSION_RECOVERY_REQUIRED",
          todoId: fixture.todo.id,
          sessionId: "11111111-1111-4111-8111-111111111111",
        },
      },
    });
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
      body: JSON.stringify({ expectedRevision: 1, content: "Change" }),
    });
    fixture.updateTodo.mockRejectedValueOnce(Object.assign(new Error("stale"), {
      code: "PROJECT_TODO_REVISION_CONFLICT",
      todoId: fixture.todo.id,
    }));
    const conflict = await fixture.app.request(base, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, content: "Change" }),
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

  test("reads the fixed bounded Todo Plan and returns null when it is absent", async () => {
    const todo = makeTodo();
    const fixture = createFixture(todo);
    const planDirectory = join(workspaceRoot, ".archcode", "plans");
    await mkdir(planDirectory, { recursive: true });
    const planPath = join(planDirectory, `${todo.id}.md`);
    await writeFile(planPath, "# Plan\n\nShip it.\n");

    const response = await fixture.app.request(`/api/projects/${fixture.project.slug}/todos/${todo.id}/plan`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      plan: {
        path: `.archcode/plans/${todo.id}.md`,
        markdown: "# Plan\n\nShip it.\n",
        updatedAt: expect.any(Number),
      },
    });

    await rm(planPath);
    const missing = await fixture.app.request(`/api/projects/${fixture.project.slug}/todos/${todo.id}/plan`);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ plan: null });
  });

  test("rejects a Todo Plan symlink instead of reading outside the fixed path", async () => {
    const todo = makeTodo();
    const fixture = createFixture(todo);
    const planDirectory = join(workspaceRoot, ".archcode", "plans");
    const outsidePath = join(workspaceRoot, "outside.md");
    await mkdir(planDirectory, { recursive: true });
    await writeFile(outsidePath, "outside");
    await symlink(outsidePath, join(planDirectory, `${todo.id}.md`));

    const response = await fixture.app.request(`/api/projects/${fixture.project.slug}/todos/${todo.id}/plan`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "BAD_REQUEST", details: { scopeCode: "TODO_PLAN_UNSAFE_PATH" } },
    });
  });

  test("rejects a Todo Plan larger than the bounded read limit", async () => {
    const todo = makeTodo();
    const fixture = createFixture(todo);
    const planDirectory = join(workspaceRoot, ".archcode", "plans");
    const planPath = join(planDirectory, `${todo.id}.md`);
    await mkdir(planDirectory, { recursive: true });
    await writeFile(planPath, "");
    await truncate(planPath, 1024 * 1024 + 1);

    const response = await fixture.app.request(`/api/projects/${fixture.project.slug}/todos/${todo.id}/plan`);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "BAD_REQUEST", details: { scopeCode: "TODO_PLAN_TOO_LARGE" } },
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
    readTodo: mock(async (todoId: string) => {
      if (todoId !== todo.id) throw Object.assign(new Error("missing"), { code: "PROJECT_TODO_NOT_FOUND", todoId });
      return todo;
    }),
    createTodo: mock(async (input: ProjectTodoCreateInput) => ({ ...todo, ...input })),
    updateTodo: mock(async (_todoId: string, _input: ProjectTodoUpdateInput) => todo),
    listAttachments: mock(async () => ({ todoRevision: todo.revision, attachments: [] })),
    uploadAttachment: mock(async (input) => ({
      todo: { ...todo, revision: todo.revision + 1, attachmentIds: [...todo.attachmentIds, input.attachmentId] },
      attachment: {
        id: input.attachmentId,
        name: input.name,
        mediaType: input.mediaType ?? "application/octet-stream",
        sizeBytes: input.sizeBytes,
        kind: "file" as const,
      },
    })),
    openAttachment: mock(async (): Promise<{
      readonly descriptor: AttachmentDescriptor;
      readonly contentPath: string;
    }> => {
      throw new Error("not configured");
    }),
    removeAttachment: mock(async () => todo),
    createSession: mock(async (_todoId: string, _input: CreateProjectTodoSessionInput) => ({
      todo,
      sessionId: "11111111-1111-4111-8111-111111111111",
    })),
    runNow: mock(async (_input: ProjectTodoRunNowInput) => ({
      todo,
      session: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        cwd: workspaceRoot,
        rootSessionId: "11111111-1111-4111-8111-111111111111",
        agentName: "lead" as const,
        profile: "principal" as const,
        activeSkillNames: [],
        modelSelection: { revision: 0 },
        title: "Capture an idea",
        source: { kind: "todo" as const, todoId: todo.id, entry: "work" as const },
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
      },
    })),
    startDiscussion: mock(async (_input: ProjectTodoStartDiscussionInput) => ({
      todo,
      session: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        cwd: workspaceRoot,
        rootSessionId: "11111111-1111-4111-8111-111111111111",
        agentName: "discussion" as const,
        profile: "principal" as const,
        activeSkillNames: [],
        modelSelection: { revision: 0 },
        title: "Discussion: Capture an idea",
        source: { kind: "todo" as const, todoId: todo.id, entry: "discussion" as const },
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
      },
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
    content: "Capture an idea\n\nExplore the idea.",
    attachmentIds: [],
    status: "idea",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
