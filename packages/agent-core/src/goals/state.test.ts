import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { PROJECT_STATE_DIR_NAME, type GoalEvidenceRef } from "@archcode/protocol";

import {
  GoalAlreadyExistsError,
  GoalInvalidIdError,
  GoalNotFoundError,
  GoalReviewFinalizationError,
  GoalReviewerAuthorizationError,
  GoalStateError,
  GoalStateManager,
  GoalStateSchema,
  GoalTransitionError,
} from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-state");
const GOAL_ID = "550e8400-e29b-41d4-a716-446655440000";
const SOURCE_SESSION_ID = "660e8400-e29b-41d4-a716-446655440001";
const MAIN_SESSION_ID = "770e8400-e29b-41d4-a716-446655440002";

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function commitInput(overrides: Partial<Parameters<GoalStateManager["commit"]>[0]> = {}) {
  return {
    id: GOAL_ID,
    projectId: "project-a",
    createdFromSessionId: SOURCE_SESSION_ID,
    objective: "Persist a committed Goal envelope.",
    acceptanceCriteria: "State transitions and reviewer finalization remain valid.",
    mainSessionId: MAIN_SESSION_ID,
    ...overrides,
  };
}

async function commitGoal(manager = new GoalStateManager(TMP_DIR)) {
  return await manager.commit(commitInput());
}

function evidenceRef(summary = "Tests passed"): GoalEvidenceRef {
  return { kind: "test_output", ref: "bun-test-output", summary, createdAt: new Date().toISOString() };
}

function reviewerAuth(goalId: string) {
  return {
    agentName: "reviewer",
    sessionRole: "review",
    sessionGoalId: goalId,
    reviewerSessionId: "review-session-1",
  };
}

describe("GoalStateSchema v4", () => {
  test("requires committed provenance and execution ownership with no draft fallback", async () => {
    const goal = await commitGoal();
    expect(GoalStateSchema.parse(goal)).toEqual(goal);

    const { createdFromSessionId: _source, ...withoutSource } = goal;
    const { mainSessionId: _main, ...withoutMain } = goal;
    const { startedAt: _started, ...withoutStarted } = goal;
    expect(GoalStateSchema.safeParse(withoutSource).success).toBe(false);
    expect(GoalStateSchema.safeParse(withoutMain).success).toBe(false);
    expect(GoalStateSchema.safeParse(withoutStarted).success).toBe(false);
    expect(GoalStateSchema.safeParse({ ...goal, version: 2 }).success).toBe(false);
    expect(GoalStateSchema.safeParse({ ...goal, status: "draft" }).success).toBe(false);
    expect(GoalStateSchema.safeParse({ ...goal, workflowId: GOAL_ID }).success).toBe(false);
  });

  test("enforces worktree, blocker, review, and HITL relational invariants", async () => {
    const goal = await commitGoal();
    const now = new Date().toISOString();
    const worktree = { path: join(TMP_DIR, "worktree"), branchName: "archcode/goal/id", baseSha: "a".repeat(40), createdAt: now };
    expect(GoalStateSchema.safeParse({ ...goal, worktree }).success).toBe(false);
    expect(GoalStateSchema.safeParse({ ...goal, status: "blocked" }).success).toBe(false);
    expect(GoalStateSchema.safeParse({ ...goal, pendingHitlIds: ["hitl-1"] }).success).toBe(false);
    expect(GoalStateSchema.safeParse({ ...goal, approvalRefs: ["hitl-1"], appliedHitlIds: ["hitl-1"] }).success).toBe(true);

    const review = {
      reviewGeneration: 0,
      verdict: "DONE" as const,
      summary: "Verified.",
      evidenceRefs: [evidenceRef()],
      reviewerSessionId: "review-session",
      decidedAt: now,
    };
    expect(GoalStateSchema.safeParse({ ...goal, status: "done", review, finalSummary: "Done", completedAt: now }).success).toBe(true);
    expect(GoalStateSchema.safeParse({ ...goal, status: "done", review: { ...review, evidenceRefs: [] }, finalSummary: "Done", completedAt: now }).success).toBe(false);
  });
});

