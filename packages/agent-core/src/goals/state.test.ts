import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { PROJECT_STATE_DIR_NAME, type GoalEvidenceRef } from "@archcode/protocol";

import {
  GoalInvalidIdError,
  GoalNotFoundError,
  GoalPathError,
  GoalReviewFinalizationError,
  GoalReviewerAuthorizationError,
  GoalStateError,
  GoalStateManager,
  GoalStateSchema,
  GoalTransitionError,
  GoalUnsupportedStateError,
} from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-state");
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_LOOP_ID = "660e8400-e29b-41d4-a716-446655440001";

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

async function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected async action to throw");
}

function evidenceRef(summary = "Tests passed"): GoalEvidenceRef {
  return {
    kind: "test_output",
    ref: "bun-test-output",
    summary,
    createdAt: new Date().toISOString(),
  };
}

function reviewerAuth(goalId: string) {
  return {
    agentName: "reviewer",
    sessionRole: "review",
    sessionGoalId: goalId,
    reviewerSessionId: "review-session-1",
  };
}

async function createGoal(manager = new GoalStateManager(TMP_DIR)) {
  return manager.create({
    projectId: "project-a",
    title: "Ship thin goal state",
    objective: "Replace workflow state with a natural language goal envelope.",
    acceptanceCriteria: "State transitions and reviewer finalization obey the simplified protocol.",
  });
}

describe("GoalStateSchema", () => {
  test("accepts the protocol state envelope and rejects unknown keys", () => {
    const now = new Date().toISOString();
    const state = GoalStateSchema.parse({
      id: VALID_UUID,
      projectId: "project-a",
      title: "Ship thin state",
      objective: "Keep only natural-language goal intent.",
      acceptanceCriteria: "Reviewer finalizes with evidence.",
      status: "reviewing",
      attempt: 1,
      blocker: { kind: "approval", summary: "Waiting", hitlId: "hitl-1", resumeStatus: "reviewing", createdAt: now },
      lastFailureSummary: "Previous review found missing tests.",
      budget: { status: "warning", usedTokens: 100, maxTokens: 200, reason: "near limit", updatedAt: now },
      pendingHitlIds: ["hitl-1"],
      approvalRefs: ["approval-1"],
      mainSessionId: "main-session",
      childSessionIds: ["child-session"],
      loopId: VALID_LOOP_ID,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      lastError: { name: "Error", message: "previous failure", at: now },
    });

    expect(state.status).toBe("reviewing");
    expect(() => GoalStateSchema.parse({ ...state, workflowId: VALID_UUID })).toThrow();
  });

  test("enforces field bounds for natural language and review evidence", () => {
    const now = new Date().toISOString();
    const base = {
      id: VALID_UUID,
      projectId: "project-a",
      title: "A".repeat(160),
      objective: "O".repeat(8000),
      acceptanceCriteria: "C".repeat(8000),
      status: "reviewing" as const,
      attempt: 1,
      pendingHitlIds: [],
      approvalRefs: [],
      childSessionIds: [],
      createdAt: now,
      updatedAt: now,
    };

    expect(GoalStateSchema.parse(base).title).toHaveLength(160);
    expect(() => GoalStateSchema.parse({ ...base, title: "T".repeat(161) })).toThrow();
    expect(() => GoalStateSchema.parse({ ...base, objective: "O".repeat(8001) })).toThrow();
    expect(() => GoalStateSchema.parse({ ...base, finalSummary: "F".repeat(4001) })).toThrow();
    expect(() => GoalStateSchema.parse({
      ...base,
      review: {
        verdict: "DONE",
        summary: "R".repeat(4001),
        evidenceRefs: [],
        reviewerSessionId: "review-session",
        decidedAt: now,
      },
    })).toThrow();
    expect(() => GoalStateSchema.parse({
      ...base,
      review: {
        verdict: "DONE",
        summary: "ok",
        evidenceRefs: Array.from({ length: 21 }, (_, index) => evidenceRef(`evidence ${index}`)),
        reviewerSessionId: "review-session",
        decidedAt: now,
      },
    })).toThrow();
  });
});

