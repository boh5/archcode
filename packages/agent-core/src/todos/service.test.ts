import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateProjectTodoSessionInput } from "@archcode/protocol";

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
  test("does not expose Plan intent on Work or Automation inputs", () => {
    const invalid: CreateProjectTodoSessionInput = {
      expectedRevision: 1,
      entry: "work",
      // @ts-expect-error Work requests must omit Discussion-only initialIntent.
      initialIntent: undefined,
    };

    expect(invalid.entry).toBe("work");
  });

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
    expect(sessions.sessions.get(first.sessionId)?.agentName).toBe("discussion");
    expect(sessions.messages.get(first.sessionId)?.text).toContain("Revision: 1");
    expect(sessions.messages.get(first.sessionId)?.text).toContain("Questions");
    expect(sessions.messages.get(first.sessionId)?.text).toContain(
      `.archcode/plans/${todo.id}.md`,
    );
    expect(sessions.messages.get(first.sessionId)?.text).toContain(
      "may create or improve",
    );
  });

  test("starts a new Plan Discussion with the Plan command as its first accepted message", async () => {
    const { service, sessions } = fixture();
    const todo = await service.createTodo({
      title: "Plan safely",
      body: "Avoid racing the initial Discussion execution.",
    });

    const discussion = await service.createSession(todo.id, {
      expectedRevision: todo.revision,
      entry: "discussion",
      initialIntent: "plan",
    });

    expect(sessions.messages.get(discussion.sessionId)?.text).toStartWith(
      `/skill use plan-work Create or improve the implementation Plan for this bound Todo at .archcode/plans/${todo.id}.md.`,
    );
    expect(sessions.messages.get(discussion.sessionId)?.text).toContain("Plan safely");
    expect(discussion.todo).toEqual(todo);
  });

  test("moves Ready to In Progress once and keeps ordinary Work when no Plan exists", async () => {
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
    expect(sessions.sessions.get(first.sessionId)?.agentName).toBe("lead");
    expect(sessions.messages.get(first.sessionId)?.text).toContain(`Revision: ${first.todo.revision}`);
    expect(sessions.messages.get(first.sessionId)?.text).toStartWith(
      "Implement the following Project Todo as an ordinary Lead Session.",
    );

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

  test("routes Work through execute-plan when the Todo Plan exists", async () => {
    const { service, sessions } = fixture();
    const ready = await readyTodo(service, "Implement from Plan", "Acceptance");
    const planPath = join(TMP_ROOT, ".archcode", "plans", `${ready.id}.md`);
    await mkdir(join(TMP_ROOT, ".archcode", "plans"), { recursive: true });
    await Bun.write(planPath, "# Plan\n");

    const created = await service.createSession(ready.id, {
      expectedRevision: ready.revision,
      entry: "work",
    });

    expect(sessions.sessions.get(created.sessionId)?.agentName).toBe("lead");
    expect(sessions.messages.get(created.sessionId)?.text).toStartWith(
      `/skill use execute-plan Execute the Project Todo using the Plan at .archcode/plans/${ready.id}.md.`,
    );
    expect(sessions.messages.get(created.sessionId)?.text).toContain(
      `Todo ID: ${ready.id}`,
    );
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
    await expect(service.createSession(idea.id, {
      expectedRevision: idea.revision,
      entry: "work",
      initialIntent: "plan",
    } as unknown as Parameters<ProjectTodoService["createSession"]>[1])).rejects.toThrow();
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

  test("authorizes Discussion updates from root identity and immutable Todo binding", async () => {
    const { service } = fixture();
    const todo = await service.createTodo({ title: "Shape" });
    const sessionId = crypto.randomUUID();
    const authorization = {
      sessionId,
      rootSessionId: sessionId,
      agentName: "discussion",
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
      { ...authorization, agentName: "lead" },
      { ...authorization, rootSessionId: crypto.randomUUID() },
      { ...authorization, projectSlug: "project-b" },
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
