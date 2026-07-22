import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { silentLogger } from "../logger";
import { ProjectRegistry } from "../projects/registry";
import { projectRuntimePath } from "../projects/runtime-path";
import { ProjectTodoDiscussionAuthorizationError, ProjectTodoReturnToReadyConflictError, ProjectTodoRevisionConflictError } from "./errors";
import {
  ProjectTodoService,
  activationExecutionId,
  discussionExecutionId,
  type ProjectTodoProvenanceCapability,
  type ProjectTodoResourceSnapshot,
  type ProjectTodoSessionCapability,
} from "./service";
import { ProjectTodoStateManager } from "./state-manager";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "service", crypto.randomUUID());

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

class FakeSessions implements ProjectTodoSessionCapability {
  readonly sessions = new Map<string, { agentName: "lead"; title: string }>();
  readonly executions = new Map<string, { executionId: string; userMessage: string }>();
  readonly ensureSessionCalls = new Map<string, number>();
  readonly ensureExecutionCalls = new Map<string, number>();
  readonly activity = new Map<string, "idle" | "running" | "stopping">();
  readonly releasedIdleLeases = new Map<string, number>();
  failEnsureSession = 0;
  failEnsureExecution = 0;

  async ensureRootSession(input: Parameters<ProjectTodoSessionCapability["ensureRootSession"]>[0]): Promise<void> {
    this.ensureSessionCalls.set(input.sessionId, (this.ensureSessionCalls.get(input.sessionId) ?? 0) + 1);
    if (this.failEnsureSession-- > 0) throw new Error("injected ensure Session failure");
    const existing = this.sessions.get(input.sessionId);
    if (existing !== undefined && existing.agentName !== input.agentName) throw new Error("identity conflict");
    this.sessions.set(input.sessionId, { agentName: input.agentName, title: input.title });
  }

  async ensureExecution(input: Parameters<ProjectTodoSessionCapability["ensureExecution"]>[0]): Promise<void> {
    this.ensureExecutionCalls.set(input.sessionId, (this.ensureExecutionCalls.get(input.sessionId) ?? 0) + 1);
    if (this.failEnsureExecution-- > 0) throw new Error("injected ensure execution failure");
    const existing = this.executions.get(input.sessionId);
    if (existing !== undefined && existing.executionId !== input.executionId) throw new Error("execution conflict");
    this.executions.set(input.sessionId, { executionId: input.executionId, userMessage: input.userMessage });
  }

  async acquireIdleFamily(input: Parameters<ProjectTodoSessionCapability["acquireIdleFamily"]>[0]): Promise<{ release(): void } | undefined> {
    if ((this.activity.get(input.rootSessionId) ?? "idle") !== "idle") return undefined;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releasedIdleLeases.set(input.rootSessionId, (this.releasedIdleLeases.get(input.rootSessionId) ?? 0) + 1);
      },
    };
  }
}

class FakeProvenance implements ProjectTodoProvenanceCapability {
  resources: ProjectTodoResourceSnapshot[] = [];
  failListResources = 0;

  async listResources(input: Parameters<ProjectTodoProvenanceCapability["listResources"]>[0]): Promise<readonly ProjectTodoResourceSnapshot[]> {
    if (this.failListResources-- > 0) throw new Error("injected provenance failure");
    return this.resources.filter((resource) => resource.kind === input.kind && resource.createdFromSessionId === input.sourceSessionId);
  }
}

class CheckpointFailureStateManager extends ProjectTodoStateManager {
  failDiscussionCheckpoint = 0;
  failActivationCheckpoint = 0;

  override async checkpointDiscussion(...args: Parameters<ProjectTodoStateManager["checkpointDiscussion"]>) {
    if (this.failDiscussionCheckpoint-- > 0) throw new Error("injected Discussion checkpoint failure");
    return await super.checkpointDiscussion(...args);
  }

  override async checkpointActivation(...args: Parameters<ProjectTodoStateManager["checkpointActivation"]>) {
    if (this.failActivationCheckpoint-- > 0) throw new Error("injected Activation checkpoint failure");
    return await super.checkpointActivation(...args);
  }
}