describe("GoalStateManager", () => {
  test("create persists a draft with only protocol fields", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await createGoal(manager);

    expect(created).toMatchObject({
      projectId: "project-a",
      title: "Ship thin goal state",
      status: "draft",
      attempt: 1,
      pendingHitlIds: [],
      approvalRefs: [],
      childSessionIds: [],
    });
    expect(existsSync(join(TMP_DIR, PROJECT_STATE_DIR_NAME, "goals", created.id, "goal.json"))).toBe(true);
    expect(Object.keys(created).sort()).toEqual([
      "acceptanceCriteria",
      "approvalRefs",
      "attempt",
      "childSessionIds",
      "createdAt",
      "id",
      "objective",
      "pendingHitlIds",
      "projectId",
      "status",
      "title",
      "updatedAt",
    ]);
  });

  test("patchDraft is limited to draft goals", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await createGoal(manager);
    const patched = await manager.patchDraft(created.id, { title: "Patched", objective: "New objective" });
    expect(patched.title).toBe("Patched");
    expect(patched.objective).toBe("New objective");

    await manager.start(created.id, { mainSessionId: "main-session" });
    expect(await captureAsyncError(() => manager.patchDraft(created.id, { title: "Denied" }))).toBeInstanceOf(GoalStateError);
  });

  test("allows exactly the simplified transition graph", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const done = await createGoal(manager);
    await manager.start(done.id);
    await manager.beginReview(done.id);
    const finalized = await manager.finalizeReview(done.id, {
      verdict: "DONE",
      summary: "All evidence passed.",
      evidenceRefs: [evidenceRef()],
      authorization: reviewerAuth(done.id),
    });
    expect(finalized.status).toBe("done");
    expect(await captureAsyncError(() => manager.fail(done.id, "too late"))).toBeInstanceOf(GoalTransitionError);

    const blocked = await createGoal(manager);
    await manager.start(blocked.id);
    expect((await manager.block(blocked.id, { kind: "question", summary: "Need answer", hitlId: "hitl-1", resumeStatus: "reviewing" })).status).toBe("blocked");
    expect((await manager.clearBlocker(blocked.id, "hitl-1")).status).toBe("reviewing");
    expect((await manager.finalizeReview(blocked.id, {
      verdict: "NOT_DONE",
      summary: "Missing acceptance evidence.",
      authorization: reviewerAuth(blocked.id),
    })).status).toBe("not_done");
    expect((await manager.retry(blocked.id, { mainSessionId: "retry-session" })).status).toBe("running");

    const failed = await createGoal(manager);
    await manager.start(failed.id);
    expect((await manager.fail(failed.id, new Error("build failed"))).status).toBe("failed");
    expect((await manager.retry(failed.id)).status).toBe("running");

    const cancelled = await createGoal(manager);
    expect((await manager.cancel(cancelled.id, "not needed")).status).toBe("cancelled");
  });

  test("rejects forbidden transitions", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await createGoal(manager);

    expect(await captureAsyncError(() => manager.beginReview(created.id))).toBeInstanceOf(GoalTransitionError);
    await manager.start(created.id);
    expect(await captureAsyncError(() => manager.retry(created.id))).toBeInstanceOf(GoalTransitionError);
    await manager.beginReview(created.id);
    expect(await captureAsyncError(() => manager.start(created.id))).toBeInstanceOf(GoalTransitionError);
  });

  test("enforces reviewer finalization rules", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await createGoal(manager);
    await manager.start(created.id);
    await manager.beginReview(created.id);

    await expect(manager.finalizeReview(created.id, {
      verdict: "DONE",
      summary: "No evidence.",
      evidenceRefs: [],
      authorization: reviewerAuth(created.id),
    })).rejects.toBeInstanceOf(GoalReviewFinalizationError);
    await expect(manager.finalizeReview(created.id, {
      verdict: "NOT_DONE",
      summary: "",
      authorization: reviewerAuth(created.id),
    })).rejects.toBeInstanceOf(GoalReviewFinalizationError);
    await expect(manager.finalizeReview(created.id, {
      verdict: "DONE",
      summary: "All good.",
      evidenceRefs: [evidenceRef()],
      authorization: { ...reviewerAuth(created.id), agentName: "orchestrator" },
    })).rejects.toBeInstanceOf(GoalReviewerAuthorizationError);

    const completed = await manager.finalizeReview(created.id, {
      verdict: "DONE",
      summary: "All evidence passed.",
      evidenceRefs: [evidenceRef()],
      authorization: reviewerAuth(created.id),
    });
    expect(completed.status).toBe("done");
    expect(completed.finalSummary).toBe("All evidence passed.");
  });

  test("retry increments attempt and clears current review", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await createGoal(manager);
    await manager.start(created.id);
    await manager.beginReview(created.id);
    await manager.finalizeReview(created.id, {
      verdict: "NOT_DONE",
      summary: "Tests missing.",
      authorization: reviewerAuth(created.id),
    });
    expect(await captureAsyncError(() => manager.finalizeReview(created.id, {
      verdict: "NOT_DONE",
      summary: "duplicate",
      authorization: reviewerAuth(created.id),
    }))).toBeInstanceOf(GoalReviewFinalizationError);

    const retry = await manager.retry(created.id, { mainSessionId: "retry-session" });
    expect(retry).toMatchObject({ status: "running", attempt: 2, mainSessionId: "retry-session" });
    expect(retry.review).toBeUndefined();
    const reviewing = await manager.beginReview(created.id);
    expect(reviewing.status).toBe("reviewing");
  });

  test("records sessions, budget summaries, and HITL refs without duplicates", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const created = await createGoal(manager);
    await manager.start(created.id, { mainSessionId: "main-session" });

    await manager.addChildSession(created.id, "child-1");
    await manager.addChildSession(created.id, "child-1");
    await manager.recordHitlRef(created.id, { hitlId: "hitl-1", approvalRef: "approval-1" });
    await manager.recordHitlRef(created.id, { hitlId: "hitl-1", approvalRef: "approval-1" });
    const budgeted = await manager.updateBudgetSummary(created.id, {
      status: "warning",
      usedTokens: 50,
      maxTokens: 100,
      reason: "half used",
      updatedAt: new Date().toISOString(),
    });

    expect(budgeted.childSessionIds).toEqual(["child-1"]);
    expect(budgeted.pendingHitlIds).toEqual(["hitl-1"]);
    expect(budgeted.approvalRefs).toEqual(["approval-1"]);
    expect(budgeted.budget).toMatchObject({ status: "warning", usedTokens: 50, maxTokens: 100 });
  });

  test("rejects old persisted schema with a named unsupported error", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const goalId = VALID_UUID;
    const goalDir = join(TMP_DIR, PROJECT_STATE_DIR_NAME, "goals", goalId);
    await mkdir(goalDir, { recursive: true });
    const oldState: Record<string, unknown> = {
      id: goalId,
      projectId: "project-a",
      title: "Old state",
      status: "running",
      [`done${"Conditions"}`]: [],
      [`arti${"facts"}`]: [],
      [`ph${"ase"}`]: "plan",
      [`retry${"Policy"}`]: { maxRetries: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await Bun.write(join(goalDir, "goal.json"), `${JSON.stringify(oldState, null, 2)}\n`);

    const error = await captureAsyncError(() => manager.read(goalId));
    expect(error).toBeInstanceOf(GoalUnsupportedStateError);
    expect((error as GoalUnsupportedStateError).unsupportedKeys).toEqual(expect.arrayContaining([
      `done${"Conditions"}`,
      `arti${"facts"}`,
      `ph${"ase"}`,
      `retry${"Policy"}`,
    ]));
  });

  test("path validation and list filtering stay strict", async () => {
    const manager = new GoalStateManager(TMP_DIR);
    const valid = await createGoal(manager);
    const staleGoalId = "78878538-b50c-4357-b6b8-087b1683adb4";
    await mkdir(join(TMP_DIR, PROJECT_STATE_DIR_NAME, "goals", staleGoalId), { recursive: true });

    expect(await captureAsyncError(() => manager.read("../escape"))).toBeInstanceOf(GoalInvalidIdError);
    expect(await captureAsyncError(() => manager.read(VALID_UUID))).toBeInstanceOf(GoalNotFoundError);
    expect(await captureAsyncError(() => manager.resolveContainedPathForTest("../escape/goal.json"))).toBeInstanceOf(GoalPathError);
    expect((await manager.listGoals("project-a")).map((goal) => goal.id)).toEqual([valid.id]);
    expect((await readdir(join(TMP_DIR, PROJECT_STATE_DIR_NAME, "goals", valid.id))).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  });
});
