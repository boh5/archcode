import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { DoneCondition, DoneResult, GoalState } from "@archcode/protocol";

import { ResumeCoordinator } from "../hitl/resume-coordinator";
import { HitlService } from "../hitl/service";
import { silentLogger } from "../logger";
import { setLlmAdapterForTest } from "../llm";
import { LoopStateManager } from "../loops/state";
import { SessionStoreManager } from "../store/session-store-manager";
import { GoalArtifactManager } from "./artifacts";
import { GoalHitlResumeAdapter } from "./hitl-resume-adapter";
import { GoalRunner } from "./runner";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-hitl-integration");

const condition: DoneCondition = {
  id: "artifact-exists",
  kind: "file_exists",
  params: { path: "artifact.txt" },
};

let workspaceRoot = "";
let manager: GoalStateManager;
let artifacts: GoalArtifactManager;
let sessions: SessionStoreManager;
let loops: LoopStateManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
  artifacts = new GoalArtifactManager(workspaceRoot);
  sessions = new SessionStoreManager({ logger: silentLogger });
  loops = new LoopStateManager(workspaceRoot);
  setLlmAdapterForTest({
    streamText: mock(),
    generateText: mock(),
  });
});

afterAll(async () => {
  setLlmAdapterForTest(undefined);
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function passingResult(conditionId = condition.id): DoneResult {
  return { conditionId, passed: true, evidence: "condition passed", checkedAt: new Date().toISOString() };
}

async function lockedGoal(approvalPoints: Array<"after_plan" | "before_complete">) {
  const goal = await manager.create(
    "project-a",
    "Ship HITL integration",
    "architect",
    [condition],
    { maxRetries: 1, backoffMs: 0, escalateOnFailure: true },
    approvalPoints,
  );
  return manager.lock(goal.id, "architect");
}

function createHitlService(): HitlService {
  return new HitlService({
    workspaceRoot,
    project: { slug: "project-a", name: "Project A" },
    sessions,
    goalState: manager,
    loopState: loops,
  });
}

function createRunner(hitlService: HitlService): GoalRunner {
  return new GoalRunner({
    goalStateManager: manager,
    goalArtifacts: artifacts,
    workspaceRoot,
    hitlService,
    createSession: mock(async () => `main-session-${crypto.randomUUID()}`),
    isSessionActive: mock(async () => true),
  });
}

function createCoordinator(hitlService: HitlService): ResumeCoordinator {
  return new ResumeCoordinator({
    hitl: hitlService,
    adapters: {
      goal: new GoalHitlResumeAdapter({
        workspaceRoot,
        goalStateManager: manager,
        goalArtifacts: artifacts,
        hitlService,
        createRunner: () => createRunner(hitlService),
      }),
    },
  });
}

async function readyForCompletion(runner: GoalRunner, goalId: string): Promise<void> {
  await runner.start(goalId);
  await runner.advancePhase(goalId, "build");
  await runner.advancePhase(goalId, "review");
  await runner.recordReviewerDoneResult(goalId, condition.id, passingResult());
  await runner.review(goalId);
}

async function waitForPending(hitlService: HitlService, goalId: string): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const pending = await hitlService.list({ scope: "goal", ownerId: goalId });
    if (pending[0]) return pending[0].hitlId;
    await sleep(5);
  }
  throw new Error("Expected pending HITL request");
}

async function waitForNoActiveHitl(hitlService: HitlService, goalId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const active = await hitlService.list({ scope: "goal", ownerId: goalId });
    if (active.length === 0) return;
    await sleep(5);
  }
  throw new Error("Timed out waiting for active Goal HITL records to clear");
}

async function waitForGoal(goalId: string, predicate: (goal: GoalState) => boolean): Promise<GoalState> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const goal = await manager.read(goalId);
    if (predicate(goal)) return goal;
    await sleep(5);
  }
  throw new Error("Timed out waiting for Goal state");
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("GoalRunner owner-local HITL integration", () => {
  test("owner-local after_plan approval pauses with checkpoint and resumes exactly once to build", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const runner = createRunner(hitlService);
    const goal = await lockedGoal(["after_plan"]);
    await runner.start(goal.id);

    const paused = await runner.advancePhase(goal.id, "build");
    const hitlId = await waitForPending(hitlService, goal.id);

    expect(paused.status).toBe("paused");
    expect(paused.phase).toBe("plan");
    expect(await manager.read(goal.id)).toMatchObject({
      status: "paused",
      phase: "plan",
      attentionStatus: "waiting_for_human",
      blockedByHitlIds: [hitlId],
      resumeCheckpoint: {
        kind: "goal_approval",
        action: "advancePhase",
        from: "plan",
        to: "build",
        approvalPoint: "after_plan",
        hitlId,
      },
    });
    expect(await Bun.file(join(workspaceRoot, ".archcode", "goals", goal.id, "hitl.json")).exists()).toBe(true);
    expect(await Bun.file(join(workspaceRoot, ".archcode", "hitl-queue.json")).exists()).toBe(false);

    const first = await coordinator.respond(hitlId, { type: "approval_decision", decision: "approved", comment: "ship it" });
    const duplicate = await coordinator.respond(hitlId, { type: "approval_decision", decision: "approved" });
    expect(first.scheduled).toBe(true);
    expect(duplicate.scheduled).toBe(false);

    const resumed = await waitForGoal(goal.id, (state) => state.status === "running" && state.phase === "build");
    expect(resumed).toMatchObject({
      status: "running",
      phase: "build",
      attentionStatus: "clear",
    });
    expect(resumed.blockedByHitlIds).toBeUndefined();
    expect(resumed.resumeCheckpoint).toBeUndefined();
  });

  test("owner-local denied before_complete approval records outcome and keeps goal paused", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const runner = createRunner(hitlService);
    const goal = await lockedGoal(["before_complete"]);
    await readyForCompletion(runner, goal.id);

    const paused = await runner.complete(goal.id);
    const hitlId = await waitForPending(hitlService, goal.id);
    expect(paused).toMatchObject({ status: "paused", phase: "review" });

    await coordinator.respond(hitlId, { type: "approval_decision", decision: "denied", comment: "missing release notes" });
    const current = await waitForGoal(goal.id, (state) => state.resumeCheckpoint === undefined);

    expect(current).toMatchObject({ status: "paused", phase: "review", attentionStatus: "clear" });
    expect(current.lastError).toContain("missing release notes");
    const approvals = await artifacts.readArtifact(goal.id, "approvals.md");
    expect(approvals).toContain("before_complete");
    expect(approvals).toContain("denied");
  });

  test("owner-local cancelled after_plan approval clears blocker and leaves paused artifact outcome", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const runner = createRunner(hitlService);
    const goal = await lockedGoal(["after_plan"]);
    await runner.start(goal.id);

    await runner.advancePhase(goal.id, "build");
    const hitlId = await waitForPending(hitlService, goal.id);

    await coordinator.cancel(hitlId, "User cancelled approval");
    const current = await waitForGoal(goal.id, (state) => state.resumeCheckpoint === undefined);

    expect(current).toMatchObject({ status: "paused", phase: "plan", attentionStatus: "clear" });
    await waitForNoActiveHitl(hitlService, goal.id);
    expect(await hitlService.list({ scope: "goal", ownerId: goal.id })).toEqual([]);
    const approvals = await artifacts.readArtifact(goal.id, "approvals.md");
    expect(approvals).toContain("cancelled");
  });
});