describe("GoalStateManager", () => {
  test("atomically commits a running Goal from preallocated ids", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const goal = await commitGoal(manager);

    expect(goal).toMatchObject({
      version: 4,
      id: GOAL_ID,
      projectId: "project-a",
      createdFromSessionId: SOURCE_SESSION_ID,
      mainSessionId: MAIN_SESSION_ID,
      status: "running",
      useWorktree: false,
      attempt: 1,
      startedAt: expect.any(String),
    });
    expect(existsSync(join(TMP_DIR, PROJECT_STATE_DIR_NAME, "goals", GOAL_ID, "goal.json"))).toBe(true);
    expect(await manager.read(GOAL_ID)).toEqual(goal);
  });

  test("never overwrites a committed Goal identity", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const original = await commitGoal(manager);

    await expect(manager.commit(commitInput({ objective: "Conflicting replacement." })))
      .rejects.toBeInstanceOf(GoalAlreadyExistsError);
    expect((await manager.read(GOAL_ID)).objective).toBe(original.objective);
  });

  test("rejects old schema and malformed persisted state without migration", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const goal = await commitGoal(manager);
    const path = join(TMP_DIR, PROJECT_STATE_DIR_NAME, "goals", goal.id, "goal.json");
    await Bun.write(path, JSON.stringify({ ...goal, version: 2 }));
    await expect(manager.read(goal.id)).rejects.toBeInstanceOf(GoalStateError);
    await expect(manager.read("not-a-uuid")).rejects.toBeInstanceOf(GoalInvalidIdError);
    await expect(manager.read(crypto.randomUUID())).rejects.toBeInstanceOf(GoalNotFoundError);
  });

  test("keeps worktree identity write-once", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const goal = await manager.commit(commitInput({ useWorktree: true }));
    const worktree = {
      path: join(TMP_DIR, "goal-worktree"),
      branchName: "archcode/goal/123456789abc",
      baseSha: "a".repeat(40),
      createdAt: new Date().toISOString(),
    };
    expect((await manager.setWorktree(goal.id, worktree)).worktree).toEqual(worktree);
    expect((await manager.setWorktree(goal.id, { ...worktree, createdAt: new Date().toISOString() })).worktree).toEqual(worktree);
    await expect(manager.setWorktree(goal.id, { ...worktree, path: join(TMP_DIR, "other") }))
      .rejects.toBeInstanceOf(GoalStateError);
  });

  test("preserves the running lifecycle, reviewer evidence, retry, and terminal rules", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const goal = await commitGoal(manager);
    expect((await manager.beginReview(goal.id)).status).toBe("reviewing");
    const notDone = await manager.finalizeReview(goal.id, {
      expectedReviewGeneration: 1,
      verdict: "NOT_DONE",
      summary: "Missing evidence.",
      authorization: reviewerAuth(goal.id),
    });
    expect(notDone.status).toBe("not_done");
    expect(await manager.retry(goal.id)).toMatchObject({ status: "running", attempt: 2 });
    expect((await manager.beginReview(goal.id)).reviewGeneration).toBe(2);

    await expect(manager.finalizeReview(goal.id, {
      expectedReviewGeneration: 2,
      verdict: "DONE",
      summary: "Wrong reviewer.",
      evidenceRefs: [evidenceRef()],
      authorization: { ...reviewerAuth(goal.id), agentName: "build" },
    })).rejects.toBeInstanceOf(GoalReviewerAuthorizationError);
    await expect(manager.finalizeReview(goal.id, {
      expectedReviewGeneration: 2,
      verdict: "DONE",
      summary: "No evidence.",
      evidenceRefs: [],
      authorization: reviewerAuth(goal.id),
    })).rejects.toBeInstanceOf(GoalReviewFinalizationError);

    const done = await manager.finalizeReview(goal.id, {
      expectedReviewGeneration: 2,
      verdict: "DONE",
      summary: "All criteria verified.",
      evidenceRefs: [evidenceRef()],
      authorization: reviewerAuth(goal.id),
    });
    expect(done.status).toBe("done");
    await expect(manager.cancel(goal.id)).rejects.toBeInstanceOf(GoalTransitionError);
  });

  test("lists committed Goals deterministically by project", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const secondId = "880e8400-e29b-41d4-a716-446655440003";
    await manager.commit(commitInput({ id: secondId, projectId: "project-b", mainSessionId: crypto.randomUUID() }));
    await manager.commit(commitInput());
    expect((await manager.listGoals()).map((goal) => goal.id)).toEqual([GOAL_ID, secondId]);
    expect((await manager.listGoals("project-a")).map((goal) => goal.id)).toEqual([GOAL_ID]);
  });
});
