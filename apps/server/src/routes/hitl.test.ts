import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { GlobalSSEEvent, HitlDisplayPayload, HitlProjection, HitlRecord } from "@archcode/protocol";
import { ProjectContextResolver, ProjectRegistry, silentLogger } from "@archcode/agent-core";
import type { AgentRuntime, ProjectContext, ProjectInfo } from "@archcode/agent-core";
import { GoalStateManager } from "../../../../packages/agent-core/src/goals/state";
import { ResumeCoordinator, type SessionHitlResumeAdapter } from "../../../../packages/agent-core/src/hitl/resume-coordinator";
import type { LoopConfig } from "../../../../packages/agent-core/src/loops/state";
import { SessionStoreManager } from "../../../../packages/agent-core/src/store/session-store-manager";
import { getSessionPath } from "../../../../packages/agent-core/src/store/sessions-dir";
import { createServerApp, createServerEventRuntime } from "../app";
import { globalEventBus } from "../events/global-event-bus";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "hitl-routes");

type HitlListBody = { hitl: Array<HitlProjection & { resumeStatus: string }> };
type HitlMutationBody = { hitlId: string; status: string; resumeStatus: string; hitl: HitlProjection & { resumeStatus: string } };
type TestHitlService = ProjectContext["hitl"];

interface TestFixture {
  app: ReturnType<typeof createServerApp>["app"];
  runtime: AgentRuntime;
  sessionStoreManager: SessionStoreManager;
  sessionResumeCalls: () => number;
}

const LOOP_CONFIG: LoopConfig = {
  templateId: "watch_report",
  title: "Route test loop",
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: {
    maxIterationsPerRun: 1,
    softThresholdRatio: 0.8,
    hardThresholdRatio: 1,
  },
};

function createTestRuntime(projectRegistry: ProjectRegistry): Omit<TestFixture, "app"> {
  const sessionStoreManager = new SessionStoreManager({ logger: silentLogger });
  let sessionResumeCalls = 0;
  const sessionAdapter: SessionHitlResumeAdapter = {
    async resume(): Promise<void> {
      sessionResumeCalls += 1;
    },
  };
  const contextResolver = new ProjectContextResolver({
    projectInfoFactory: (workspaceRoot) => projectRegistry.getByWorkspace(workspaceRoot),
    logger: silentLogger,
    sessionStoreManager,
    resumeCoordinatorFactory: (input) => new ResumeCoordinator({
      hitl: input.hitl,
      adapters: { session: sessionAdapter },
      logger: silentLogger,
    }),
  });

  const runtime = {
    projectRegistry,
    contextResolver,
    warnings: [],
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    skillService: undefined,
    hitl: undefined,
    recoverHitlResumes: mock(async () => undefined),
    subscribeHitlEvents: mock(() => () => undefined),
    subscribeMcpStatusChanges: mock(() => () => undefined),
    getMcpServerStatuses: mock(() => new Map()),
    createSession: mock(async (workspaceRoot: string) => sessionStoreManager.createSessionFile(workspaceRoot)),
    getSessionFile: mock(async (workspaceRoot: string, sessionId: string) => sessionStoreManager.getSessionFile(workspaceRoot, sessionId)),
    listSessions: mock(async (workspaceRoot: string) => sessionStoreManager.listSessionSummaries(workspaceRoot)),
    startSessionExecution: mock(() => {
      throw new Error("not implemented");
    }),
    abortSessionExecution: mock(() => false),
    abortSessionExecutionAndWait: mock(async () => undefined),
    abortAllSessionExecutions: mock(async () => undefined),
    isSessionExecutionRunning: mock(() => false),
    getSessionExecution: mock(() => undefined),
    subscribeSessionEvents: mock(() => () => undefined),
    deleteSession: mock(async () => undefined),
    listSessionTree: mock(async (workspaceRoot: string, rootSessionId: string) => sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId)),
    disposeSessionAgent: mock(() => undefined),
    disposeAllSessionAgents: mock(() => undefined),
    isSessionTombstoned: mock(() => false),
    dispatchCommand: mock(async () => null),
    listLoops: mock(async () => []),
    readLoop: mock(async () => {
      throw new Error("not implemented");
    }),
    createLoop: mock(async () => {
      throw new Error("not implemented");
    }),
    updateLoop: mock(async () => {
      throw new Error("not implemented");
    }),
    pauseLoop: mock(async () => {
      throw new Error("not implemented");
    }),
    resumeLoop: mock(async () => {
      throw new Error("not implemented");
    }),
    triggerLoopRun: mock(async () => undefined),
    readLoopKillState: mock(async () => ({ active: false, updatedAt: Date.now() })),
    cancelLoopCurrentRun: mock(async () => undefined),
    cancelCurrentLoopRun: mock(async () => undefined),
    activateLoopGlobalKill: mock(async () => ({ active: true, updatedAt: Date.now() })),
    clearLoopGlobalKill: mock(async () => ({ active: false, updatedAt: Date.now() })),
    readLoopBudget: mock(async () => null),
    readLoopCollisions: mock(async () => ({ targets: [], activeLeases: [], conflicts: [], updatedAt: Date.now() })),
    readLoopIntegrationStatus: mock(async () => ({ statuses: [], snapshot: null, updatedAt: Date.now() })),
    readLoopRunLog: mock(async () => []),
    readLoopStateMarkdown: mock(async () => ""),
    startLoopSchedulers: mock(async () => undefined),
    stopLoopSchedulers: mock(async () => undefined),
    notifyRuntimeShutdown: mock(() => undefined),
  } as unknown as AgentRuntime;

  return { runtime, sessionStoreManager, sessionResumeCalls: () => sessionResumeCalls };
}

