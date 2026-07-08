import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GoalEvidenceRef } from "@archcode/protocol";

import { GoalRunner, GoalRunnerError } from "./runner";
import { GoalReviewFinalizationError, GoalReviewerAuthorizationError, GoalStateManager, GoalTransitionError } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-runner");

let workspaceRoot = "";
let manager: GoalStateManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function createRunner(sessionIds = ["main-session-1", "retry-session-2"]): GoalRunner {
  const remaining = [...sessionIds];
  return new GoalRunner({
    goalStateManager: manager,
    createSession: mock(async () => remaining.shift() ?? `session-${crypto.randomUUID()}`),
  });
}

async function createDraft(runner: GoalRunner) {
  return runner.create({
    projectId: "project-a",
    title: "Ship runner facade",
    objective: "Exercise the thin goal runner facade.",
    acceptanceCriteria: "Runner delegates to state manager and enforces reviewer finalization.",
  });
}

function evidenceRef(summary = "Targeted tests passed"): GoalEvidenceRef {
  return { kind: "test_output", ref: "runner-test", summary };
}

function reviewerAuth(goalId: string) {
  return {
    agentName: "reviewer",
    sessionRole: "review",
    sessionGoalId: goalId,
    reviewerSessionId: "review-session-1",
  };
}

describe("GoalRunner", () => {
  test("creates, patches, and starts a goal with a main session", async () => {
    const runner = createRunner();
    const draft = await createDraft(runner);
    const patched = await runner.patchDraft(draft.id, { title: "Patched runner goal" });
    const running = await runner.start(patched.id);

    expect(running).toMatchObject({
      status: "running",
      title: "Patched runner goal",
      mainSessionId: "main-session-1",
    });
    expect(await manager.read(draft.id)).toMatchObject({ status: "running", mainSessionId: "main-session-1" });
  });

  test("start is idempotent for an already running matching session", async () => {
    const runner = createRunner(["main-session-1"]);
    const draft = await createDraft(runner);

    const first = await runner.start(draft.id, { mainSessionId: "reserved-session" });
    const second = await runner.start(draft.id, { mainSessionId: "reserved-session" });

    expect(first.status).toBe("running");
    expect(second).toEqual(first);
  });

  test("requires createSession when no main session is available", async () => {
    const runner = new GoalRunner({ goalStateManager: manager });
    const draft = await createDraft(runner);

    await expect(runner.start(draft.id)).rejects.toBeInstanceOf(GoalRunnerError);
  });

  test("blocks and clears back to requested resume status", async () => {
    const runner = createRunner();
    const draft = await createDraft(runner);
    await runner.start(draft.id);

    const blocked = await runner.block(draft.id, {
      kind: "approval",
      summary: "Need approval",
      hitlId: "hitl-1",
      resumeStatus: "reviewing",
    });
    expect(blocked).toMatchObject({ status: "blocked", pendingHitlIds: ["hitl-1"] });

    const reviewing = await runner.clearBlocker(draft.id, "hitl-1");
    expect(reviewing).toMatchObject({ status: "reviewing", pendingHitlIds: [] });
  });

  test("finalizes DONE only from reviewer authorization with evidence", async () => {
    const runner = createRunner();
    const draft = await createDraft(runner);
    await runner.start(draft.id);
    await runner.beginReview(draft.id);

    await expect(runner.finalizeReview(draft.id, {
      verdict: "DONE",
      summary: "Missing evidence.",
      evidenceRefs: [],
      authorization: reviewerAuth(draft.id),
    })).rejects.toBeInstanceOf(GoalReviewFinalizationError);
    await expect(runner.finalizeReview(draft.id, {
      verdict: "DONE",
      summary: "Wrong agent.",
      evidenceRefs: [evidenceRef()],
      authorization: { ...reviewerAuth(draft.id), agentName: "build" },
    })).rejects.toBeInstanceOf(GoalReviewerAuthorizationError);

    const done = await runner.finalizeReview(draft.id, {
      verdict: "DONE",
      summary: "Reviewer verified all criteria.",
      evidenceRefs: [evidenceRef()],
      authorization: reviewerAuth(draft.id),
    });

    expect(done.status).toBe("done");
    expect(done.review).toMatchObject({ verdict: "DONE", reviewerSessionId: "review-session-1" });
    await expect(runner.cancel(done.id, "too late")).rejects.toBeInstanceOf(GoalTransitionError);
  });

  test("finalizes NOT_DONE, rejects duplicate finalization, then explicit retry clears review", async () => {
    const runner = createRunner();
    const draft = await createDraft(runner);
    await runner.start(draft.id);
    await runner.beginReview(draft.id);

    const notDone = await runner.finalizeReview(draft.id, {
      verdict: "NOT_DONE",
      summary: "Acceptance criteria need repair.",
      unresolvedItems: ["Add targeted tests"],
      authorization: reviewerAuth(draft.id),
    });
    expect(notDone).toMatchObject({ status: "not_done", lastFailureSummary: "Acceptance criteria need repair." });

    await expect(runner.finalizeReview(draft.id, {
      verdict: "NOT_DONE",
      summary: "duplicate",
      authorization: reviewerAuth(draft.id),
    })).rejects.toBeInstanceOf(GoalReviewFinalizationError);

    const retry = await runner.retry(draft.id);
    expect(retry).toMatchObject({ status: "running", attempt: 1, mainSessionId: "retry-session-2" });
    expect(retry.review).toBeUndefined();
    expect((await runner.beginReview(draft.id)).status).toBe("reviewing");
  });

  test("fail and cancel follow the simplified transition graph", async () => {
    const runner = createRunner();
    const failing = await createDraft(runner);
    await runner.start(failing.id);
    const failed = await runner.fail(failing.id, new Error("verification crashed"));
    expect(failed).toMatchObject({ status: "failed", lastFailureSummary: "verification crashed" });
    expect(failed.lastError).toMatchObject({ name: "Error", message: "verification crashed" });
    expect((await runner.retry(failing.id)).status).toBe("running");

    const cancelledDraft = await createDraft(runner);
    expect((await runner.cancel(cancelledDraft.id, "duplicate request")).status).toBe("cancelled");
  });

  test("tracks child sessions, main session, budget, and HITL refs", async () => {
    const runner = createRunner();
    const draft = await createDraft(runner);
    await runner.start(draft.id);
    await runner.setMainSession(draft.id, "explicit-main");
    await runner.addChildSession(draft.id, "child-1");
    await runner.recordHitlRef(draft.id, { hitlId: "hitl-1", approvalRef: "approval-1" });
    const budgeted = await runner.updateBudgetSummary(draft.id, {
      status: "ok",
      usedTokens: 10,
      maxTokens: 100,
      updatedAt: new Date().toISOString(),
    });

    expect(budgeted).toMatchObject({
      mainSessionId: "explicit-main",
      childSessionIds: ["child-1"],
      pendingHitlIds: ["hitl-1"],
      approvalRefs: ["approval-1"],
      budget: { status: "ok", usedTokens: 10, maxTokens: 100 },
    });
  });
});
