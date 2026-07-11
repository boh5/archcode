import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import type { HitlIdentity } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { SessionFamilyActiveError } from "../execution/session-family-control";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import { SessionExecutionManager } from "../execution/session-execution-manager";
import { HitlService } from "../hitl/service";
import { createPreparedHitlResume, ResumeCoordinator } from "../hitl/resume-coordinator";
import { LoopStateManager, type LoopConfig } from "../loops/state";
import { MemoryFileManager } from "../memory/file-manager";
import { SessionStoreManager } from "../store/session-store-manager";
import type { PermissionApprovalScope } from "../tools/permission/policy-types";
import { silentLogger } from "../logger";
import { ProjectApprovalManager } from "../tools/permission/project-approvals";
import { ProjectContextResolver, type ProjectContextResolverOptions } from "./context-resolver";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "context-resolver");

const TEST_SCOPE: PermissionApprovalScope = {
  kind: "tool-operation",
  toolName: "file_write",
  operation: "write",
};

const LOOP_CONFIG: LoopConfig = {
  templateId: "watch_report",
  title: "Project loop",
  schedule: { kind: "interval", everyMs: 60_000 },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 5, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
  taskPrompt: "Summarize local project state.",
  useWorktree: false,
};

async function makeWorkspace(name: string): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true });
  return await mkdtemp(join(TMP_ROOT, `${name}-`));
}

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

function createResolver(overrides: Partial<ProjectContextResolverOptions> = {}): ProjectContextResolver {
  return new ProjectContextResolver({
    projectInfoFactory: (workspaceRoot) => {
      const name = basename(workspaceRoot);
      return { slug: name, name, workspaceRoot, addedAt: new Date().toISOString() };
    },
    goalCancellationFactory: ({ goalState }) => ({
      cancel: async (goalId, request) => await goalState.cancel(goalId, request.reason),
    }),
    sessionStoreManager: new SessionStoreManager({ logger: silentLogger }),
    resumeCoordinatorFactory: ({ hitl }) => new ResumeCoordinator({
      hitl,
      adapters: {
        session: { prepare: async () => createPreparedHitlResume(async () => undefined) },
        goal: { prepare: async () => createPreparedHitlResume(async () => undefined) },
        loop: { prepare: async () => createPreparedHitlResume(async () => undefined) },
      },
      logger: silentLogger,
    }),
    ...overrides,
  });
}

