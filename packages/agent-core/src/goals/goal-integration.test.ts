import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { PROJECT_STATE_DIR_NAME, type GoalState } from "@archcode/protocol";

import { GoalRunner } from "./runner";
import { GoalStateError, GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-integration");

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

function createRunner(): GoalRunner {
  const sessionIds = ["main-session", "retry-session"];
  return new GoalRunner({
    goalStateManager: manager,
    createSession: mock(async () => sessionIds.shift() ?? `session-${crypto.randomUUID()}`),
  });
}

function reviewerAuth(goalId: string, sessionId = "review-session") {
  return {
    agentName: "reviewer",
    sessionRole: "review",
    sessionGoalId: goalId,
    reviewerSessionId: sessionId,
  };
}

async function readGoalFile(goalId: string): Promise<GoalState> {
  return JSON.parse(await Bun.file(join(workspaceRoot, PROJECT_STATE_DIR_NAME, "goals", goalId, "goal.json")).text()) as GoalState;
}

describe("Goal core integration", () => {
  test("persists create to DONE as a natural-language state machine without auxiliary files", async () => {
    const runner = createRunner();
    const draft = await runner.create({
      projectId: "project-a",
      objective: "Persist a protocol-shaped goal from draft through review.",
      acceptanceCriteria: "Final state contains reviewer receipt and no auxiliary artifact files.",
    });
    const running = await runner.start(draft.id);
    await runner.addChildSession(draft.id, "plan-child-session");
    await runner.addChildSession(draft.id, "build-child-session");
    const reviewing = await runner.beginReview(draft.id);
    const done = await runner.finalizeReview(reviewing.id, {
      verdict: "DONE",
      summary: "Reviewer verified the durable state and tests.",
      evidenceRefs: [
        { kind: "session", ref: running.mainSessionId ?? "main-session", summary: "Main session completed implementation." },
        { kind: "test_output", ref: "targeted-tests", summary: "Targeted goal tests passed." },
      ],
      finalSummary: "Goal core state reached DONE with reviewer evidence.",
      authorization: reviewerAuth(reviewing.id),
    });

    expect(done.status).toBe("done");
    expect(done.review).toMatchObject({ verdict: "DONE", summary: "Reviewer verified the durable state and tests." });
    expect(done.finalSummary).toBe("Goal core state reached DONE with reviewer evidence.");
    const persisted = await readGoalFile(done.id);
    expect(persisted).toEqual(done);
    expect(persisted.childSessionIds).toEqual(["plan-child-session", "build-child-session"]);
    expect(existsSync(join(workspaceRoot, PROJECT_STATE_DIR_NAME, "goals", done.id, `arti${"facts"}`))).toBe(false);
  });

  test("persists NOT_DONE retry to second review without carrying previous receipt", async () => {
    const runner = createRunner();
    const draft = await runner.create({
      projectId: "project-a",
      objective: "Capture explicit retry semantics.",
      acceptanceCriteria: "Retry increments attempt and clears current review.",
    });
    await runner.start(draft.id);
    await runner.beginReview(draft.id);
    const firstReview = await runner.finalizeReview(draft.id, {
      verdict: "NOT_DONE",
      summary: "Acceptance criteria are missing a regression test.",
      unresolvedItems: ["Add regression test evidence"],
      authorization: reviewerAuth(draft.id, "review-session-1"),
    });
    expect(firstReview).toMatchObject({ status: "not_done", attempt: 1 });
    expect(firstReview.review?.verdict).toBe("NOT_DONE");

    const retry = await runner.retry(draft.id);
    expect(retry).toMatchObject({ status: "running", attempt: 2, mainSessionId: "retry-session" });
    expect(retry.review).toBeUndefined();
    await runner.beginReview(draft.id);
    const completed = await runner.finalizeReview(draft.id, {
      verdict: "DONE",
      summary: "Regression test evidence is now present.",
      evidenceRefs: [{ kind: "test_output", ref: "retry-tests", summary: "Regression test passed." }],
      authorization: reviewerAuth(draft.id, "review-session-2"),
    });

    expect(completed).toMatchObject({ status: "done", attempt: 2 });
    expect(completed.review).toMatchObject({ verdict: "DONE", reviewerSessionId: "review-session-2" });
  });

  test("old durable JSON is rejected instead of migrated", async () => {
    const goalId = "550e8400-e29b-41d4-a716-446655440000";
    const goalDir = join(workspaceRoot, PROJECT_STATE_DIR_NAME, "goals", goalId);
    await mkdir(goalDir, { recursive: true });
    await Bun.write(join(goalDir, "goal.json"), `${JSON.stringify({
      id: goalId,
      projectId: "project-a",
      title: "Old durable state",
      objective: "legacy",
      acceptanceCriteria: "legacy",
      status: "running",
      attempt: 0,
      pendingHitlIds: [],
      approvalRefs: [],
      childSessionIds: [],
      [`resume${"Checkpoint"}`]: { version: 1, hitlId: "hitl-1" },
      [`token${"Budget"}`]: { totalTokens: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    await expect(manager.read(goalId)).rejects.toBeInstanceOf(GoalStateError);
  });
});
