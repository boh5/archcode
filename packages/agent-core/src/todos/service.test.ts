import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateProjectTodoSessionInput, RootSessionSummary } from "@archcode/protocol";

import {
  ProjectTodoDiscussionAuthorizationError,
  ProjectTodoRunNowConflictError,
  ProjectTodoRunNowRecoveryError,
  ProjectTodoStartDiscussionConflictError,
  ProjectTodoStartDiscussionRecoveryError,
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
  failAcceptAfterDurable = 0;
  failDurableRead = 0;
  failDelete = 0;
  failCreateAfterDurable = 0;
  failRead = 0;

  async createRootSession(input: Parameters<ProjectTodoSessionCapability["createRootSession"]>[0]) {
    if (this.failCreate-- > 0) throw new Error("injected Session creation failure");
    const existing = this.sessions.get(input.sessionId);
    if (existing !== undefined && !sameSessionInput(existing, input)) {
      throw new Error("injected Session identity conflict");
    }
    this.sessions.set(input.sessionId, input);
    if (this.failCreateAfterDurable-- > 0) throw new Error("injected post-persistence failure");
    return { sessionId: input.sessionId };
  }

  async acceptMessage(input: Parameters<ProjectTodoSessionCapability["acceptMessage"]>[0]): Promise<void> {
    if (this.failAccept-- > 0) throw new Error("injected message acceptance failure");
    this.messages.set(input.sessionId, input);
    if (this.failAcceptAfterDurable-- > 0) throw new Error("injected wake-up failure");
  }

  async readRootSession(
    input: Parameters<ProjectTodoSessionCapability["readRootSession"]>[0],
  ): Promise<RootSessionSummary | undefined> {
    if (this.failRead-- > 0) throw new Error("injected Session read failure");
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) return undefined;
    return {
      sessionId: input.sessionId,
      cwd: session.workspaceRoot,
      rootSessionId: input.sessionId,
      agentName: session.agentName,
      profile: "principal",
      activeSkillNames: [],
      modelSelection: { revision: 0 },
      title: session.title,
      source: session.source,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  async hasDurableMessage(input: Parameters<ProjectTodoSessionCapability["hasDurableMessage"]>[0]): Promise<boolean> {
    if (this.failDurableRead-- > 0) throw new Error("injected durable receipt read failure");
    return this.messages.get(input.sessionId)?.clientRequestId === input.clientRequestId;
  }

  async deleteSession(input: Parameters<ProjectTodoSessionCapability["deleteSession"]>[0]): Promise<void> {
    if (this.failDelete-- > 0) throw new Error("injected Session delete failure");
    this.sessions.delete(input.sessionId);
    this.messages.delete(input.sessionId);
  }
}

function sameSessionInput(
  first: Parameters<ProjectTodoSessionCapability["createRootSession"]>[0],
  second: Parameters<ProjectTodoSessionCapability["createRootSession"]>[0],
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
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

async function readyTodo(service: ProjectTodoService, label = "Ship it", details = "Details") {
  const idea = await service.createTodo({ content: `${label}\n\n${details}` });
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
    const todo = await service.createTodo({ content: "Discuss\n\nQuestions" });

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
    expect(sessions.sessions.get(first.sessionId)?.source).toEqual({
      kind: "todo",
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
      content: "Plan safely\n\nAvoid racing the initial Discussion execution.",
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
    expect(sessions.sessions.get(second.sessionId)?.source).toMatchObject({ kind: "todo", entry: "work" });
    expect(sessions.sessions.get(automation.sessionId)?.source).toMatchObject({ kind: "todo", entry: "automation" });
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
    const idea = await service.createTodo({ content: "Not ready" });

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

  test("runs now once across concurrent and sequential idempotent retries", async () => {
    const { service, sessions } = fixture();
    const clientRequestId = crypto.randomUUID();
    const request = { clientRequestId, content: "Fix the type\n\nChange the field." };

    const [first, concurrent] = await Promise.all([
      service.runNow(request),
      service.runNow(request),
    ]);
    const replay = await service.runNow(request);

    expect(concurrent).toEqual(first);
    expect(replay).toEqual(first);
    expect(first.todo).toMatchObject({ status: "in_progress", revision: 1 });
    expect(first.session.source).toEqual({ kind: "todo", todoId: first.todo.id, entry: "work" });
    expect(sessions.sessions.size).toBe(1);
    expect(sessions.messages.size).toBe(1);
    expect(await service.listTodos()).toHaveLength(1);
    await expect(service.runNow({ ...request, content: "Different" }))
      .rejects.toBeInstanceOf(ProjectTodoRunNowConflictError);
  });

  test("starts one captured Discussion across concurrent, sequential, and restarted retries", async () => {
    const sessions = new FakeSessions();
    const state = new ProjectTodoStateManager(TMP_ROOT);
    const service = new ProjectTodoService({
      workspaceRoot: TMP_ROOT,
      projectSlug: "project-a",
      sessions,
      state,
    });
    const request = {
      clientRequestId: crypto.randomUUID(),
      content: "Discuss the capture\n\nClarify the boundary.",
    };

    const [first, concurrent] = await Promise.all([
      service.startDiscussion(request),
      service.startDiscussion(request),
    ]);
    const sequential = await service.startDiscussion(request);
    const restarted = new ProjectTodoService({
      workspaceRoot: TMP_ROOT,
      projectSlug: "project-a",
      sessions,
      state: new ProjectTodoStateManager(TMP_ROOT),
    });
    const replay = await restarted.startDiscussion(request);

    expect(concurrent).toEqual(first);
    expect(sequential).toEqual(first);
    expect(replay).toEqual(first);
    expect(first.todo).toMatchObject({ status: "idea", revision: 1 });
    expect(first.session).toMatchObject({
      agentName: "discussion",
      source: { kind: "todo", todoId: first.todo.id, entry: "discussion" },
    });
    expect(sessions.sessions.size).toBe(1);
    expect(sessions.messages.size).toBe(1);
    expect(await restarted.listTodos()).toEqual([first.todo]);
    expect(sessions.messages.get(first.session.sessionId)?.clientRequestId).toBe(request.clientRequestId);
    expect(sessions.messages.get(first.session.sessionId)?.text).toContain(
      "Discuss and shape the bound Project Todo",
    );
    await expect(restarted.startDiscussion({ ...request, content: "Different" }))
      .rejects.toBeInstanceOf(ProjectTodoStartDiscussionConflictError);
  });

  test("resumes the exact preallocated Discussion identity after restart at either creation boundary", async () => {
    for (const sessionAlreadyDurable of [false, true]) {
      const workspaceRoot = join(
        TMP_ROOT,
        sessionAlreadyDurable ? "session-durable" : "session-not-created",
      );
      await mkdir(workspaceRoot, { recursive: true });
      const sessions = new FakeSessions();
      const request = {
        clientRequestId: crypto.randomUUID(),
        content: sessionAlreadyDurable
          ? "Resume after Session persistence"
          : "Resume before Session persistence",
      };
      const state = new ProjectTodoStateManager(workspaceRoot);
      const { todo, receipt } = await state.beginStartDiscussion({
        ...request,
        requestHash: new Bun.CryptoHasher("sha256")
          .update(JSON.stringify({ content: request.content }))
          .digest("hex"),
      });
      if (sessionAlreadyDurable) {
        await sessions.createRootSession({
          workspaceRoot,
          sessionId: receipt.sessionId,
          agentName: "discussion",
          title: `Discussion: ${request.content}`,
          source: { kind: "todo", todoId: todo.id, entry: "discussion" },
        });
      }

      const restarted = new ProjectTodoService({
        workspaceRoot,
        projectSlug: "project-a",
        sessions,
        state: new ProjectTodoStateManager(workspaceRoot),
      });
      const result = await restarted.startDiscussion(request);

      expect(result.todo.id).toBe(todo.id);
      expect(result.session.sessionId).toBe(receipt.sessionId);
      expect(sessions.sessions.size).toBe(1);
      expect(sessions.messages.size).toBe(1);
    }
  });

  test("reuses the preallocated Discussion Session after persistence-response loss", async () => {
    const { service, sessions } = fixture();
    sessions.failCreateAfterDurable = 1;
    const request = {
      clientRequestId: crypto.randomUUID(),
      content: "Persisted before response loss",
    };

    const result = await service.startDiscussion(request);

    expect(sessions.sessions.size).toBe(1);
    expect(sessions.sessions.has(result.session.sessionId)).toBe(true);
    expect(sessions.messages.size).toBe(1);
  });

  test("compensates absent or non-durable Start discussion work and permits exact retry", async () => {
    const { service, sessions } = fixture();
    sessions.failCreate = 1;
    const createRequest = {
      clientRequestId: crypto.randomUUID(),
      content: "Discussion create fails",
    };
    await expect(service.startDiscussion(createRequest)).rejects.toThrow("Session creation failure");
    expect(await service.listTodos()).toEqual([]);

    sessions.failAccept = 1;
    const acceptRequest = {
      clientRequestId: crypto.randomUUID(),
      content: "Discussion acceptance fails",
    };
    await expect(service.startDiscussion(acceptRequest)).rejects.toThrow("message acceptance failure");
    expect(await service.listTodos()).toEqual([]);
    expect(sessions.sessions.size).toBe(0);

    const retried = await service.startDiscussion(acceptRequest);
    expect(retried.todo.status).toBe("idea");
    expect(sessions.sessions.size).toBe(1);
  });

  test("keeps durable Start discussion acceptance when wake-up fails", async () => {
    const { service, sessions } = fixture();
    sessions.failAcceptAfterDurable = 1;

    const result = await service.startDiscussion({
      clientRequestId: crypto.randomUUID(),
      content: "Discussion accepted before wake-up",
    });

    expect(result.todo.status).toBe("idea");
    expect(sessions.sessions.has(result.session.sessionId)).toBe(true);
    expect(sessions.messages.has(result.session.sessionId)).toBe(true);
  });

  test("returns exact recovery identifiers for indeterminate Start discussion state", async () => {
    const { service, sessions } = fixture();
    sessions.failAccept = 1;
    sessions.failDurableRead = 1;
    const request = {
      clientRequestId: crypto.randomUUID(),
      content: "Discussion acceptance is indeterminate",
    };

    const error = await service.startDiscussion(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectTodoStartDiscussionRecoveryError);
    if (!(error instanceof ProjectTodoStartDiscussionRecoveryError)) throw error;
    expect(error).toMatchObject({ todoId: expect.any(String), sessionId: expect.any(String) });
    expect(sessions.sessions.size).toBe(1);
    expect(await service.listTodos()).toHaveLength(1);
    await expect(service.startDiscussion(request))
      .rejects.toMatchObject({ todoId: error.todoId, sessionId: error.sessionId });
    expect(sessions.sessions.size).toBe(1);
  });

  test("fails Start discussion closed when Session persistence cannot be determined", async () => {
    const { service, sessions } = fixture();
    sessions.failCreate = 1;
    sessions.failRead = 1;
    const request = {
      clientRequestId: crypto.randomUUID(),
      content: "Session state cannot be determined",
    };

    const error = await service.startDiscussion(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectTodoStartDiscussionRecoveryError);
    if (!(error instanceof ProjectTodoStartDiscussionRecoveryError)) throw error;
    expect(error).toMatchObject({ todoId: expect.any(String), sessionId: expect.any(String) });
    expect(await service.listTodos()).toHaveLength(1);
    await expect(service.startDiscussion(request)).rejects.toMatchObject({
      todoId: error.todoId,
      sessionId: error.sessionId,
    });
  });

  test("compensates failed run-now creation and non-durable acceptance", async () => {
    const { service, sessions } = fixture();

    sessions.failCreate = 1;
    const createRequest = { clientRequestId: crypto.randomUUID(), content: "Create fails" };
    await expect(service.runNow(createRequest)).rejects.toThrow("Session creation failure");
    expect(await service.listTodos()).toEqual([]);

    sessions.failAccept = 1;
    const acceptRequest = { clientRequestId: crypto.randomUUID(), content: "Accept fails" };
    await expect(service.runNow(acceptRequest)).rejects.toThrow("message acceptance failure");
    expect(await service.listTodos()).toEqual([]);
    expect(sessions.sessions.size).toBe(0);

    const retried = await service.runNow(acceptRequest);
    expect(retried.todo.status).toBe("in_progress");
    expect(await service.listTodos()).toHaveLength(1);
  });

  test("keeps durable accepted work when execution wake-up fails", async () => {
    const { service, sessions } = fixture();
    sessions.failAcceptAfterDurable = 1;

    const result = await service.runNow({
      clientRequestId: crypto.randomUUID(),
      content: "Accepted before wake-up",
    });

    expect(result.todo.status).toBe("in_progress");
    expect(sessions.sessions.has(result.session.sessionId)).toBe(true);
    expect(sessions.messages.has(result.session.sessionId)).toBe(true);
  });

  test("returns recovery identifiers when compensation cannot delete partial work", async () => {
    const { service, sessions } = fixture();
    sessions.failAccept = 1;
    sessions.failDelete = 1;

    const error = await service.runNow({
      clientRequestId: crypto.randomUUID(),
      content: "Needs recovery",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectTodoRunNowRecoveryError);
    expect(error).toMatchObject({ todoId: expect.any(String), sessionId: expect.any(String) });
  });

  test("returns typed recovery identifiers when durable acceptance cannot be determined", async () => {
    const { service, sessions } = fixture();
    sessions.failAccept = 1;
    sessions.failDurableRead = 1;
    const request = {
      clientRequestId: crypto.randomUUID(),
      content: "Acceptance is indeterminate",
    };

    const error = await service.runNow(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectTodoRunNowRecoveryError);
    expect(error).toMatchObject({ todoId: expect.any(String), sessionId: expect.any(String) });
    expect(sessions.sessions.size).toBe(1);
    expect(await service.listTodos()).toHaveLength(1);
    await expect(service.runNow(request)).rejects.toBeInstanceOf(ProjectTodoRunNowRecoveryError);
    expect(sessions.sessions.size).toBe(1);
  });

  test("authorizes Discussion updates from root identity and immutable Todo binding", async () => {
    const { service } = fixture();
    const todo = await service.createTodo({ content: "Shape" });
    const sessionId = crypto.randomUUID();
    const authorization = {
      sessionId,
      rootSessionId: sessionId,
      agentName: "discussion",
      projectSlug: "project-a",
      source: { kind: "todo" as const, todoId: todo.id, entry: "discussion" as const },
    };

    const updated = await service.updateFromDiscussion({
      authorization,
      expectedRevision: todo.revision,
      patch: { content: "Shaped", status: "ready" },
    });
    expect(updated).toMatchObject({ content: "Shaped", status: "ready", revision: 2 });

    for (const invalidAuthorization of [
      { ...authorization, agentName: "lead" },
      { ...authorization, rootSessionId: crypto.randomUUID() },
      { ...authorization, projectSlug: "project-b" },
      { ...authorization, source: undefined },
    ]) {
      await expect(service.updateFromDiscussion({
        authorization: invalidAuthorization,
        expectedRevision: updated.revision,
        patch: { content: "Denied" },
      })).rejects.toBeInstanceOf(ProjectTodoDiscussionAuthorizationError);
    }
  });
});
