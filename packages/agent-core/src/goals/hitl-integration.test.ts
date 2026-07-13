import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GoalState, HitlRecord, HitlResponse } from "@archcode/protocol";

import { ResumeCoordinator } from "../hitl/resume-coordinator";
import { HitlService } from "../hitl/service";
import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { GoalHitlResumeAdapter } from "./hitl-resume-adapter";
import { withGoalExecutionClaimLock } from "./execution-claim";
import { GoalStateError, GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-hitl-integration");

let workspaceRoot = "";
let manager: GoalStateManager;
let sessions: SessionStoreManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
  sessions = new SessionStoreManager({ logger: silentLogger });
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
  });
}

function createAdapter(hitlService: HitlService, onGoalStateChanged?: (goalId: string) => void | Promise<void>): GoalHitlResumeAdapter {
  return new GoalHitlResumeAdapter({
    workspaceRoot,
    goalStateManager: manager,
    hitlService,
    goalCancellation: {
      cancel: (goalId, request) => manager.cancel(goalId, request.reason, request.hitlId),
    },
    onGoalStateChanged,
  });
}

function createCoordinator(hitlService: HitlService): ResumeCoordinator {
  return new ResumeCoordinator({ hitl: hitlService, adapters: { goal: createAdapter(hitlService) } });
}

async function runAdapter(adapter: GoalHitlResumeAdapter, record: HitlRecord, response: HitlResponse): Promise<void> {
  const prepared = await adapter.prepare(record, response);
  try {
    await prepared.run(record, response);
  } finally {
    prepared.release();
  }
}

async function createGoal(status: Extract<GoalState["status"], "running" | "reviewing"> = "running"): Promise<GoalState> {
  const running = await manager.commit({
    id: crypto.randomUUID(),
    projectId: "project-a",
    createdFromSessionId: crypto.randomUUID(),
    objective: "Resume simplified Goal blockers from HITL records.",
    acceptanceCriteria: "Approved HITL clears blockers; denied and cancelled responses reach deterministic terminal states.",
    mainSessionId: "main-session-1",
  });
  return status === "reviewing" ? await manager.beginReview(running.id) : running;
}