describe("ProjectContextResolver", () => {
  test("resolve returns the same context object for the same workspace", async () => {
    const workspace = await makeWorkspace("identity");
    const resolver = createResolver();

    const first = await resolver.resolve(workspace);
    const second = await resolver.resolve(workspace);

    expect(first).toBe(second);
  });

  test("different workspaces produce different contexts and approval managers", async () => {
    const workspaceA = await makeWorkspace("workspace-a");
    const workspaceB = await makeWorkspace("workspace-b");
    const resolver = createResolver();

    const contextA = await resolver.resolve(workspaceA);
    const contextB = await resolver.resolve(workspaceB);

    expect(contextA).not.toBe(contextB);
    expect(contextA.approvals).not.toBe(contextB.approvals);
  });

  test("dispose removes the cached context so the next resolve creates a fresh context", async () => {
    const workspace = await makeWorkspace("dispose");
    const resolver = createResolver();

    const first = await resolver.resolve(workspace);
    resolver.dispose(workspace);
    const second = await resolver.resolve(workspace);

    expect(second).not.toBe(first);
    expect(second.goalState).not.toBe(first.goalState);
    expect(second.loopState).not.toBe(first.loopState);
    expect(second.hitl).not.toBe(first.hitl);
    expect(second.memory).not.toBe(first.memory);
    expect(second.approvals).not.toBe(first.approvals);
  });

  test("dispose shuts down the old HITL publisher before returning", async () => {
    const workspace = await makeWorkspace("dispose-hitl");
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspace);
    await sessions.flushSession(sessionId, workspace);
    const events: string[] = [];
    const resolver = createResolver({
      sessionStoreManager: sessions,
      hitlFactory: (input) => new HitlService({
        ...input,
        realtimePublisher: (event) => events.push(event.projectSlug),
      }),
    });
    const first = await resolver.resolve(workspace);
    const record = await first.hitl.create({
      owner: { projectSlug: first.project.slug, ownerType: "session", ownerId: sessionId },
      sessionRootId: sessionId,
      blockingKey: `session:${sessionId}:dispose`,
      source: { type: "ask_user", sessionId, toolCallId: "dispose" },
      displayPayload: { title: "Continue?", redacted: true },
    });

    await resolver.dispose(workspace);
    await first.hitl.publishRequest(record);

    expect(events).toEqual([]);
  });

  test("fresh context migrates active and terminal owner history when the same workspace gets a new slug", async () => {
    const workspace = await makeWorkspace("slug-migration");
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspace);
    await sessions.flushSession(sessionId, workspace);
    let projectSlug = "old-project";
    const resolver = createResolver({
      sessionStoreManager: sessions,
      projectInfoFactory: () => ({
        slug: projectSlug,
        name: projectSlug,
        workspaceRoot: workspace,
        addedAt: new Date().toISOString(),
      }),
    });
    const first = await resolver.resolve(workspace);
    const oldOwner = { projectSlug, ownerType: "session" as const, ownerId: sessionId };
    const pending = await first.hitl.create({
      owner: oldOwner,
      sessionRootId: sessionId,
      hitlId: "pending-history-id",
      blockingKey: `session:${sessionId}:pending`,
      source: { type: "ask_user", sessionId, toolCallId: "pending" },
      displayPayload: { title: "Pending", redacted: true },
    });
    const terminal = await first.hitl.create({
      owner: oldOwner,
      sessionRootId: sessionId,
      hitlId: "terminal-history-id",
      blockingKey: `session:${sessionId}:terminal`,
      source: { type: "ask_user", sessionId, toolCallId: "terminal" },
      displayPayload: { title: "Terminal", redacted: true },
    });
    await first.hitl.complete(
      { owner: oldOwner, hitlId: terminal.hitlId },
      { type: "cancel", reason: "preserve history" },
    );
    await resolver.dispose(workspace);

    projectSlug = "new-project";
    const second = await resolver.resolve(workspace);
    const nextOwner = { ...oldOwner, projectSlug };
    const records = await second.hitl.list({ scope: "project", status: "all" });

    expect(second).not.toBe(first);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ hitlId: pending.hitlId, owner: nextOwner, status: "pending" }),
      expect.objectContaining({ hitlId: terminal.hitlId, owner: nextOwner, status: "resolved" }),
    ]));
    expect(await second.hitl.lookup({ owner: nextOwner, hitlId: pending.hitlId })).toMatchObject({
      status: "found",
      record: { hitlId: pending.hitlId, blockingKey: pending.blockingKey, owner: nextOwner },
    });
  });

  test("concurrent resolve calls load approvals once per unique workspace", async () => {
    const workspaceA = await makeWorkspace("concurrent-a");
    const workspaceB = await makeWorkspace("concurrent-b");
    const loadCalls: string[] = [];
    const loadMock = mock(async (manager: ProjectApprovalManager, workspaceRoot: string) => {
      loadCalls.push(workspaceRoot);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await ProjectApprovalManager.prototype.load.call(manager, workspaceRoot);
    });

    class CountingProjectApprovalManager extends ProjectApprovalManager {
      override async load(workspaceRoot: string): Promise<void> {
        await loadMock(this, workspaceRoot);
      }
    }

    const resolver = createResolver({
      approvalsFactory: () => new CountingProjectApprovalManager(silentLogger),
    });

    const [firstA, secondA, firstB] = await Promise.all([
      resolver.resolve(workspaceA),
      resolver.resolve(workspaceA),
      resolver.resolve(workspaceB),
    ]);

    expect(firstA).toBe(secondA);
    expect(firstA).not.toBe(firstB);
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(loadCalls.filter((workspace) => workspace === workspaceA)).toHaveLength(1);
    expect(loadCalls.filter((workspace) => workspace === workspaceB)).toHaveLength(1);
  });

  test("isolation scenario keeps approvals scoped to their workspace", async () => {
    const workspaceA = await makeWorkspace("isolation-a");
    const workspaceB = await makeWorkspace("isolation-b");
    const resolver = createResolver();

    const contextA = await resolver.resolve(workspaceA);
    const contextB = await resolver.resolve(workspaceB);

    await contextA.approvals.addApproval(TEST_SCOPE, {
      display: "Test approval",
      reason: "Verify project isolation",
    });

    expect(contextA.approvals.hasApproval(TEST_SCOPE)).toBe(true);
    expect(contextB.approvals.hasApproval(TEST_SCOPE)).toBe(false);
    expect((await resolver.resolve(workspaceB)).approvals.hasApproval(TEST_SCOPE)).toBe(false);
  });

  test("default manager factories use explicitly supplied project info", async () => {
    const workspace = await makeWorkspace("defaults");
    const resolver = createResolver();

    const context = await resolver.resolve(workspace);

    expect(context.goalState).toBeInstanceOf(GoalStateManager);
    expect(context.loopState).toBeInstanceOf(LoopStateManager);
    expect(context.hitl).toBeInstanceOf(HitlService);
    expect(context.hitlResumeCoordinator).toBeInstanceOf(ResumeCoordinator);
    expect(context.memory).toBeInstanceOf(MemoryFileManager);
    expect(context.memory.projectRoot).toBe(join(workspace, ".archcode", "memory"));
    expect(context.project.slug).toBe(basename(workspace));
    expect(context.project.name).toBe(context.project.slug);
    expect(context.project.workspaceRoot).toBe(workspace);
    expect(context.project.lastOpenedAt).toBeUndefined();
    expect(new Date(context.project.addedAt).toString()).not.toBe("Invalid Date");
  });

  test("projectInfoFactory supplies registry-backed contexts", async () => {
    const workspace = await makeWorkspace("registry-info");
    const projectInfo = {
      slug: "registry-slug",
      name: "Registry Project",
      workspaceRoot: workspace,
      addedAt: new Date().toISOString(),
    };
    const resolver = createResolver({
      projectInfoFactory: mock((workspaceRoot: string) => {
        expect(workspaceRoot).toBe(workspace);
        return projectInfo;
      }),
    });

    const context = await resolver.resolve(workspace);

    expect(context.project).toEqual(projectInfo);
  });

  test("project contexts expose Goal/HITL services and no active Workflow managers", async () => {
    const workspace = await makeWorkspace("goal-hitl-shape");
    const resolver = createResolver();

    const context = await resolver.resolve(workspace);
    const contextRecord = context as unknown as Record<string, unknown>;

    expect(context.goalState).toBeInstanceOf(GoalStateManager);
    expect(context.hitl).toBeInstanceOf(HitlService);
    expect(context.hitlResumeCoordinator).toBeInstanceOf(ResumeCoordinator);
    expect(contextRecord.goalArtifacts).toBeUndefined();
    expect(contextRecord.goalMemory).toBeUndefined();
    expect(contextRecord.workflowState).toBeUndefined();
    expect(contextRecord.artifacts).toBeUndefined();
  });

  test("loops are isolated under each workspace .archcode/loops directory", async () => {
    const workspaceA = await makeWorkspace("loops-a");
    const workspaceB = await makeWorkspace("loops-b");
    const resolver = createResolver();

    const contextA = await resolver.resolve(workspaceA);
    const contextB = await resolver.resolve(workspaceB);

    const loopA = await contextA.loopState.create(contextA.project.slug, LOOP_CONFIG);
    const loopB = await contextB.loopState.create(contextB.project.slug, LOOP_CONFIG);

    expect((await contextA.loopState.list(contextA.project.slug)).map((loop) => loop.loopId)).toEqual([loopA.loopId]);
    expect((await contextB.loopState.list(contextB.project.slug)).map((loop) => loop.loopId)).toEqual([loopB.loopId]);
    expect(await Bun.file(join(workspaceA, ".archcode", "loops", loopA.loopId, "state.json")).exists()).toBe(true);
    expect(await Bun.file(join(workspaceB, ".archcode", "loops", loopB.loopId, "state.json")).exists()).toBe(true);
    expect(await Bun.file(join(workspaceB, ".archcode", "loops", loopA.loopId, "state.json")).exists()).toBe(false);

    resolver.dispose(workspaceA);
    const recreatedA = await resolver.resolve(workspaceA);

    expect(recreatedA.loopState).not.toBe(contextA.loopState);
    expect((await recreatedA.loopState.list(contextA.project.slug)).map((loop) => loop.loopId)).toEqual([loopA.loopId]);
  });

  test("goals are isolated under each workspace .archcode/goals directory", async () => {
    const workspaceA = await makeWorkspace("goals-a");
    const workspaceB = await makeWorkspace("goals-b");
    const resolver = createResolver();

    const contextA = await resolver.resolve(workspaceA);
    const contextB = await resolver.resolve(workspaceB);

    const goalA = await contextA.goalState.create({ projectId: contextA.project.slug, objective: "A objective", acceptanceCriteria: "A criteria" });
    const goalB = await contextB.goalState.create({ projectId: contextB.project.slug, objective: "B objective", acceptanceCriteria: "B criteria" });

    expect((await contextA.goalState.listGoals()).map((goal) => goal.id)).toEqual([goalA.id]);
    expect((await contextB.goalState.listGoals()).map((goal) => goal.id)).toEqual([goalB.id]);
    expect(await Bun.file(join(workspaceA, ".archcode", "goals", goalA.id, "goal.json")).exists()).toBe(true);
    expect(await Bun.file(join(workspaceB, ".archcode", "goals", goalB.id, "goal.json")).exists()).toBe(true);
    expect(await Bun.file(join(workspaceB, ".archcode", "goals", goalA.id, "goal.json")).exists()).toBe(false);
  });

  test("owner-local HITL is loaded from the project workspace after context recreation", async () => {
    const workspace = await makeWorkspace("hitl-reload");
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const resolver = createResolver({ sessionStoreManager: sessions });
    const first = await resolver.resolve(workspace);
    const goal = await first.goalState.create({ projectId: first.project.slug, objective: "Get approval", acceptanceCriteria: "HITL persists" });

    const created = await first.hitl.create({
      owner: { projectSlug: first.project.slug, ownerType: "goal", ownerId: goal.id },
      blockingKey: `goal:${goal.id}:approval:after_plan`,
      source: { type: "goal_approval", goalId: goal.id, approvalPoint: "after_plan", resumeStatus: "running" },
      displayPayload: { title: "Continue?", redacted: true },
    });
    expect(created).toBeDefined();

    resolver.dispose(workspace);
    const second = await resolver.resolve(workspace);

    expect(second.hitl).not.toBe(first.hitl);
    expect(await second.hitl.lookup({ owner: created.owner, hitlId: created.hitlId })).toMatchObject({
      status: "found",
      record: { hitlId: created.hitlId, status: "pending" },
    });
  });

  test("missing adapter composition durably fails claimed HITL resumes", async () => {
    const workspace = await makeWorkspace("hitl-claimed-no-adapter");
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspace);
    await waitForSession(workspace, sessionId);
    const resolver = createResolver({
      sessionStoreManager: sessions,
      resumeCoordinatorFactory: ({ hitl }) => new ResumeCoordinator({ hitl, adapters: {}, logger: silentLogger }),
    });
    const first = await resolver.resolve(workspace);
    const owner = { projectSlug: first.project.slug, ownerType: "session" as const, ownerId: sessionId };
    const created = await first.hitl.create({
      owner,
      sessionRootId: sessionId,
      blockingKey: `session:${sessionId}:ask:context-load`,
      source: { type: "ask_user", sessionId, toolCallId: "context-load" },
      displayPayload: { title: "Need answer", redacted: true },
    });
    const response = { type: "question_answer" as const, answers: ["resume after boot"] };
    const claimed = await (await first.hitl.ownerStore(owner)).claim(created.hitlId, response, {
      claimId: "claimed-before-context-reload",
      claimedAt: new Date().toISOString(),
      intent: "respond",
      attempt: 1,
    });

    resolver.dispose(workspace);
    const second = await resolver.resolve(workspace);
    await waitFor(async () => {
      const lookup = await second.hitl.lookup({ owner: created.owner, hitlId: created.hitlId });
      return lookup.status === "found" && lookup.record.status === "resume_failed";
    });

    expect(await second.hitl.lookup({ owner: created.owner, hitlId: created.hitlId })).toMatchObject({
      status: "found",
      record: {
        hitlId: created.hitlId,
        status: "resume_failed",
        response,
        resume: {
          claimId: claimed.resume?.claimId,
          intent: "respond",
          attempt: 1,
        },
      },
    });
  });

  test("exposes a context after claimed Session recovery is scheduled without waiting for the agent tail", async () => {
    const workspace = await makeWorkspace("hitl-recovery-ready-gate");
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspace);
    await sessions.flushSession(sessionId, workspace);
    const claimed = await seedClaimedSessionHitl(workspace, sessions, sessionId, "ordinary-recovery");
    sessions.get(sessionId, workspace)!.setState({ blockedByHitlIds: [claimed.hitlId] });
    await sessions.flushSession(sessionId, workspace);
    const executionManager = createExecutionManager(sessions);
    const entered = deferred<void>();
    const release = deferred<void>();
    let recoveredContext: Awaited<ReturnType<ProjectContextResolver["resolve"]>> | undefined;
    let resolver!: ProjectContextResolver;
    const adapter = {
      prepare: async () => {
        const lease = executionManager.reserveSessionHitlResume(workspace, sessionId, sessionId);
        lease.activate();
        return createPreparedHitlResume(async () => {
          recoveredContext = await resolver.resolve(workspace);
          entered.resolve(undefined);
          await release.promise;
        }, lease.release);
      },
    };
    resolver = createResolver({
      sessionStoreManager: sessions,
      resumeCoordinatorFactory: ({ hitl }) => new ResumeCoordinator({
        hitl,
        adapters: { session: adapter },
        logger: silentLogger,
      }),
    });

    let publiclyResolved = false;
    const publicResolution = resolver.resolve(workspace).then((context) => {
      publiclyResolved = true;
      return context;
    });
    const resolvedBeforeAgentTail = await Promise.race([
      publicResolution.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (resolvedBeforeAgentTail) {
      await entered.promise;
      await expect(executionManager.startCheckedExecution({
        slug: basename(workspace),
        workspaceRoot: workspace,
        sessionId,
        userMessage: "must remain blocked while recovery continues",
      })).rejects.toThrow(SessionFamilyActiveError);
    }
    release.resolve(undefined);
    const context = await publicResolution;
    expect(resolvedBeforeAgentTail).toBe(true);
    expect(publiclyResolved).toBe(true);
    expect(recoveredContext).toBe(context);
    await waitFor(async () => await isHitlStatus(context.hitl, claimed, "resolved"));
  });

  test("lets Loop dependencies re-enter after claimed Session recovery is scheduled", async () => {
    const workspace = await makeWorkspace("loop-hitl-recovery-ready-gate");
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const loopState = new LoopStateManager(workspace, silentLogger);
    const loop = await loopState.create(basename(workspace), LOOP_CONFIG);
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspace, { loopId: loop.loopId, sessionRole: "main" });
    await sessions.flushSession(sessionId, workspace);
    const claimed = await seedClaimedSessionHitl(workspace, sessions, sessionId, "loop-recovery");
    const entered = deferred<void>();
    const release = deferred<void>();
    let resolver!: ProjectContextResolver;
    const adapter = {
      prepare: async () => createPreparedHitlResume(async () => {
        const adapterContext = await resolver.resolve(workspace);
        await adapterContext.loopState.read(loop.loopId);
        // Mirrors getLoopSessionHitlContinuation -> getLoopScheduler resolving
        // the same project again from a deeper recovery dependency.
        const schedulerContext = await resolver.resolve(workspace);
        expect(schedulerContext).toBe(adapterContext);
        entered.resolve(undefined);
        await release.promise;
      }),
    };
    resolver = createResolver({
      sessionStoreManager: sessions,
      resumeCoordinatorFactory: ({ hitl }) => new ResumeCoordinator({
        hitl,
        adapters: { session: adapter },
        logger: silentLogger,
      }),
    });

    const publicResolution = resolver.resolve(workspace);
    const resolvedBeforeAdapterTail = await Promise.race([
      publicResolution.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (resolvedBeforeAdapterTail) await entered.promise;
    release.resolve(undefined);
    const context = await publicResolution;
    expect(resolvedBeforeAdapterTail).toBe(true);
    await waitFor(async () => await isHitlStatus(context.hitl, claimed, "resolved"));
  });

  test("lets Loop-owner runtime callbacks re-enter after recovery is scheduled", async () => {
    const workspace = await makeWorkspace("loop-owner-hitl-recovery-ready-gate");
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const loopState = new LoopStateManager(workspace, silentLogger);
    const loop = await loopState.create(basename(workspace), LOOP_CONFIG);
    const claimed = await seedClaimedLoopHitl(workspace, sessions, loop.loopId);
    const entered = deferred<void>();
    const release = deferred<void>();
    let resolver!: ProjectContextResolver;
    const adapter = {
      prepare: async () => createPreparedHitlResume(async () => {
        const adapterContext = await resolver.resolve(workspace);
        await adapterContext.loopState.read(loop.loopId);
        // Mirrors LoopHitlResumeAdapter.onContinuationQueued ->
        // getLoopScheduler -> contextResolver.resolve during cold recovery.
        const schedulerContext = await resolver.resolve(workspace);
        expect(schedulerContext).toBe(adapterContext);
        entered.resolve(undefined);
        await release.promise;
      }),
    };
    resolver = createResolver({
      sessionStoreManager: sessions,
      resumeCoordinatorFactory: ({ hitl }) => new ResumeCoordinator({
        hitl,
        adapters: { loop: adapter },
        logger: silentLogger,
      }),
    });

    const publicResolution = resolver.resolve(workspace);
    const resolvedBeforeAdapterTail = await Promise.race([
      publicResolution.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (resolvedBeforeAdapterTail) await entered.promise;
    release.resolve(undefined);
    const context = await publicResolution;
    expect(resolvedBeforeAdapterTail).toBe(true);
    await waitFor(async () => await isHitlStatus(context.hitl, claimed, "resolved"));
  });

  test("custom Goal/HITL factories are used per resolved context", async () => {
    const workspace = await makeWorkspace("custom-factories");
    const goalState = new GoalStateManager(workspace);
    const createdHitl: HitlService[] = [];
    const resolver = createResolver({
      goalStateFactory: mock((workspaceRoot: string) => {
        expect(workspaceRoot).toBe(workspace);
        return goalState;
      }),
      hitlFactory: mock((input) => {
        expect(input.workspaceRoot).toBe(workspace);
        expect(input.project.slug).toBe(basename(workspace));
        expect(input.sessions).toBeInstanceOf(SessionStoreManager);
        expect(input.goalState).toBe(goalState);
        expect(input.loopState).toBeInstanceOf(LoopStateManager);
        const hitl = new HitlService(input);
        createdHitl.push(hitl);
        return hitl;
      }),
    });

    const context = await resolver.resolve(workspace);

    expect(context.goalState).toBe(goalState);
    expect(context.hitl).toBe(createdHitl[0]);
    expect(context.hitlResumeCoordinator).toBeInstanceOf(ResumeCoordinator);
  });

  test("custom Loop factory is used per resolved context", async () => {
    const workspace = await makeWorkspace("custom-loop-factory");
    const loopState = new LoopStateManager(workspace);
    const resolver = createResolver({
      loopStateFactory: mock((workspaceRoot: string) => {
        expect(workspaceRoot).toBe(workspace);
        return loopState;
      }),
    });

    const context = await resolver.resolve(workspace);

    expect(context.loopState).toBe(loopState);
  });
});

function createExecutionManager(sessions: SessionStoreManager): SessionExecutionManager {
  return new SessionExecutionManager({
    sessionAgentManager: {} as SessionAgentManager,
    createSessionStore: (sessionId, workspaceRoot, options) => sessions.create(sessionId, workspaceRoot, options),
    flushSessionStore: (sessionId, workspaceRoot) => sessions.flushSession(sessionId, workspaceRoot),
    getSessionStore: (sessionId, workspaceRoot) => sessions.get(sessionId, workspaceRoot),
    loadSessionStore: (sessionId, workspaceRoot) => sessions.getOrLoad(sessionId, workspaceRoot),
    deleteSessionStore: (sessionId, workspaceRoot, options) => sessions.delete(sessionId, workspaceRoot, options),
    resolveRootSessionId: (sessionId, workspaceRoot) => sessions.resolveRootSessionId(sessionId, workspaceRoot),
    buildSessionTree: (workspaceRoot, rootSessionId) => sessions.buildSessionTree(workspaceRoot, rootSessionId),
    trackSession: () => undefined,
    untrackSession: () => undefined,
    executionScopeValidator: { validate: async () => undefined },
    logger: silentLogger,
  });
}

async function isHitlStatus(hitl: HitlService, identity: HitlIdentity, status: "resolved" | "cancelled"): Promise<boolean> {
  const lookup = await hitl.lookup(identity);
  return lookup.status === "found" && lookup.record.status === status;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met");
}

async function waitForSession(workspaceRoot: string, sessionId: string): Promise<void> {
  const path = join(workspaceRoot, ".archcode", "sessions", sessionId, "session.json");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(5);
  }
  throw new Error(`session was not persisted: ${sessionId}`);
}

async function seedClaimedSessionHitl(
  workspaceRoot: string,
  sessions: SessionStoreManager,
  sessionId: string,
  suffix: string,
) {
  const project = { slug: basename(workspaceRoot), name: basename(workspaceRoot) };
  const hitl = new HitlService({
    workspaceRoot,
    project,
    sessions,
    goalState: new GoalStateManager(workspaceRoot, silentLogger),
    loopState: new LoopStateManager(workspaceRoot, silentLogger),
  });
  const created = await hitl.create({
    owner: { projectSlug: project.slug, ownerType: "session", ownerId: sessionId },
    sessionRootId: sessionId,
    blockingKey: `session:${sessionId}:ask:${suffix}`,
    source: { type: "ask_user", sessionId, toolCallId: suffix },
    displayPayload: { title: "Resume after restart", redacted: true },
  });
  await hitl.claim({ owner: created.owner, hitlId: created.hitlId }, { type: "question_answer", answers: ["continue"] }, {
    claimId: `claim-${suffix}`,
    claimedAt: new Date().toISOString(),
    intent: "respond",
    attempt: 1,
  });
  return created;
}

async function seedClaimedLoopHitl(
  workspaceRoot: string,
  sessions: SessionStoreManager,
  loopId: string,
) {
  const project = { slug: basename(workspaceRoot), name: basename(workspaceRoot) };
  const hitl = new HitlService({
    workspaceRoot,
    project,
    sessions,
    goalState: new GoalStateManager(workspaceRoot, silentLogger),
    loopState: new LoopStateManager(workspaceRoot, silentLogger),
  });
  const created = await hitl.create({
    owner: { projectSlug: project.slug, ownerType: "loop", ownerId: loopId },
    blockingKey: `loop:${loopId}:question:recovery`,
    source: { type: "loop_question", loopId, questionKey: "recovery" },
    displayPayload: { title: "Resume Loop after restart", redacted: true },
  });
  await hitl.claim({ owner: created.owner, hitlId: created.hitlId }, { type: "question_answer", answers: ["continue"] }, {
    claimId: "claim-loop-owner-recovery",
    claimedAt: new Date().toISOString(),
    intent: "respond",
    attempt: 1,
  });
  return created;
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