async function createTestApp(testName: string): Promise<TestFixture> {
  const homeDir = resolve(tempRoot, "homes", testName);
  await mkdir(homeDir, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const fixture = createTestRuntime(projectRegistry);
  return {
    app: createServerApp(fixture.runtime, { dev: true }).app,
    ...fixture,
  };
}

async function addProject(runtime: AgentRuntime, testName: string, name: string): Promise<ProjectInfo> {
  const workspaceRoot = resolve(tempRoot, "workspaces", testName, name);
  await mkdir(workspaceRoot, { recursive: true });
  return await runtime.projectRegistry.add({ workspaceRoot, name });
}

describe("hitl routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("scoped canonical route lists project/session/goal/loop HITL and redacts payloads", async () => {
    const fixture = await createTestApp("scoped-list");
    const project = await addProject(fixture.runtime, "scoped-list", "Scoped Project");
    const context = await fixture.runtime.contextResolver.resolve(project.workspaceRoot);

    const rootSessionId = await createSession(fixture, project, {});
    const childSessionId = await createSession(fixture, project, { rootSessionId, parentSessionId: rootSessionId });
    const rootHitl = await createSessionHitl(context.hitl, project.slug, rootSessionId, "Root session question");
    const childHitl = await createSessionHitl(context.hitl, project.slug, childSessionId, "Child session question");

    const goal = await createGoal(context.goalState, project.slug, "Scoped Goal");
    const goalSessionId = await createSession(fixture, project, { goalId: goal.id });
    const goalChildSessionId = await createSession(fixture, project, { rootSessionId: goalSessionId, parentSessionId: goalSessionId, goalId: goal.id });
    const goalHitl = await createGoalHitl(context.hitl, project.slug, goal.id, "Goal approval");
    const goalSessionHitl = await createSessionHitl(context.hitl, project.slug, goalSessionId, "Goal child session");
    const goalGrandchildHitl = await createSessionHitl(context.hitl, project.slug, goalChildSessionId, "Goal grandchild session");

    const loop = await context.loopState.create(project.slug, LOOP_CONFIG);
    const loopSessionId = await createSession(fixture, project, { loopId: loop.loopId });
    const loopGoal = await createGoal(context.goalState, project.slug, "Loop Goal", loop.loopId);
    const loopGoalSessionId = await createSession(fixture, project, { goalId: loopGoal.id });
    const loopHitl = await createLoopHitl(context.hitl, project.slug, loop.loopId, "Loop approval");
    const loopSessionHitl = await createSessionHitl(context.hitl, project.slug, loopSessionId, "Loop child session");
    const loopGoalHitl = await createGoalHitl(context.hitl, project.slug, loopGoal.id, "Loop child goal");
    const loopGoalSessionHitl = await createSessionHitl(context.hitl, project.slug, loopGoalSessionId, "Loop goal session");
    const staleLoopHitl = await createLoopHitl(context.hitl, project.slug, crypto.randomUUID(), "Stale loop HITL");

    const projectList = await getHitl(fixture.app, `/api/projects/${project.slug}/hitl?scope=project&status=pending`);
    expect(projectList.hitl.map((item) => item.hitlId)).toEqual([
      childHitl.hitlId,
      goalGrandchildHitl.hitlId,
      goalSessionHitl.hitlId,
      loopGoalSessionHitl.hitlId,
      loopSessionHitl.hitlId,
      rootHitl.hitlId,
      goalHitl.hitlId,
      loopGoalHitl.hitlId,
      loopHitl.hitlId,
    ].sort());
    expect(projectList.hitl.map((item) => item.hitlId)).not.toContain(staleLoopHitl.hitlId);
    expectHitlListIsDisplaySafe(projectList);

    const sessionList = await getHitl(fixture.app, `/api/projects/${project.slug}/hitl?scope=session&ownerId=${rootSessionId}&includeChildren=true&status=pending`);
    expect(sessionList.hitl.map((item) => item.hitlId)).toEqual([childHitl.hitlId, rootHitl.hitlId].sort());

    const goalList = await getHitl(fixture.app, `/api/projects/${project.slug}/hitl?scope=goal&ownerId=${goal.id}&includeChildren=true&status=pending`);
    expect(goalList.hitl.map((item) => item.hitlId)).toEqual([goalGrandchildHitl.hitlId, goalHitl.hitlId, goalSessionHitl.hitlId].sort());

    const loopList = await getHitl(fixture.app, `/api/projects/${project.slug}/hitl?scope=loop&ownerId=${loop.loopId}&includeChildren=true&status=pending`);
    expect(loopList.hitl.map((item) => item.hitlId)).toEqual([loopGoalHitl.hitlId, loopGoalSessionHitl.hitlId, loopHitl.hitlId, loopSessionHitl.hitlId].sort());

    await context.hitl.cancelRecord(loopHitl.hitlId, "recent route coverage");
    const recentList = await getHitl(fixture.app, `/api/projects/${project.slug}/hitl?scope=loop&ownerId=${loop.loopId}&includeChildren=true&status=recent`);
    expect(recentList.hitl).toContainEqual(expect.objectContaining({ hitlId: loopHitl.hitlId, status: "cancelled", resumeStatus: "terminal" }));
    const allList = await getHitl(fixture.app, `/api/projects/${project.slug}/hitl?scope=loop&ownerId=${loop.loopId}&includeChildren=true&status=all`);
    expect(allList.hitl.map((item) => item.hitlId)).toContain(loopHitl.hitlId);

    const missingOwner = await fixture.app.request(`/api/projects/${project.slug}/hitl?scope=session&ownerId=${crypto.randomUUID()}&status=pending`);
    expect(missingOwner.status).toBe(404);
    const missingLoopOwner = await fixture.app.request(`/api/projects/${project.slug}/hitl?scope=loop&ownerId=${staleLoopHitl.owner.ownerId}&status=pending`);
    expect(missingLoopOwner.status).toBe(404);
    const missingProject = await fixture.app.request("/api/projects/missing-project/hitl?scope=project&status=pending");
    expect(missingProject.status).toBe(404);

    const legacyGlobalList = await fixture.app.request("/api/hitl?status=pending");
    const legacyGlobalRespond = await fixture.app.request(`/api/hitl/${rootHitl.hitlId}/respond`, { method: "POST" });
    const legacyQuestion = await fixture.app.request("/api/questions/legacy-id", { method: "POST" });
    const legacyPermission = await fixture.app.request("/api/permissions/legacy-id", { method: "POST" });
    expect(legacyGlobalList.status).toBe(404);
    expect(legacyGlobalRespond.status).toBe(404);
    expect(legacyQuestion.status).toBe(404);
    expect(legacyPermission.status).toBe(404);
  });

  test("session HITL store events are not forwarded as display events", async () => {
    const runtime = createRuntimeWithManualSubscriptions();
    const serverRuntime = createServerEventRuntime(runtime);
    const observed: GlobalSSEEvent[] = [];
    const unsubscribeBus = globalEventBus.subscribe((event) => observed.push(event));

    const execution = serverRuntime.startSessionExecution({
      slug: "scoped-sse-project",
      workspaceRoot: "/workspace",
      sessionId: "session-1",
      userMessage: "run",
    });
    runtime.emitSession("session-1", hitlRequestEvent());
    runtime.resolveExecution();
    await execution.promise;
    unsubscribeBus();

    expect(observed).toHaveLength(0);
  });

  test("duplicate canonical respond/cancel is idempotent and conflicting terminal mutation returns current state", async () => {
    const fixture = await createTestApp("duplicate-mutation");
    const project = await addProject(fixture.runtime, "duplicate-mutation", "Duplicate Project");
    const context = await fixture.runtime.contextResolver.resolve(project.workspaceRoot);
    const sessionId = await createSession(fixture, project, {});
    const permission = await createPermissionHitl(context.hitl, project.slug, sessionId, "call-approve");

    const first = await postJson<HitlMutationBody>(fixture.app, `/api/projects/${project.slug}/hitl/${permission.hitlId}/respond`, {
      decision: "approve_once",
      comment: "approved once",
    });
    expect(first.status).toBe(200);
    expect(first.body.hitlId).toBe(permission.hitlId);
    expect(["resume_claimed", "resolved"]).toContain(first.body.status);
    expect(["claimed", "terminal"]).toContain(first.body.resumeStatus);

    const duplicate = await postJson<HitlMutationBody>(fixture.app, `/api/projects/${project.slug}/hitl/${permission.hitlId}/respond`, {
      decision: "approve_once",
      comment: "approved once",
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.hitlId).toBe(permission.hitlId);
    expect(fixture.sessionResumeCalls()).toBe(1);

    const conflicting = await postJson<HitlMutationBody>(fixture.app, `/api/projects/${project.slug}/hitl/${permission.hitlId}/respond`, {
      decision: "deny",
      comment: "changed my mind",
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body).toMatchObject({ hitlId: permission.hitlId });
    expect(fixture.sessionResumeCalls()).toBe(1);

    const invalid = await createPermissionHitl(context.hitl, project.slug, sessionId, "call-invalid");
    const invalidBefore = await context.hitl.lookup(invalid.hitlId);
    expect(invalidBefore.status).toBe("found");
    const invalidRes = await fixture.app.request(`/api/projects/${project.slug}/hitl/${invalid.hitlId}/respond`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved" }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidRes.status).toBe(400);
    expect((await context.hitl.lookup(invalid.hitlId)).status).toBe("found");
    const invalidLookup = await context.hitl.lookup(invalid.hitlId);
    expect(invalidLookup.status === "found" ? invalidLookup.record.status : undefined).toBe("pending");

    const cancellable = await createSessionHitl(context.hitl, project.slug, sessionId, "Cancel duplicate");
    const cancelFirst = await postJson<HitlMutationBody>(fixture.app, `/api/projects/${project.slug}/hitl/${cancellable.hitlId}/cancel`, {
      reason: "No longer needed",
    });
    expect(cancelFirst.status).toBe(200);
    expect(cancelFirst.body.hitlId).toBe(cancellable.hitlId);
    expect(["resume_claimed", "cancelled"]).toContain(cancelFirst.body.status);
    expect(["claimed", "terminal"]).toContain(cancelFirst.body.resumeStatus);

    const cancelDuplicate = await postJson<HitlMutationBody>(fixture.app, `/api/projects/${project.slug}/hitl/${cancellable.hitlId}/cancel`, {
      reason: "No longer needed",
    });
    expect(cancelDuplicate.status).toBe(200);
    expect(cancelDuplicate.body.hitlId).toBe(cancellable.hitlId);
    expect(fixture.sessionResumeCalls()).toBe(2);

    const respondAfterCancel = await postJson<HitlMutationBody>(fixture.app, `/api/projects/${project.slug}/hitl/${cancellable.hitlId}/respond`, {
      answers: ["late answer"],
    });
    expect(respondAfterCancel.status).toBe(409);
    expect(respondAfterCancel.body.hitlId).toBe(cancellable.hitlId);
  });
});

async function createSession(
  fixture: TestFixture,
  project: ProjectInfo,
  options: { rootSessionId?: string; parentSessionId?: string; goalId?: string; loopId?: string },
): Promise<string> {
  const sessionId = crypto.randomUUID();
  fixture.sessionStoreManager.create(sessionId, project.workspaceRoot, options);
  await waitForSessionFile(fixture.runtime, project.workspaceRoot, sessionId);
  return sessionId;
}

async function waitForSessionFile(runtime: AgentRuntime, workspaceRoot: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  const sessionPath = getSessionPath(workspaceRoot, sessionId);
  while (Date.now() < deadline) {
    try {
      if (!(await Bun.file(sessionPath).exists())) {
        throw new Error(`Session file is not persisted yet: ${sessionPath}`);
      }
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(10);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for session ${sessionId}`);
}

async function createGoal(manager: GoalStateManager, projectSlug: string, title: string, loopId?: string) {
  return await manager.create({
    projectId: projectSlug,
    objective: `Exercise HITL route behavior for ${title}.`,
    acceptanceCriteria: "Reviewer can decide DONE from HITL route projections.",
    ...(loopId === undefined ? {} : { loopId }),
  });
}

async function createSessionHitl(hitl: TestHitlService, projectSlug: string, sessionId: string, title: string): Promise<HitlRecord> {
  return await hitl.create({
    owner: { projectSlug, ownerType: "session", ownerId: sessionId },
    blockingKey: `session:${sessionId}:ask:${crypto.randomUUID()}`,
    source: { type: "ask_user", sessionId, toolCallId: crypto.randomUUID() },
    displayPayload: redactedPayload(title),
  });
}

async function createPermissionHitl(hitl: TestHitlService, projectSlug: string, sessionId: string, toolCallId: string): Promise<HitlRecord> {
  return await hitl.create({
    owner: { projectSlug, ownerType: "session", ownerId: sessionId },
    blockingKey: `session:${sessionId}:tool:${toolCallId}`,
    source: { type: "tool_permission", sessionId, toolCallId, toolName: "bash" },
    displayPayload: redactedPayload("Permission for [REDACTED]"),
  });
}

async function createGoalHitl(hitl: TestHitlService, projectSlug: string, goalId: string, title: string): Promise<HitlRecord> {
  return await hitl.create({
    owner: { projectSlug, ownerType: "goal", ownerId: goalId },
    blockingKey: `goal:${goalId}:approval:after_plan:${crypto.randomUUID()}`,
    source: { type: "goal_approval", goalId, approvalPoint: "after_plan" },
    displayPayload: redactedPayload(title),
  });
}

async function createLoopHitl(hitl: TestHitlService, projectSlug: string, loopId: string, title: string): Promise<HitlRecord> {
  return await hitl.create({
    owner: { projectSlug, ownerType: "loop", ownerId: loopId },
    blockingKey: `loop:${loopId}:approval:manual:${crypto.randomUUID()}`,
    source: { type: "loop_approval", loopId, approvalPoint: "manual" },
    displayPayload: redactedPayload(title),
  });
}

function redactedPayload(title: string): HitlDisplayPayload {
  return {
    title,
    summary: "Display-safe payload with [REDACTED] secret",
    fields: [{ label: "details", value: "[REDACTED]" }],
    redacted: true,
  };
}

function createRuntimeWithManualSubscriptions() {
  const subscriptions = new Map<string, (event: GlobalSSEEvent) => void>();
  const hitlSubscriptions = new Set<(event: Extract<GlobalSSEEvent, { type: "hitl.event" }>) => void>();
  let resolveExecution!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveExecution = resolve;
  });

  const runtime = {
    subscribeSessionEvents: mock((input: { sessionId: string; onEvent: (event: GlobalSSEEvent) => void }) => {
      subscriptions.set(input.sessionId, input.onEvent);
      return () => subscriptions.delete(input.sessionId);
    }),
    subscribeHitlEvents: mock((listener: (event: Extract<GlobalSSEEvent, { type: "hitl.event" }>) => void) => {
      hitlSubscriptions.add(listener);
      return () => hitlSubscriptions.delete(listener);
    }),
    startSessionExecution: mock(() => ({ promise })),
    emitSession: (sessionId: string, event: GlobalSSEEvent) => subscriptions.get(sessionId)?.(event),
    emitHitl: (event: Extract<GlobalSSEEvent, { type: "hitl.event" }>) => hitlSubscriptions.forEach((listener) => listener(event)),
    resolveExecution: () => resolveExecution(),
  };

  return runtime as unknown as AgentRuntime & {
    emitSession: (sessionId: string, event: GlobalSSEEvent) => void;
    emitHitl: (event: Extract<GlobalSSEEvent, { type: "hitl.event" }>) => void;
    resolveExecution: () => void;
  };
}

function hitlRequestEvent(): GlobalSSEEvent {
  return {
    type: "event",
    slug: "scoped-sse-project",
    sessionId: "session-1",
    eventId: 1,
    createdAt: 42,
    kind: "hitl.request",
    agentName: "orchestrator",
    payload: {
      type: "hitl.request",
      request: {
        hitlId: "hitl-sse-1",
        owner: { projectSlug: "scoped-sse-project", ownerType: "session", ownerId: "session-1" },
        blockingKey: "session:session-1:ask:call-1",
        source: { type: "ask_user", sessionId: "session-1", toolCallId: "call-1" },
        status: "pending",
        displayPayload: redactedPayload("Do not forward this payload"),
        createdAt: new Date(42).toISOString(),
        updatedAt: new Date(42).toISOString(),
      },
    },
  };
}

async function getHitl(app: TestFixture["app"], path: string): Promise<HitlListBody> {
  const res = await app.request(path);
  const body = await res.json() as HitlListBody;
  expect(res.status).toBe(200);
  return {
    hitl: [...body.hitl].sort((left, right) => left.hitlId.localeCompare(right.hitlId)),
  };
}

async function postJson<T>(app: TestFixture["app"], path: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const res = await app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return { status: res.status, body: await res.json() as T };
}

function expectHitlListIsDisplaySafe(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain('"payload"');
  expect(serialized).not.toContain('"checkpoint"');
  expect(serialized).not.toContain('"input"');
  expect(serialized).not.toContain("sk-test");
  expect(serialized).toContain('"displayPayload"');
  expect(serialized).toContain("[REDACTED]");
}
