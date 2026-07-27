import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProjectTodoDiscussionAuthorizationError,
  ProjectTodoRevisionConflictError,
  ProjectTodoSessionStateError,
} from "./errors";
import {
  ProjectTodoService,
  type ProjectTodoSessionCapability,
} from "./service";
import { ProjectTodoStateManager } from "./state-manager";

const TMP_ROOT = join(tmpdir(), "archcode-todo-service", crypto.randomUUID());

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

class FakeSessions implements ProjectTodoSessionCapability {
  readonly sessions = new Map<string, Parameters<ProjectTodoSessionCapability["createRootSession"]>[0]>();
  readonly messages = new Map<string, Parameters<ProjectTodoSessionCapability["acceptMessage"]>[0]>();
  failCreate = 0;
  failAccept = 0;

  async createRootSession(input: Parameters<ProjectTodoSessionCapability["createRootSession"]>[0]) {
    if (this.failCreate-- > 0) throw new Error("injected Session creation failure");
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, input);
    return { sessionId };
  }

  async acceptMessage(input: Parameters<ProjectTodoSessionCapability["acceptMessage"]>[0]): Promise<void> {
    if (this.failAccept-- > 0) throw new Error("injected message acceptance failure");
    this.messages.set(input.sessionId, input);
  }
}

function fixture() {
  const sessions = new FakeSessions();
  const service = new ProjectTodoService({
    workspaceRoot: TMP_ROOT,
    projectSlug: "project-a",
    sessions,
    state: new ProjectTodoStateManager(TMP_ROOT),
  });
  return { service, sessions };
}

async function readyTodo(service: ProjectTodoService, title = "Ship it", body = "Details") {
  const idea = await service.createTodo({ title, body });
  return service.updateTodo(idea.id, { expectedRevision: idea.revision, status: "ready" });
}

describe("ProjectTodoService", () => {
  test("creates multiple independent Discussion Sessions without changing Todo state", async () => {
    const { service, sessions } = fixture();
    const todo = await service.createTodo({ title: "Discuss", body: "Questions" });

    const first = await service.createSession(todo.id, {
      expectedRevision: todo.revision,
      entry: "discussion",
    });
    const second = await service.createSession(todo.id, {
      expectedRevision: todo.revision,
      entry: "discussion",
    });

    expect(first.todo).toEqual(todo);
    expect(second.todo).toEqual(todo);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(sessions.sessions.get(first.sessionId)?.projectTodo).toEqual({
      todoId: todo.id,
      entry: "discussion",
    });
    expect(sessions.messages.get(first.sessionId)?.text).toContain("Revision: 1");
    expect(sessions.messages.get(first.sessionId)?.text).toContain("Questions");
  });

  test("moves Ready to In Progress once and permits multiple Work or Automation Sessions", async () => {
    const { service, sessions } = fixture();
    const ready = await readyTodo(service, "Implement", "Acceptance");

    const first = await service.createSession(ready.id, {
      expectedRevision: ready.revision,
      entry: "work",
    });
    expect(first.todo).toMatchObject({
      status: "in_progress",
      revision: ready.revision + 1,
    });
    expect(sessions.messages.get(first.sessionId)?.text).toContain(`Revision: ${first.todo.revision}`);

    const second = await service.createSession(ready.id, {
      expectedRevision: first.todo.revision,
      entry: "work",
    });
    const automation = await service.createSession(ready.id, {
      expectedRevision: first.todo.revision,
      entry: "automation",
    });

    expect(second.todo).toEqual(first.todo);
    expect(automation.todo).toEqual(first.todo);
    expect(new Set([first.sessionId, second.sessionId, automation.sessionId]).size).toBe(3);
    expect(sessions.sessions.get(second.sessionId)?.projectTodo.entry).toBe("work");
    expect(sessions.sessions.get(automation.sessionId)?.projectTodo.entry).toBe("automation");
    expect(sessions.messages.get(automation.sessionId)?.text).toStartWith("/skill use automation-create ");
  });

  test("enforces entry state and current revision before creating a Session", async () => {
    const { service, sessions } = fixture();
    const idea = await service.createTodo({ title: "Not ready" });

    await expect(service.createSession(idea.id, {
      expectedRevision: idea.revision,
      entry: "work",
    })).rejects.toBeInstanceOf(ProjectTodoSessionStateError);
    await expect(service.createSession(idea.id, {
      expectedRevision: idea.revision + 1,
      entry: "discussion",
    })).rejects.toBeInstanceOf(ProjectTodoRevisionConflictError);
    expect(sessions.sessions.size).toBe(0);
  });

  test("leaves the accepted cross-file failure windows without recovery machinery", async () => {
    const { service, sessions } = fixture();
    const ready = await readyTodo(service);

    sessions.failCreate = 1;
    await expect(service.createSession(ready.id, {
      expectedRevision: ready.revision,
      entry: "work",
    })).rejects.toThrow("Session creation failure");
    const inProgress = await service.readTodo(ready.id);
    expect(inProgress.status).toBe("in_progress");
    expect(sessions.sessions.size).toBe(0);

    sessions.failAccept = 1;
    await expect(service.createSession(ready.id, {
      expectedRevision: inProgress.revision,
      entry: "work",
    })).rejects.toThrow("message acceptance failure");
    expect(sessions.sessions.size).toBe(1);
    expect(sessions.messages.size).toBe(0);
  });

  test("authorizes Discussion updates from immutable current Session source", async () => {
    const { service } = fixture();
    const todo = await service.createTodo({ title: "Shape" });
    const sessionId = crypto.randomUUID();
    const authorization = {
      sessionId,
      rootSessionId: sessionId,
      agentName: "lead",
      projectSlug: "project-a",
      projectTodo: { todoId: todo.id, entry: "discussion" as const },
    };

    const updated = await service.updateFromDiscussion({
      authorization,
      expectedRevision: todo.revision,
      patch: { title: "Shaped", status: "ready" },
    });
    expect(updated).toMatchObject({ title: "Shaped", status: "ready", revision: 2 });

    for (const invalidAuthorization of [
      { ...authorization, agentName: "build" },
      { ...authorization, rootSessionId: crypto.randomUUID() },
      { ...authorization, projectSlug: "project-b" },
      { ...authorization, projectTodo: { todoId: todo.id, entry: "work" as const } },
      { ...authorization, projectTodo: undefined },
    ]) {
      await expect(service.updateFromDiscussion({
        authorization: invalidAuthorization,
        expectedRevision: updated.revision,
        patch: { body: "Denied" },
      })).rejects.toBeInstanceOf(ProjectTodoDiscussionAuthorizationError);
    }
  });
});