function fixture() {
  const sessions = new FakeSessions();
  const provenance = new FakeProvenance();
  const state = new ProjectTodoStateManager(TMP_ROOT);
  const service = new ProjectTodoService({
    workspaceRoot: TMP_ROOT,
    projectSlug: "project-a",
    state,
    sessions,
    provenance,
  });
  return { sessions, provenance, state, service };
}

async function readyTodo(service: ProjectTodoService, title = "Ship it", body = "Original body") {
  const idea = await service.createTodo({ title, body });
  return service.updateTodo(idea.id, { expectedRevision: idea.revision, patch: { status: "ready" } });
}

describe("ProjectTodoService", () => {
  test("keeps workspace Todos accessible when same-name Projects are closed and re-added in another order", async () => {
    const homeDir = join(TMP_ROOT, "home");
    const firstWorkspace = join(TMP_ROOT, "first", "repo");
    const secondWorkspace = join(TMP_ROOT, "second", "repo");
    await mkdir(firstWorkspace, { recursive: true });
    await mkdir(secondWorkspace, { recursive: true });

    const registry = new ProjectRegistry({ homeDir, logger: silentLogger });
    const first = await registry.add({ workspaceRoot: firstWorkspace });
    const second = await registry.add({ workspaceRoot: secondWorkspace });
    expect(first.slug).toBe("repo");
    expect(second.slug).toBe("repo-2");

    const sessions = new FakeSessions();
    const provenance = new FakeProvenance();
    const originalService = new ProjectTodoService({
      workspaceRoot: secondWorkspace,
      projectSlug: second.slug,
      sessions,
      provenance,
    });
    const originalTodo = await originalService.createTodo({ title: "Survive re-registration" });

    await registry.remove(first.slug);
    await registry.remove(second.slug);
    const readded = await registry.add({ workspaceRoot: secondWorkspace });
    expect(readded.slug).toBe("repo");

    const reopenedService = new ProjectTodoService({
      workspaceRoot: secondWorkspace,
      projectSlug: readded.slug,
      sessions,
      provenance,
    });
    expect(await reopenedService.listTodos()).toEqual([originalTodo]);
    expect(await reopenedService.readTodo(originalTodo.id)).toEqual(originalTodo);

    const persisted = await Bun.file(projectRuntimePath(secondWorkspace, "todos", "state.json")).json() as {
      todos: Array<Record<string, unknown>>;
    };
    expect(persisted.todos[0]).not.toHaveProperty("projectSlug");
  });

  test("never creates a Session before the Discussion or Activation checkpoint commits", async () => {
    const sessions = new FakeSessions();
    const provenance = new FakeProvenance();
    const state = new CheckpointFailureStateManager(TMP_ROOT);
    const service = new ProjectTodoService({
      workspaceRoot: TMP_ROOT,
      projectSlug: "project-a",
      state,
      sessions,
      provenance,
    });

    const idea = await service.createTodo({ title: "Checkpoint Discussion" });
    state.failDiscussionCheckpoint = 1;
    await expect(service.discussTodo(idea.id, idea.revision)).rejects.toThrow("Discussion checkpoint failure");
    expect((await service.readTodo(idea.id)).discussionSessionId).toBeUndefined();
    expect(sessions.sessions.size).toBe(0);

    const activationIdea = await service.createTodo({ title: "Checkpoint Activation" });
    const ready = await service.updateTodo(activationIdea.id, {
      expectedRevision: activationIdea.revision,
      patch: { status: "ready" },
    });
    state.failActivationCheckpoint = 1;
    await expect(service.activateTodo(ready.id, {
      expectedRevision: ready.revision,
      kind: "session",
    })).rejects.toThrow("Activation checkpoint failure");
    expect((await service.readTodo(ready.id)).activation).toBeUndefined();
    expect(sessions.sessions.size).toBe(0);
  });

  test("Discussion checkpoints first and converges after Session and execution failures", async () => {
    const { service, sessions } = fixture();
    const todo = await service.createTodo({ title: "Explore", body: "Question" });
    sessions.failEnsureSession = 1;
    await expect(service.discussTodo(todo.id, todo.revision)).rejects.toThrow("injected ensure Session failure");

    const checkpoint = await service.readTodo(todo.id);
    expect(checkpoint.discussionSessionId).toBeString();
    expect(sessions.sessions.size).toBe(0);

    sessions.failEnsureExecution = 1;
    await expect(service.discussTodo(todo.id, todo.revision)).rejects.toThrow("injected ensure execution failure");
    expect(sessions.sessions.size).toBe(1);
    expect(sessions.executions.size).toBe(0);

    const recovered = await service.discussTodo(todo.id, todo.revision);
    const sessionId = recovered.discussionSessionId!;
    expect(sessions.sessions.get(sessionId)?.agentName).toBe("lead");
    expect(sessions.executions.get(sessionId)?.executionId).toBe(discussionExecutionId(todo.id));
    expect(sessions.executions.get(sessionId)?.userMessage).toContain(`Todo ID: ${todo.id}`);
    expect((await service.readTodo(todo.id)).revision).toBe(checkpoint.revision);

    // A production execution can fail asynchronously after the start handle is
    // returned but before any durable execution record exists. A later click
    // must re-run the idempotent ensure path instead of trusting a resolved cache.
    const callsBeforeAsyncFailureRetry = sessions.ensureExecutionCalls.get(sessionId)!;
    sessions.executions.delete(sessionId);
    await service.discussTodo(todo.id, todo.revision);
    expect(sessions.ensureExecutionCalls.get(sessionId)).toBe(callsBeforeAsyncFailureRetry + 1);
    expect(sessions.executions.get(sessionId)?.executionId).toBe(discussionExecutionId(todo.id));
  });

  test("concurrent Discussion calls converge on one durable Session and execution", async () => {
    const { service, sessions } = fixture();
    const todo = await service.createTodo({ title: "Concurrent" });
    const [left, right] = await Promise.all([
      service.discussTodo(todo.id, todo.revision),
      service.discussTodo(todo.id, todo.revision),
    ]);
    expect(left.discussionSessionId).toBe(right.discussionSessionId);
    expect(sessions.sessions.size).toBe(1);
    expect(sessions.executions.size).toBe(1);
    expect(sessions.executions.get(left.discussionSessionId!)?.executionId).toBe(discussionExecutionId(todo.id));
  });

  test("Discussion update authorizes only the bound Lead root Session", async () => {
    const { service } = fixture();
    const idea = await service.createTodo({ title: "Shape" });
    const discussed = await service.discussTodo(idea.id, idea.revision);
    const authorization = {
      sessionId: discussed.discussionSessionId!,
      rootSessionId: discussed.discussionSessionId!,
      agentName: "lead",
      projectSlug: "project-a",
    };
    const updated = await service.updateFromDiscussion({
      authorization,
      expectedRevision: discussed.revision,
      patch: { body: "Confirmed", status: "ready" },
    });
    expect(updated).toMatchObject({ body: "Confirmed", status: "ready" });

    await expect(service.updateFromDiscussion({
      authorization: { ...authorization, agentName: "analyst" },
      expectedRevision: updated.revision,
      patch: { body: "Denied" },
    })).rejects.toBeInstanceOf(ProjectTodoDiscussionAuthorizationError);
    await expect(service.updateFromDiscussion({
      authorization: { ...authorization, rootSessionId: crypto.randomUUID() },
      expectedRevision: updated.revision,
      patch: { body: "Denied" },
    })).rejects.toBeInstanceOf(ProjectTodoDiscussionAuthorizationError);
    await expect(service.updateFromDiscussion({
      authorization: { ...authorization, projectSlug: "project-b" },
      expectedRevision: updated.revision,
      patch: { body: "Denied" },
    })).rejects.toBeInstanceOf(ProjectTodoDiscussionAuthorizationError);
    const unboundSessionId = crypto.randomUUID();
    await expect(service.updateFromDiscussion({
      authorization: {
        sessionId: unboundSessionId,
        rootSessionId: unboundSessionId,
        agentName: "lead",
        projectSlug: "project-a",
      },
      expectedRevision: updated.revision,
      patch: { body: "Denied" },
    })).rejects.toBeInstanceOf(ProjectTodoDiscussionAuthorizationError);
    await expect(service.updateFromDiscussion({
      authorization,
      expectedRevision: discussed.revision,
      patch: { body: "Stale" },
    })).rejects.toBeInstanceOf(ProjectTodoRevisionConflictError);
  });

  test("Activation sends immutable snapshots through ordinary Sessions and the Automation Skill", async () => {
    const { service, sessions } = fixture();
    const ready = await readyTodo(service, "Original title", "Original body");
    sessions.failEnsureSession = 1;
    await expect(service.activateTodo(ready.id, { expectedRevision: ready.revision, kind: "session" })).rejects.toThrow("injected ensure Session failure");
    sessions.failEnsureExecution = 1;
    await expect(service.activateTodo(ready.id, { expectedRevision: ready.revision, kind: "session" })).rejects.toThrow();
    const checkpoint = await service.readTodo(ready.id);
    expect(checkpoint.activation?.snapshot).toEqual({ title: "Original title", body: "Original body" });

    const edited = await service.updateTodo(ready.id, {
      expectedRevision: checkpoint.revision,
      patch: { title: "Later title", body: "Later body" },
    });
    const recovered = await service.activateTodo(ready.id, { expectedRevision: ready.revision, kind: "session" });
    const sourceSessionId = recovered.activation!.sourceSessionId;
    const execution = sessions.executions.get(sourceSessionId)!;
    expect(execution.executionId).toBe(activationExecutionId(ready.id));
    expect(execution.userMessage).toStartWith("Implement the following Project Todo");
    expect(execution.userMessage).toContain("Original title");
    expect(execution.userMessage).toContain("Original body");
    expect(execution.userMessage).not.toContain("Later title");
    expect(recovered.title).toBe(edited.title);

    const automation = await readyTodo(service, "Automate");
    const automated = await service.activateTodo(automation.id, { expectedRevision: automation.revision, kind: "automation" });
    expect(sessions.executions.get(automated.activation!.sourceSessionId)?.userMessage).toStartWith("/skill use automation-create ");

    const ordinary = await readyTodo(service, "Implement");
    const activated = await service.activateTodo(ordinary.id, { expectedRevision: ordinary.revision, kind: "session" });
    expect(activated.activation?.resourceId).toBe(activated.activation?.sourceSessionId);
    expect(sessions.executions.get(activated.activation!.sourceSessionId)?.userMessage).toStartWith("Implement the following Project Todo");
  });

  test("concurrent Activation calls converge on one Lead Session and execution", async () => {
    const { service, sessions } = fixture();
    const ready = await readyTodo(service);
    const [left, right] = await Promise.all([
      service.activateTodo(ready.id, { expectedRevision: ready.revision, kind: "session" }),
      service.activateTodo(ready.id, { expectedRevision: ready.revision, kind: "session" }),
    ]);
    expect(left.activation?.sourceSessionId).toBe(right.activation?.sourceSessionId);
    expect(sessions.sessions.size).toBe(1);
    expect(sessions.executions.size).toBe(1);
    expect(sessions.executions.get(left.activation!.sourceSessionId)?.executionId).toBe(activationExecutionId(ready.id));
  });

  test("binds the canonical earliest Automation resource once and recovers after restart", async () => {
    const { service, provenance, sessions } = fixture();
    const ready = await readyTodo(service);
    const active = await service.activateTodo(ready.id, { expectedRevision: ready.revision, kind: "automation" });
    const source = active.activation!.sourceSessionId;
    const laterId = crypto.randomUUID();
    const earlierId = crypto.randomUUID();
    provenance.resources = [
      { kind: "automation", id: laterId, createdFromSessionId: source, createdAt: 20, status: "active" },
      { kind: "automation", id: earlierId, createdFromSessionId: source, createdAt: 10, status: "paused" },
    ];

    const restarted = new ProjectTodoService({
      workspaceRoot: TMP_ROOT,
      projectSlug: "project-a",
      state: new ProjectTodoStateManager(TMP_ROOT),
      sessions,
      provenance,
    });
    const reconciled = await restarted.reconcileTodo(ready.id);
    expect(reconciled.activation?.resourceId).toBe(earlierId);
    const revision = reconciled.revision;
    expect((await restarted.handleResourceCreated({ kind: "automation", sourceSessionId: source, resourceId: laterId }))?.activation?.resourceId).toBe(earlierId);
    expect((await restarted.readTodo(ready.id)).revision).toBe(revision);
  });

  test("recovers exact Automation binding after post-commit notification failure", async () => {
    const { service, provenance, sessions } = fixture();

    for (const kind of ["automation"] as const) {
      const ready = await readyTodo(service, `${kind} binding`);
      const active = await service.activateTodo(ready.id, { expectedRevision: ready.revision, kind });
      const sourceSessionId = active.activation!.sourceSessionId;
      const resourceId = crypto.randomUUID();
      provenance.resources.push({ kind, id: resourceId, createdFromSessionId: sourceSessionId, createdAt: 20, status: "active" });
      provenance.failListResources = 1;

      await expect(service.handleResourceCreated({ kind, sourceSessionId, resourceId }))
        .rejects.toThrow("injected provenance failure");
      expect((await service.readTodo(ready.id)).activation?.resourceId).toBeUndefined();

      const restarted = new ProjectTodoService({
        workspaceRoot: TMP_ROOT,
        projectSlug: "project-a",
        state: new ProjectTodoStateManager(TMP_ROOT),
        sessions,
        provenance,
      });
      expect((await restarted.reconcileTodo(ready.id)).activation?.resourceId).toBe(resourceId);
    }
  });

  test("Return to Ready never starts work and enforces family and resource authority", async () => {
    const { service, sessions, provenance } = fixture();
    const sessionReady = await readyTodo(service, "Session");
    const sessionActive = await service.activateTodo(sessionReady.id, { expectedRevision: sessionReady.revision, kind: "session" });
    const source = sessionActive.activation!.sourceSessionId;
    sessions.activity.set(source, "running");
    await expect(service.returnToReady(sessionReady.id, sessionActive.revision)).rejects.toBeInstanceOf(ProjectTodoReturnToReadyConflictError);
    sessions.activity.set(source, "idle");
    expect((await service.returnToReady(sessionReady.id, sessionActive.revision)).activation).toBeUndefined();
    expect(sessions.releasedIdleLeases.get(source)).toBe(1);

    const automationReady = await readyTodo(service, "Automation");
    const automationActive = await service.activateTodo(automationReady.id, { expectedRevision: automationReady.revision, kind: "automation" });
    const automationSource = automationActive.activation!.sourceSessionId;
    const automationId = crypto.randomUUID();
    provenance.resources = [{ kind: "automation", id: automationId, createdFromSessionId: automationSource, createdAt: 1, status: "active" }];
    await expect(service.returnToReady(automationReady.id, automationActive.revision)).rejects.toBeInstanceOf(ProjectTodoRevisionConflictError);
    const boundAutomation = await service.readTodo(automationReady.id);
    provenance.resources = [{ kind: "automation", id: automationId, createdFromSessionId: automationSource, createdAt: 1, status: "paused" }];
    expect((await service.returnToReady(automationReady.id, boundAutomation.revision)).activation).toBeUndefined();

    const doneReady = await readyTodo(service, "Done result link");
    const doneActive = await service.activateTodo(doneReady.id, { expectedRevision: doneReady.revision, kind: "session" });
    const done = await service.updateTodo(doneActive.id, {
      expectedRevision: doneActive.revision,
      patch: { status: "done" },
    });
    await expect(service.returnToReady(done.id, done.revision)).rejects.toBeInstanceOf(ProjectTodoReturnToReadyConflictError);
    const archived = await service.archiveTodo(done.id, done.revision);
    await expect(service.returnToReady(archived.id, archived.revision)).rejects.toBeInstanceOf(ProjectTodoReturnToReadyConflictError);
  });
});