async function blockGoal(hitlService: HitlService, goal: GoalState, resumeStatus: "running" | "reviewing", sourceType: "goal_approval" | "goal_budget" = "goal_approval") {
  const record = await hitlService.create({
    owner: { projectSlug: goal.projectId, ownerType: "goal", ownerId: goal.id },
    blockingKey: `goal:${goal.id}:${resumeStatus}:${crypto.randomUUID()}`,
    source: sourceType === "goal_approval"
      ? { type: "goal_approval", goalId: goal.id, approvalPoint: resumeStatus, resumeStatus }
      : { type: "goal_budget", goalId: goal.id, approvalPoint: "approval_budget_1", resumeStatus },
    displayPayload: {
      title: "Approve Goal continuation",
      summary: "Goal is blocked for HITL.",
      redacted: true,
    },
  });
  await manager.attachHitlBlocker(goal.id, {
    blocker: {
      kind: sourceType === "goal_budget" ? "budget" : "approval",
      summary: "Goal is blocked for HITL.",
      hitlId: record.hitlId,
      source: record.source.type,
      resumeStatus,
    },
    approvalRef: record.hitlId,
  });
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
  test("notifies continuation after an approved Goal blocker is durably applied", async () => {
    const hitlService = createHitlService();
    const onGoalStateChanged = mock(() => undefined);
    const adapter = createAdapter(hitlService, onGoalStateChanged);
    const goal = await createGoal("running");
    const record = await blockGoal(hitlService, goal, "running");

    await runAdapter(adapter, record, { type: "approval_decision", decision: "approved" });

    expect(onGoalStateChanged).toHaveBeenCalledTimes(1);
    expect(onGoalStateChanged).toHaveBeenCalledWith(goal.id);
    expect((await manager.read(goal.id)).status).toBe("running");
  });

  test("notifies continuation outside the non-reentrant Goal claim lock", async () => {
    const hitlService = createHitlService();
    let callbackEntered = false;
    const adapter = createAdapter(hitlService, async (goalId) => {
      await withGoalExecutionClaimLock(goalId, async () => {
        callbackEntered = true;
      });
    });
    const goal = await createGoal("running");
    const record = await blockGoal(hitlService, goal, "running");

    await runAdapter(adapter, record, { type: "approval_decision", decision: "approved" });

    expect(callbackEntered).toBe(true);
  });

  test("notifies Loop projection after denied and cancelled Goal HITL outcomes", async () => {
    const hitlService = createHitlService();
    const onGoalStateChanged = mock(() => undefined);
    const adapter = createAdapter(hitlService, onGoalStateChanged);
    const deniedGoal = await createGoal("running");
    const denied = await blockGoal(hitlService, deniedGoal, "running");
    const cancelledGoal = await createGoal("running");
    const cancelled = await blockGoal(hitlService, cancelledGoal, "running");

    await runAdapter(adapter, denied, { type: "approval_decision", decision: "denied", comment: "stop" });
    await runAdapter(adapter, cancelled, { type: "cancel", reason: "stop" });

    expect((await manager.read(deniedGoal.id)).status).toBe("failed");
    expect((await manager.read(cancelledGoal.id)).status).toBe("cancelled");
    expect(onGoalStateChanged).toHaveBeenCalledWith(deniedGoal.id);
    expect(onGoalStateChanged).toHaveBeenCalledWith(cancelledGoal.id);
  });

  test("approved HITL clears pending id and resumes a running blocker", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const goal = await createGoal("running");
    const record = await blockGoal(hitlService, goal, "running");

    const result = await coordinator.respond(
      { owner: record.owner, hitlId: record.hitlId },
      { type: "approval_decision", decision: "approved", comment: "continue" },
    );

    expect(result.scheduled).toBe(true);
    const resumed = await waitForGoal(goal.id, (state) => state.status === "running" && state.pendingHitlIds.length === 0);
    expect(resumed.blocker).toBeUndefined();
    expect(resumed.approvalRefs).toEqual([record.hitlId]);
    expect(resumed.appliedHitlIds).toEqual([record.hitlId]);
    expect(await Bun.file(join(workspaceRoot, ".archcode", "goals", goal.id, "approvals.md")).exists()).toBe(false);
  });

  test("recovers an owner-created-before-attach record from its persisted resume intent", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const goal = await createGoal("running");
    const record = await hitlService.create({
      owner: { projectSlug: goal.projectId, ownerType: "goal", ownerId: goal.id },
      blockingKey: `goal:${goal.id}:approval:after_plan`,
      source: {
        type: "goal_approval",
        goalId: goal.id,
        approvalPoint: "after_plan",
        resumeStatus: "reviewing",
      },
      displayPayload: {
        title: "Approve Goal continuation",
        summary: "Owner write committed before Goal attachment.",
        redacted: true,
      },
    });

    const result = await coordinator.respond({ owner: record.owner, hitlId: record.hitlId }, {
      type: "approval_decision",
      decision: "approved",
      comment: "recover attachment",
    });

    expect(result.scheduled).toBe(true);
    const recovered = await waitForGoal(goal.id, (state) => (
      state.appliedHitlIds.includes(record.hitlId)
    ));
    expect(recovered).toMatchObject({
      status: "reviewing",
      pendingHitlIds: [],
      approvalRefs: [record.hitlId],
    });
    expect(recovered.blocker).toBeUndefined();
  });

  test("approved HITL resumes to reviewing through blocker.resumeStatus", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const goal = await createGoal("reviewing");
    const record = await blockGoal(hitlService, goal, "reviewing");

    await coordinator.respond(
      { owner: record.owner, hitlId: record.hitlId },
      { type: "approval_decision", decision: "approved" },
    );

    const resumed = await waitForGoal(goal.id, (state) => state.status === "reviewing" && state.blocker === undefined);
    expect(resumed.pendingHitlIds).toEqual([]);
  });

  test("uses the applied marker as idempotent proof while owner terminalization is pending", async () => {
    const hitlService = createHitlService();
    const adapter = createAdapter(hitlService);
    const goal = await createGoal("running");
    const record = await blockGoal(hitlService, goal, "running");

    await runAdapter(adapter, record, { type: "approval_decision", decision: "approved" });
    await runAdapter(adapter, record, { type: "approval_decision", decision: "denied", comment: "must not reapply" });

    const resumed = await manager.read(goal.id);
    expect(resumed).toMatchObject({
      status: "running",
      pendingHitlIds: [],
      approvalRefs: [record.hitlId],
      appliedHitlIds: [record.hitlId],
    });
    expect(resumed.lastFailureSummary).toBeUndefined();
  });

  test("atomically finalizes a review and records its applied marker", async () => {
    const hitlService = createHitlService();
    const adapter = createAdapter(hitlService);
    const goal = await createGoal("reviewing");
    const record = await hitlService.create({
      owner: { projectSlug: goal.projectId, ownerType: "goal", ownerId: goal.id },
      blockingKey: `goal:${goal.id}:review`,
      source: { type: "goal_review", goalId: goal.id, resumeStatus: "reviewing" },
      displayPayload: { title: "Review Goal outcome", redacted: true },
    });
    await manager.attachHitlBlocker(goal.id, {
      blocker: {
        kind: "approval",
        summary: "Review Goal outcome",
        hitlId: record.hitlId,
        source: "goal_review",
        resumeStatus: "reviewing",
      },
      approvalRef: record.hitlId,
    });

    await runAdapter(adapter, record, { type: "review_outcome", outcome: "DONE", comment: "criteria satisfied" });

    const completed = await manager.read(goal.id);
    expect(completed).toMatchObject({
      status: "done",
      pendingHitlIds: [],
      appliedHitlIds: [record.hitlId],
      reviewGeneration: 1,
      review: { reviewGeneration: 1, verdict: "DONE", summary: "criteria satisfied" },
    });
    expect(completed.blocker).toBeUndefined();
  });

  test("rejects a stale persisted HITL review receipt", async () => {
    const hitlService = createHitlService();
    const adapter = createAdapter(hitlService);
    const goal = await createGoal("reviewing");
    const record = await hitlService.create({
      owner: { projectSlug: goal.projectId, ownerType: "goal", ownerId: goal.id },
      blockingKey: `goal:${goal.id}:stale-review`,
      source: { type: "goal_review", goalId: goal.id, resumeStatus: "reviewing" },
      displayPayload: { title: "Review Goal outcome", redacted: true },
    });
    await manager.attachHitlBlocker(goal.id, {
      blocker: {
        kind: "approval",
        summary: "Review Goal outcome",
        hitlId: record.hitlId,
        source: "goal_review",
        resumeStatus: "reviewing",
      },
      approvalRef: record.hitlId,
    });

    await expect(runAdapter(adapter, record, {
      type: "review_outcome",
      outcome: "DONE",
      receipt: {
        reviewGeneration: 0,
        verdict: "DONE",
        summary: "stale review",
        evidenceRefs: [{ kind: "hitl", ref: record.hitlId, summary: "stale evidence" }],
        reviewerSessionId: "stale-reviewer",
        decidedAt: new Date().toISOString(),
      },
    })).rejects.toBeInstanceOf(Error);

    expect((await manager.read(goal.id)).status).toBe("blocked");
  });

  test("rejects an attached owner that is neither pending nor durably applied", async () => {
    const hitlService = createHitlService();
    const adapter = createAdapter(hitlService);
    const goal = await createGoal("running");
    const record = await hitlService.create({
      owner: { projectSlug: goal.projectId, ownerType: "goal", ownerId: goal.id },
      blockingKey: `goal:${goal.id}:approval:invalid-gap`,
      source: { type: "goal_approval", goalId: goal.id, approvalPoint: "invalid-gap", resumeStatus: "running" },
      displayPayload: { title: "Invalid attachment gap", redacted: true },
    });
    const goalPath = join(workspaceRoot, ".archcode", "goals", goal.id, "goal.json");
    await Bun.write(goalPath, `${JSON.stringify({
      ...goal,
      approvalRefs: [record.hitlId],
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    await expect(runAdapter(adapter, record, {
      type: "approval_decision",
      decision: "approved",
    })).rejects.toBeInstanceOf(GoalStateError);
    expect((await manager.read(goal.id)).appliedHitlIds).toEqual([]);
  });

  test("denied approval deterministically moves blocked Goal to failed", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const goal = await createGoal("running");
    const record = await blockGoal(hitlService, goal, "running");

    await coordinator.respond(
      { owner: record.owner, hitlId: record.hitlId },
      { type: "approval_decision", decision: "denied", comment: "missing release notes" },
    );

    const failed = await waitForGoal(goal.id, (state) => state.status === "failed");
    expect(failed.lastError?.message).toBe("missing release notes");
    expect(failed.appliedHitlIds).toEqual([record.hitlId]);
  });

  test("cancelled approval deterministically moves blocked Goal to cancelled", async () => {
    const hitlService = createHitlService();
    const coordinator = createCoordinator(hitlService);
    const goal = await createGoal("running");
    const record = await blockGoal(hitlService, goal, "running", "goal_budget");

    await coordinator.cancel({ owner: record.owner, hitlId: record.hitlId }, "User cancelled approval");

    const cancelled = await waitForGoal(goal.id, (state) => state.status === "cancelled");
    expect(cancelled.cancelledAt).toBeDefined();
    expect(cancelled.appliedHitlIds).toEqual([record.hitlId]);
    expect(await hitlService.list({ scope: "goal", ownerId: goal.id })).toEqual([]);
  });
});
