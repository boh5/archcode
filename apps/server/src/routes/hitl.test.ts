import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { GlobalSSEEvent, HitlDisplayPayload, HitlIdentity, HitlProjection, HitlRecord } from "@archcode/protocol";
import { ProjectContextResolver, ProjectRegistry, silentLogger } from "@archcode/agent-core";
import type { AgentRuntime, ProjectContext, ProjectInfo } from "@archcode/agent-core";
import { GoalStateManager } from "../../../../packages/agent-core/src/goals/state";
import { createPreparedHitlResume, ResumeCoordinator, type SessionHitlResumeAdapter } from "../../../../packages/agent-core/src/hitl/resume-coordinator";
import { SessionStoreManager } from "../../../../packages/agent-core/src/store/session-store-manager";
import { getSessionPath } from "../../../../packages/agent-core/src/store/sessions-dir";
import { createServerApp, createServerEventRuntime } from "../app";
import { globalEventBus } from "../events/global-event-bus";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "hitl-routes");

type HitlListBody = { hitl: HitlProjection[] };
type HitlMutationBody = { hitlId: string; status: string; hitl: HitlProjection };
type TestHitlService = ProjectContext["hitl"];

interface TestFixture {
  app: ReturnType<typeof createServerApp>["app"];
  runtime: AgentRuntime;
  sessionStoreManager: SessionStoreManager;
  sessionResumeCalls: () => number;
}

