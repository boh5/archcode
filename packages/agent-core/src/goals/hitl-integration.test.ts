import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GoalState } from "@archcode/protocol";

import { ResumeCoordinator } from "../hitl/resume-coordinator";
import { HitlService } from "../hitl/service";
import { silentLogger } from "../logger";
import { LoopStateManager } from "../loops/state";
import { SessionStoreManager } from "../store/session-store-manager";
import { GoalHitlResumeAdapter } from "./hitl-resume-adapter";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-hitl-integration");

let workspaceRoot = "";
let manager: GoalStateManager;
let sessions: SessionStoreManager;
let loops: LoopStateManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
  sessions = new SessionStoreManager({ logger: silentLogger });
  loops = new LoopStateManager(workspaceRoot);
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function createHitlService(): HitlService {
  return new HitlService({
    workspaceRoot,
    project: { slug: "project-a", name: "Project A" },
    sessions,
    goalState: manager,
    loopState: loops,
  });
}

function createCoordinator(hitlService: HitlService): ResumeCoordinator {
  return new ResumeCoordinator({
    hitl: hitlService,
    adapters: {
      goal: new GoalHitlResumeAdapter({
        workspaceRoot,
        goalStateManager: manager,
        hitlService,
      }),
    },
  });
}

async function createGoal(status: Extract<GoalState["status"], "running" | "reviewing"> = "running"): Promise<GoalState> {
  const goal = await manager.create({
    projectId: "project-a",
    title: "Ship HITL integration",
    objective: "Resume simplified Goal blockers from HITL records.",
    acceptanceCriteria: "Approved HITL clears blockers; denied and cancelled responses reach deterministic terminal states.",
    mainSessionId: "main-session-1",
  });
  const running = await manager.start(goal.id, { mainSessionId: "main-session-1" });
  return status === "reviewing" ? await manager.beginReview(running.id) : running;
}

async function blockGoal(hitlService: HitlService, goal: GoalState, resumeStatus: "running" | "reviewing", sourceType: "goal_approval" | "goal_budget" = "goal_approval") {
  const record = await hitlService.create({
    owner: { projectSlug: goal.projectId, ownerType: "goal", ownerId: goal.id },
    blockingKey: `goal:${goal.id}:${resumeStatus}:${crypto.randomUUID()}`,
    source: sourceType === "goal_approval"
      ? { type: "goal_approval", goalId: goal.id, approvalPoint: resumeStatus }
      : { type: "goal_budget", goalId: goal.id, approvalPoint: "approval_budget_1" },
    displayPayload: {
      title: "Approve Goal continuation",
      summary: "Goal is blocked for HITL.",
      redacted: true,
    },
  });
  await manager.block(goal.id, {
    kind: sourceType === "goal_budget" ? "budget" : "approval",
    summary: "Goal is blocked for HITL.",
    hitlId: record.hitlId,
    source: record.source.type,
    resumeStatus,
  });
  await manager.recordHitlRef(goal.id, { hitlId: record.hitlId, approvalRef: record.hitlId });
  return record;
}

async function waitForGoal(goalId: string, predicate: (goal: GoalState) => boolean): Promise<GoalState> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const goal = await manager.read(goalId);
    if (predicate(goal)) return goal;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for Goal state");
}

describe("Goal HITL resume integration", () => {
  test("approved HITL clears pending id and resumes a running blocker", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const goal = await createGoal("running");
    const record = await blockGoal(hitlService, goal, "running");

    const result = await coordinator.respond(record.hitlId, { type: "approval_decision", decision: "approved", comment: "continue" });

    expect(result.scheduled).toBe(true);
    const resumed = await waitForGoal(goal.id, (state) => state.status === "running" && state.pendingHitlIds.length === 0);
    expect(resumed.blocker).toBeUndefined();
    expect(resumed.approvalRefs).toEqual([record.hitlId]);
    expect(await Bun.file(join(workspaceRoot, ".archcode", "goals", goal.id, "approvals.md")).exists()).toBe(false);
  });

  test("approved HITL resumes to reviewing through blocker.resumeStatus", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const goal = await createGoal("reviewing");
    const record = await blockGoal(hitlService, goal, "reviewing");

    await coordinator.respond(record.hitlId, { type: "approval_decision", decision: "approved" });

    const resumed = await waitForGoal(goal.id, (state) => state.status === "reviewing" && state.blocker === undefined);
    expect(resumed.pendingHitlIds).toEqual([]);
  });

  test("denied approval deterministically moves blocked Goal to failed", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const goal = await createGoal("running");
    const record = await blockGoal(hitlService, goal, "running");

    await coordinator.respond(record.hitlId, { type: "approval_decision", decision: "denied", comment: "missing release notes" });

    const failed = await waitForGoal(goal.id, (state) => state.status === "failed");
    expect(failed.lastError?.message).toBe("missing release notes");
  });

  test("cancelled approval deterministically moves blocked Goal to cancelled", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const goal = await createGoal("running");
    const record = await blockGoal(hitlService, goal, "running", "goal_budget");

    await coordinator.cancel(record.hitlId, "User cancelled approval");

    const cancelled = await waitForGoal(goal.id, (state) => state.status === "cancelled");
    expect(cancelled.cancelledAt).toBeDefined();
    expect(await hitlService.list({ scope: "goal", ownerId: goal.id })).toEqual([]);
  });
});
