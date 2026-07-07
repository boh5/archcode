import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { GoalArtifactManager } from "../goals/artifacts";
import { GoalMemoryManager } from "../goals/goal-memory";
import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { ResumeCoordinator } from "../hitl/resume-coordinator";
import { LoopStateManager, type LoopConfig } from "../loops/state";
import { MemoryFileManager } from "../memory/file-manager";
import { SessionStoreManager } from "../store/session-store-manager";
import type { PermissionApprovalScope } from "../tools/permission/policy-types";
import { silentLogger } from "../logger";
import { ProjectApprovalManager } from "../tools/permission/project-approvals";
import { ProjectContextResolver } from "./context-resolver";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "context-resolver");

const TEST_SCOPE: PermissionApprovalScope = {
  kind: "tool-operation",
  toolName: "file_write",
  operation: "write",
};

const LOOP_CONFIG: LoopConfig = {
  title: "Project loop",
  schedule: { kind: "interval", everyMs: 60_000 },
  runKind: "session",
  mode: "report",
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 5 },
  taskPrompt: "Summarize local project state.",
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

describe("ProjectContextResolver", () => {
  test("resolve returns the same context object for the same workspace", async () => {
    const workspace = await makeWorkspace("identity");
    const resolver = new ProjectContextResolver();

    const first = await resolver.resolve(workspace);
    const second = await resolver.resolve(workspace);

    expect(first).toBe(second);
  });

  test("different workspaces produce different contexts and approval managers", async () => {
    const workspaceA = await makeWorkspace("workspace-a");
    const workspaceB = await makeWorkspace("workspace-b");
    const resolver = new ProjectContextResolver();

    const contextA = await resolver.resolve(workspaceA);
    const contextB = await resolver.resolve(workspaceB);

    expect(contextA).not.toBe(contextB);
    expect(contextA.approvals).not.toBe(contextB.approvals);
  });

  test("dispose removes the cached context so the next resolve creates a fresh context", async () => {
    const workspace = await makeWorkspace("dispose");
    const resolver = new ProjectContextResolver();

    const first = await resolver.resolve(workspace);
    resolver.dispose(workspace);
    const second = await resolver.resolve(workspace);

    expect(second).not.toBe(first);
    expect(second.goalState).not.toBe(first.goalState);
    expect(second.goalArtifacts).not.toBe(first.goalArtifacts);
    expect(second.goalMemory).not.toBe(first.goalMemory);
    expect(second.loopState).not.toBe(first.loopState);
    expect(second.hitl).not.toBe(first.hitl);
    expect(second.memory).not.toBe(first.memory);
    expect(second.approvals).not.toBe(first.approvals);
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

    const resolver = new ProjectContextResolver({
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
    const resolver = new ProjectContextResolver();

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

  test("default factories create the expected manager roots and placeholder project info", async () => {
    const workspace = await makeWorkspace("defaults");
    const resolver = new ProjectContextResolver();

    const context = await resolver.resolve(workspace);

    expect(context.goalState).toBeInstanceOf(GoalStateManager);
    expect(context.goalArtifacts).toBeInstanceOf(GoalArtifactManager);
    expect(context.goalArtifacts.workspaceRoot).toBe(workspace);
    expect(context.goalMemory).toBeInstanceOf(GoalMemoryManager);
    expect(context.goalMemory.workspaceRoot).toBe(workspace);
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

  test("projectInfoFactory overrides placeholder slug for registry-backed contexts", async () => {
    const workspace = await makeWorkspace("registry-info");
    const projectInfo = {
      slug: "registry-slug",
      name: "Registry Project",
      workspaceRoot: workspace,
      addedAt: new Date().toISOString(),
    };
    const resolver = new ProjectContextResolver({
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
    const resolver = new ProjectContextResolver();

    const context = await resolver.resolve(workspace);
    const contextRecord = context as unknown as Record<string, unknown>;

    expect(context.goalState).toBeInstanceOf(GoalStateManager);
    expect(context.goalArtifacts).toBeInstanceOf(GoalArtifactManager);
    expect(context.goalMemory).toBeInstanceOf(GoalMemoryManager);
    expect(context.hitl).toBeInstanceOf(HitlService);
    expect(context.hitlResumeCoordinator).toBeInstanceOf(ResumeCoordinator);
    expect(contextRecord.workflowState).toBeUndefined();
    expect(contextRecord.artifacts).toBeUndefined();
  });

  test("loops are isolated under each workspace .archcode/loops directory", async () => {
    const workspaceA = await makeWorkspace("loops-a");
    const workspaceB = await makeWorkspace("loops-b");
    const resolver = new ProjectContextResolver();

    const contextA = await resolver.resolve(workspaceA);
    const contextB = await resolver.resolve(workspaceB);

    const loopA = await contextA.loopState.create(contextA.project.slug, { ...LOOP_CONFIG, title: "Loop A" });
    const loopB = await contextB.loopState.create(contextB.project.slug, { ...LOOP_CONFIG, title: "Loop B" });

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
    const resolver = new ProjectContextResolver();

    const contextA = await resolver.resolve(workspaceA);
    const contextB = await resolver.resolve(workspaceB);

    const goalA = await contextA.goalState.create(contextA.project.slug, "Goal A", "architect");
    const goalB = await contextB.goalState.create(contextB.project.slug, "Goal B", "architect");

    expect((await contextA.goalState.listGoals()).map((goal) => goal.id)).toEqual([goalA.id]);
    expect((await contextB.goalState.listGoals()).map((goal) => goal.id)).toEqual([goalB.id]);
    expect(await Bun.file(join(workspaceA, ".archcode", "goals", goalA.id, "goal.json")).exists()).toBe(true);
    expect(await Bun.file(join(workspaceB, ".archcode", "goals", goalB.id, "goal.json")).exists()).toBe(true);
    expect(await Bun.file(join(workspaceB, ".archcode", "goals", goalA.id, "goal.json")).exists()).toBe(false);
  });

  test("owner-local HITL is loaded from the project workspace after context recreation", async () => {
    const workspace = await makeWorkspace("hitl-reload");
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const resolver = new ProjectContextResolver({ sessionStoreManager: sessions });
    const first = await resolver.resolve(workspace);
    const goal = await first.goalState.create(first.project.slug, "Needs approval", "architect");

    const created = await first.hitl.create({
      owner: { projectSlug: first.project.slug, ownerType: "goal", ownerId: goal.id },
      blockingKey: `goal:${goal.id}:approval:after_plan`,
      source: { type: "goal_approval", goalId: goal.id, approvalPoint: "after_plan" },
      displayPayload: { title: "Continue?", redacted: true },
    });
    expect(created).toBeDefined();
    await first.hitl.flush();

    resolver.dispose(workspace);
    const second = await resolver.resolve(workspace);

    expect(second.hitl).not.toBe(first.hitl);
    expect(await second.hitl.lookup(created.hitlId)).toMatchObject({
      status: "found",
      record: { hitlId: created.hitlId, status: "pending" },
    });
  });

  test("adapter-less context recreation does not auto-fail claimed HITL resumes", async () => {
    const workspace = await makeWorkspace("hitl-claimed-no-adapter");
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspace);
    await waitForSession(workspace, sessionId);
    const resolver = new ProjectContextResolver({ sessionStoreManager: sessions });
    const first = await resolver.resolve(workspace);
    const owner = { projectSlug: first.project.slug, ownerType: "session" as const, ownerId: sessionId };
    const created = await first.hitl.create({
      owner,
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

    expect(await second.hitl.lookup(created.hitlId)).toMatchObject({
      status: "found",
      record: {
        hitlId: created.hitlId,
        status: "resume_claimed",
        response,
        resume: {
          claimId: claimed.resume?.claimId,
          intent: "respond",
          attempt: 1,
        },
      },
    });
  });

  test("custom Goal/HITL factories are used per resolved context", async () => {
    const workspace = await makeWorkspace("custom-factories");
    const goalState = new GoalStateManager(workspace);
    const goalArtifacts = new GoalArtifactManager(workspace);
    const goalMemory = new GoalMemoryManager(workspace);
    const hitl = new HitlService({ submitHitlEvent: () => {} });
    const resolver = new ProjectContextResolver({
      goalStateFactory: mock((workspaceRoot: string) => {
        expect(workspaceRoot).toBe(workspace);
        return goalState;
      }),
      goalArtifactsFactory: mock((workspaceRoot: string) => {
        expect(workspaceRoot).toBe(workspace);
        return goalArtifacts;
      }),
      goalMemoryFactory: mock((workspaceRoot: string) => {
        expect(workspaceRoot).toBe(workspace);
        return goalMemory;
      }),
      hitlFactory: mock(() => hitl),
    });

    const context = await resolver.resolve(workspace);

    expect(context.goalState).toBe(goalState);
    expect(context.goalArtifacts).toBe(goalArtifacts);
    expect(context.goalMemory).toBe(goalMemory);
    expect(context.hitl).toBe(hitl);
    expect(context.hitlResumeCoordinator).toBeInstanceOf(ResumeCoordinator);
  });

  test("custom Loop factory is used per resolved context", async () => {
    const workspace = await makeWorkspace("custom-loop-factory");
    const loopState = new LoopStateManager(workspace);
    const resolver = new ProjectContextResolver({
      loopStateFactory: mock((workspaceRoot: string) => {
        expect(workspaceRoot).toBe(workspace);
        return loopState;
      }),
    });

    const context = await resolver.resolve(workspace);

    expect(context.loopState).toBe(loopState);
  });
});

async function waitForSession(workspaceRoot: string, sessionId: string): Promise<void> {
  const path = join(workspaceRoot, ".archcode", "sessions", sessionId, "session.json");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(5);
  }
  throw new Error(`session was not persisted: ${sessionId}`);
}