function createTestRuntime(projectRegistry: ProjectRegistry): Omit<TestFixture, "app"> {
  const sessionStoreManager = new SessionStoreManager({ logger: silentLogger });
  let sessionResumeCalls = 0;
  const sessionAdapter: SessionHitlResumeAdapter = {
    async prepare() {
      return createPreparedHitlResume(async () => {
        sessionResumeCalls += 1;
      });
    },
  };
  const contextResolver = new ProjectContextResolver({
    projectInfoFactory: async (workspaceRoot) => {
      const project = await projectRegistry.getByWorkspace(workspaceRoot);
      if (project === undefined) throw new Error(`Project is not registered: ${workspaceRoot}`);
      return project;
    },
    goalCancellationFactory: ({ goalState }) => ({
      cancel: async (goalId, request) => await goalState.cancel(goalId, request.reason),
    }),
    goalRunnerFactory: () => ({}) as never,
    createAutomation: mock(async () => {
      throw new Error("not implemented");
    }),
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
    subscribeSessionRuntimeChanges: mock(() => () => undefined),
    subscribeMcpStatusChanges: mock(() => () => undefined),
    getMcpServerStatuses: mock(() => new Map()),
    createSession: mock(async (workspaceRoot: string) => sessionStoreManager.createSessionFile(workspaceRoot, { agentName: "engineer" })),
    getSessionFile: mock(async (workspaceRoot: string, sessionId: string) => sessionStoreManager.getSessionFile(workspaceRoot, sessionId)),
    listSessions: mock(async (workspaceRoot: string) => sessionStoreManager.listSessionSummaries(workspaceRoot)),
    startSessionExecution: mock(() => {
      throw new Error("not implemented");
    }),
    stopSessionFamily: mock(async () => undefined),
    abortAllSessionExecutions: mock(async () => undefined),
    getSessionFamilyActivity: mock(() => "idle" as const),
    getSessionExecution: mock(() => undefined),
    subscribeSessionEvents: mock(() => () => undefined),
    deleteSession: mock(async () => undefined),
    listSessionTree: mock(async (workspaceRoot: string, rootSessionId: string) => sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId)),
    disposeSessionAgent: mock(() => undefined),
    disposeAllSessionAgents: mock(() => undefined),
    isSessionTombstoned: mock(() => false),
    dispatchCommand: mock(async () => null),
    listAutomations: mock(async () => []),
    readAutomation: mock(async () => {
      throw new Error("not implemented");
    }),
    createAutomation: mock(async () => {
      throw new Error("not implemented");
    }),
    updateAutomation: mock(async () => {
      throw new Error("not implemented");
    }),
    deleteAutomation: mock(async () => undefined),
    pauseAutomation: mock(async () => {
      throw new Error("not implemented");
    }),
    resumeAutomation: mock(async () => {
      throw new Error("not implemented");
    }),
    runAutomationNow: mock(async () => {
      throw new Error("not implemented");
    }),
    listAutomationInvocations: mock(async () => []),
    startAutomationSchedulers: mock(async () => undefined),
    stopAutomationSchedulers: mock(async () => undefined),
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

  test("scoped canonical route lists project/session/goal HITL and redacts payloads", async () => {
    const fixture = await createTestApp("scoped-list");
    const project = await addProject(fixture.runtime, "scoped-list", "Scoped Project");
    const context = await fixture.runtime.contextResolver.resolve(project.workspaceRoot);

    const rootSessionId = await createSession(fixture, project, { agentName: "engineer" });
    const childSessionId = await createSession(fixture, project, { agentName: "explore", rootSessionId, parentSessionId: rootSessionId });
    const rootHitl = await createSessionHitl(context.hitl, project.slug, rootSessionId, "Root session question");
    const childHitl = await createSessionHitl(context.hitl, project.slug, childSessionId, "Child session question");

    const goal = await createGoal(context.goalState, project.slug, "Scoped Goal");
    const goalSessionId = await createSession(fixture, project, { agentName: "goal_lead", goalId: goal.id });
    const goalChildSessionId = await createSession(fixture, project, { agentName: "explore", rootSessionId: goalSessionId, parentSessionId: goalSessionId, goalId: goal.id });
    const goalHitl = await createGoalHitl(context.hitl, project.slug, goal.id, "Goal approval");
    const goalSessionHitl = await createSessionHitl(context.hitl, project.slug, goalSessionId, "Goal child session");
    const goalGrandchildHitl = await createSessionHitl(context.hitl, project.slug, goalChildSessionId, "Goal grandchild session");

    const projectList = await getHitl(fixture.app, `/api/projects/${project.slug}/hitl?scope=project&status=pending`);
    expect(projectList.hitl.map((item) => item.hitlId)).toEqual([
      childHitl.hitlId,
      goalGrandchildHitl.hitlId,
      goalSessionHitl.hitlId,
      rootHitl.hitlId,
      goalHitl.hitlId,
    ].sort());
    expectHitlListIsDisplaySafe(projectList);

    const sessionList = await getHitl(fixture.app, `/api/projects/${project.slug}/hitl?scope=session&ownerId=${rootSessionId}&includeChildren=true&status=pending`);
    expect(sessionList.hitl.map((item) => item.hitlId)).toEqual([childHitl.hitlId, rootHitl.hitlId].sort());

    const goalList = await getHitl(fixture.app, `/api/projects/${project.slug}/hitl?scope=goal&ownerId=${goal.id}&includeChildren=true&status=pending`);
    expect(goalList.hitl.map((item) => item.hitlId)).toEqual([goalGrandchildHitl.hitlId, goalHitl.hitlId, goalSessionHitl.hitlId].sort());

    const missingOwner = await fixture.app.request(`/api/projects/${project.slug}/hitl?scope=session&ownerId=${crypto.randomUUID()}&status=pending`);
    expect(missingOwner.status).toBe(404);
    const missingProject = await fixture.app.request("/api/projects/missing-project/hitl?scope=project&status=pending");
    expect(missingProject.status).toBe(404);

    const legacyGlobalList = await fixture.app.request("/api/hitl?status=pending");
    const legacyGlobalRespond = await fixture.app.request(`/api/hitl/${rootHitl.hitlId}/respond`, { method: "POST" });
    const legacyProjectRespond = await fixture.app.request(`/api/projects/${project.slug}/hitl/${rootHitl.hitlId}/respond`, { method: "POST" });
    const legacyQuestion = await fixture.app.request("/api/questions/legacy-id", { method: "POST" });
    const legacyPermission = await fixture.app.request("/api/permissions/legacy-id", { method: "POST" });
    expect(legacyGlobalList.status).toBe(404);
    expect(legacyGlobalRespond.status).toBe(404);
    expect(legacyProjectRespond.status).toBe(404);
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
    const sessionId = await createSession(fixture, project, { agentName: "engineer" });
    const permission = await createPermissionHitl(context.hitl, project.slug, sessionId, "call-approve");

    const first = await postJson<HitlMutationBody>(fixture.app, mutationUrl(permission, "respond"), {
      type: "permission_decision",
      decision: "approve_once",
      comment: "approved once",
    });
    expect(first.status).toBe(200);
    expect(first.body.hitlId).toBe(permission.hitlId);
    expect(first.body.status).toBe("answered");

    const duplicate = await postJson<HitlMutationBody>(fixture.app, mutationUrl(permission, "respond"), {
      type: "permission_decision",
      decision: "approve_once",
      comment: "approved once",
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.hitlId).toBe(permission.hitlId);
    expect(fixture.sessionResumeCalls()).toBe(1);

    const conflicting = await postJson<HitlMutationBody>(fixture.app, mutationUrl(permission, "respond"), {
      type: "permission_decision",
      decision: "deny",
      comment: "changed my mind",
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body).toMatchObject({ hitlId: permission.hitlId });
    expect(fixture.sessionResumeCalls()).toBe(1);

    const invalid = await createPermissionHitl(context.hitl, project.slug, sessionId, "call-invalid");
    const invalidBefore = await context.hitl.lookup(identity(invalid));
    expect(invalidBefore.status).toBe("found");
    const invalidRes = await fixture.app.request(mutationUrl(invalid, "respond"), {
      method: "POST",
      body: JSON.stringify({ type: "permission_decision", decision: "approved" }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidRes.status).toBe(400);
    expect((await context.hitl.lookup(identity(invalid))).status).toBe("found");
    const invalidLookup = await context.hitl.lookup(identity(invalid));
    expect(invalidLookup.status === "found" ? invalidLookup.record.status : undefined).toBe("pending");

    const cancellable = await createSessionHitl(context.hitl, project.slug, sessionId, "Cancel duplicate");
    const cancelFirst = await postJson<HitlMutationBody>(fixture.app, mutationUrl(cancellable, "cancel"), {
      reason: "No longer needed",
    });
    expect(cancelFirst.status).toBe(200);
    expect(cancelFirst.body.hitlId).toBe(cancellable.hitlId);
    expect(cancelFirst.body.status).toBe("answered");

    const cancelDuplicate = await postJson<HitlMutationBody>(fixture.app, mutationUrl(cancellable, "cancel"), {
      reason: "No longer needed",
    });
    expect(cancelDuplicate.status).toBe(200);
    expect(cancelDuplicate.body.hitlId).toBe(cancellable.hitlId);
    expect(fixture.sessionResumeCalls()).toBe(2);

    await waitForHitlStatus(context.hitl, cancellable, "cancelled");
    const respondAfterCancel = await postJson<HitlMutationBody>(fixture.app, mutationUrl(cancellable, "respond"), {
      type: "question_answer",
      answers: ["late answer"],
    });
    expect(respondAfterCancel.status).toBe(409);
    expect(respondAfterCancel.body.hitlId).toBe(cancellable.hitlId);
  });

  test("owner-qualified route keeps duplicate ids visible and mutates only its owner", async () => {
    const fixture = await createTestApp("owner-qualified-mutation");
    const project = await addProject(fixture.runtime, "owner-qualified-mutation", "Owner Qualified Project");
    const context = await fixture.runtime.contextResolver.resolve(project.workspaceRoot);
    const firstSessionId = await createSession(fixture, project, { agentName: "engineer" });
    const secondSessionId = await createSession(fixture, project, { agentName: "engineer" });
    const hitlId = "owner-local-shared-id";
    const first = await context.hitl.create({
      owner: { projectSlug: project.slug, ownerType: "session", ownerId: firstSessionId },
      sessionRootId: firstSessionId,
      hitlId,
      blockingKey: "first-owner-shared-id",
      source: { type: "ask_user", sessionId: firstSessionId },
      displayPayload: redactedPayload("First owner"),
    });
    const second = await context.hitl.create({
      owner: { projectSlug: project.slug, ownerType: "session", ownerId: secondSessionId },
      sessionRootId: secondSessionId,
      hitlId,
      blockingKey: "second-owner-shared-id",
      source: { type: "ask_user", sessionId: secondSessionId },
      displayPayload: redactedPayload("Second owner"),
    });

    const list = await getHitl(fixture.app, `/api/projects/${project.slug}/hitl?scope=project&status=pending`);
    expect(list.hitl.filter((projection) => projection.hitlId === hitlId)).toHaveLength(2);

    const response = await postJson<HitlMutationBody>(fixture.app, mutationUrl(first, "respond"), {
      type: "question_answer",
      answers: ["first only"],
    });
    expect(response.status).toBe(200);
    await waitForHitlStatus(context.hitl, first, "resolved");
    expect(await context.hitl.lookup(identity(second))).toMatchObject({
      status: "found",
      record: { status: "pending", owner: second.owner },
    });
  });

  test("respond requires an explicit protocol discriminant and cancel rejects malformed JSON", async () => {
    const fixture = await createTestApp("strict-hitl-mutations");
    const project = await addProject(fixture.runtime, "strict-hitl-mutations", "Strict HITL Project");
    const context = await fixture.runtime.contextResolver.resolve(project.workspaceRoot);
    const sessionId = await createSession(fixture, project, { agentName: "engineer" });
    const missingType = await createPermissionHitl(context.hitl, project.slug, sessionId, "missing-type");

    const missingTypeResponse = await fixture.app.request(mutationUrl(missingType, "respond"), {
      method: "POST",
      body: JSON.stringify({ decision: "approve_once" }),
      headers: { "content-type": "application/json" },
    });
    expect(missingTypeResponse.status).toBe(400);

    const valid = await createPermissionHitl(context.hitl, project.slug, sessionId, "explicit-type");
    const validResponse = await postJson<HitlMutationBody>(fixture.app, mutationUrl(valid, "respond"), {
      type: "permission_decision",
      decision: "approve_once",
    });
    expect(validResponse.status).toBe(200);

    const wrongVariant = await createPermissionHitl(context.hitl, project.slug, sessionId, "wrong-variant");
    const wrongVariantResponse = await fixture.app.request(mutationUrl(wrongVariant, "respond"), {
      method: "POST",
      body: JSON.stringify({ type: "approval_decision", decision: "approved" }),
      headers: { "content-type": "application/json" },
    });
    expect(wrongVariantResponse.status).toBe(400);
    expect(await context.hitl.lookup(identity(wrongVariant))).toMatchObject({
      status: "found",
      record: { status: "pending" },
    });

    const unknownField = await createPermissionHitl(context.hitl, project.slug, sessionId, "unknown-field");
    const unknownFieldResponse = await fixture.app.request(mutationUrl(unknownField, "respond"), {
      method: "POST",
      body: JSON.stringify({ type: "permission_decision", decision: "approve_once", legacyPayload: true }),
      headers: { "content-type": "application/json" },
    });
    expect(unknownFieldResponse.status).toBe(400);
    expect(await context.hitl.lookup(identity(unknownField))).toMatchObject({
      status: "found",
      record: { status: "pending" },
    });

    const malformedCancel = await createSessionHitl(context.hitl, project.slug, sessionId, "Malformed cancel");
    const malformedResponse = await fixture.app.request(mutationUrl(malformedCancel, "cancel"), {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });
    expect(malformedResponse.status).toBe(400);
    expect(await context.hitl.lookup(identity(malformedCancel))).toMatchObject({
      status: "found",
      record: { status: "pending" },
    });

    const emptyCancel = await createSessionHitl(context.hitl, project.slug, sessionId, "Empty cancel");
    const emptyResponse = await fixture.app.request(mutationUrl(emptyCancel, "cancel"), { method: "POST" });
    expect(emptyResponse.status).toBe(200);
  });

  test("a second mutation cannot replace a durably answered session HITL", async () => {
    const fixture = await createTestApp("answered-conflict");
    const project = await addProject(fixture.runtime, "answered-conflict", "Answered Conflict Project");
    const context = await fixture.runtime.contextResolver.resolve(project.workspaceRoot);
    const sessionId = await createSession(fixture, project, { agentName: "engineer" });
    const hitl = await createSessionHitl(context.hitl, project.slug, sessionId, "Unknown continuation");

    await context.hitl.claim(identity(hitl), { type: "question_answer", answers: ["continue"] }, {
      claimId: crypto.randomUUID(),
      claimedAt: new Date().toISOString(),
      intent: "respond",
      attempt: 1,
    });
    const cancelled = await postJson<HitlMutationBody>(fixture.app, mutationUrl(hitl, "cancel"), {
      reason: "replace the existing answer",
    });

    expect(cancelled.status).toBe(409);
    expect(cancelled.body.hitlId).toBe(hitl.hitlId);
    expect(cancelled.body.status).toBe("answered");
    expect(await context.hitl.lookup(identity(hitl))).toMatchObject({
      status: "found",
      record: { response: { type: "question_answer", answers: ["continue"] } },
    });
    expect(fixture.sessionResumeCalls()).toBe(0);
  });
});

async function createSession(
  fixture: TestFixture,
  project: ProjectInfo,
  options: { agentName: "engineer" | "goal_lead" | "plan" | "explore"; rootSessionId?: string; parentSessionId?: string; goalId?: string },
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

async function waitForHitlStatus(
  hitl: TestHitlService,
  record: Pick<HitlRecord, "owner" | "hitlId">,
  status: HitlRecord["status"],
): Promise<void> {
  const deadline = Date.now() + 2_000;
  let latest = "missing";
  while (Date.now() < deadline) {
    const lookup = await hitl.lookup(identity(record));
    latest = lookup.status === "found" ? lookup.record.status : lookup.status;
    if (latest === status) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for HITL ${record.hitlId} to become ${status}; latest status was ${latest}`);
}

function identity(record: Pick<HitlRecord, "owner" | "hitlId">): HitlIdentity {
  return { owner: record.owner, hitlId: record.hitlId };
}

function mutationUrl(record: Pick<HitlRecord, "owner" | "hitlId">, action: "respond" | "cancel"): string {
  const { owner, hitlId } = record;
  return `/api/projects/${encodeURIComponent(owner.projectSlug)}/hitl/${owner.ownerType}/${encodeURIComponent(owner.ownerId)}/${encodeURIComponent(hitlId)}/${action}`;
}

async function createGoal(manager: GoalStateManager, projectSlug: string, title: string) {
  const goalId = crypto.randomUUID();
  return await manager.commit({
    id: goalId,
    projectId: projectSlug,
    createdFromSessionId: crypto.randomUUID(),
    objective: `Exercise HITL route behavior for ${title}.`,
    acceptanceCriteria: "Reviewer can decide DONE from HITL route projections.",
    mainSessionId: crypto.randomUUID(),
  });
}

async function createSessionHitl(hitl: TestHitlService, projectSlug: string, sessionId: string, title: string): Promise<HitlRecord> {
  return await hitl.create({
    owner: { projectSlug, ownerType: "session", ownerId: sessionId },
    sessionRootId: sessionId,
    blockingKey: `session:${sessionId}:ask:${crypto.randomUUID()}`,
    source: { type: "ask_user", sessionId, toolCallId: crypto.randomUUID() },
    displayPayload: redactedPayload(title),
  });
}

async function createPermissionHitl(hitl: TestHitlService, projectSlug: string, sessionId: string, toolCallId: string): Promise<HitlRecord> {
  return await hitl.create({
    owner: { projectSlug, ownerType: "session", ownerId: sessionId },
    sessionRootId: sessionId,
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
    agentName: "engineer",
    payload: {
      type: "hitl.request",
      request: {
        hitlId: "hitl-sse-1",
        owner: { projectSlug: "scoped-sse-project", ownerType: "session", ownerId: "session-1" },
        sessionRootId: "session-1",
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
