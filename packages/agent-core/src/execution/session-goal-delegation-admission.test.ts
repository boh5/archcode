import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { createTestProjectContext } from "../tools/test-project-context";
import { testReviewExecutionFields } from "../goals/test-review-fixture";
import {
  RoleDrivenSessionGoalDelegationAdmission,
  SessionGoalDelegationDeniedError,
} from "./session-goal-delegation-admission";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-delegation-admission", crypto.randomUUID());

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("RoleDrivenSessionGoalDelegationAdmission", () => {
  test("allows the current running Goal family to use its normal delegate targets", async () => {
    const fixture = await createFixture("running");
    const action = mock(async () => "ok");
    await expect(fixture.admission.run({
      workspaceRoot: fixture.workspaceRoot,
      parent: fixture.main,
      targetAgentName: "build",
    }, action)).resolves.toBe("ok");
    expect(action).toHaveBeenCalledTimes(1);

    await expectDenied(fixture.admission.run({
      workspaceRoot: fixture.workspaceRoot,
      parent: fixture.main,
      targetAgentName: "reviewer",
    }, action));
    expect(action).toHaveBeenCalledTimes(1);
  });

  test("reviewing admits only main-to-reviewer and reviewer-to-read-only support", async () => {
    const fixture = await createFixture("reviewing");
    await fixture.context.goalState.beginReview(fixture.goal.id);
    const allow = async () => "ok";

    await expect(fixture.admission.run({
      workspaceRoot: fixture.workspaceRoot,
      parent: fixture.main,
      targetAgentName: "reviewer",
    }, allow)).resolves.toBe("ok");
    await expect(fixture.admission.run({
      workspaceRoot: fixture.workspaceRoot,
      parent: { ...fixture.main, sessionId: "review", parentSessionId: fixture.main.sessionId, agentName: "reviewer", sessionRole: "review" },
      isParentDescendantOfRoot: true,
      targetAgentName: "explore",
    }, allow)).resolves.toBe("ok");
    await expectDenied(fixture.admission.run({
      workspaceRoot: fixture.workspaceRoot,
      parent: fixture.main,
      targetAgentName: "build",
    }, allow));
    await expectDenied(fixture.admission.run({
      workspaceRoot: fixture.workspaceRoot,
      parent: { ...fixture.main, sessionId: "review", parentSessionId: fixture.main.sessionId, agentName: "reviewer", sessionRole: "review" },
      isParentDescendantOfRoot: true,
      targetAgentName: "build",
    }, allow));
  });

  test("not_done denies new and resumed child execution until the main retries", async () => {
    const fixture = await createFixture("not-done");
    await fixture.context.goalState.beginReview(fixture.goal.id);
    await fixture.context.goalState.finalizeReview(fixture.goal.id, {
      expectedReviewGeneration: 1,
      verdict: "NOT_DONE",
      ...testReviewExecutionFields("NOT_DONE"),
      summary: "Needs fixes",
      evidenceRefs: [],
      authorization: {
        agentName: "reviewer",
        sessionRole: "review",
        sessionGoalId: fixture.goal.id,
        reviewerSessionId: "review",
      },
    });
    const action = mock(async () => "must not run");
    await expectDenied(fixture.admission.run({
      workspaceRoot: fixture.workspaceRoot,
      parent: fixture.main,
      targetAgentName: "build",
    }, action));
    expect(action).not.toHaveBeenCalled();
  });

  test("passes the latest persisted Goal generation to an admitted delegation", async () => {
    const fixture = await createFixture("latest-generation");
    const firstReview = await fixture.context.goalState.beginReview(fixture.goal.id);
    await fixture.context.goalState.finalizeReview(fixture.goal.id, {
      expectedReviewGeneration: firstReview.reviewGeneration,
      verdict: "NOT_DONE",
      ...testReviewExecutionFields("NOT_DONE"),
      summary: "First review found missing coverage",
      evidenceRefs: [],
      authorization: {
        agentName: "reviewer",
        sessionRole: "review",
        sessionGoalId: fixture.goal.id,
        reviewerSessionId: "review-1",
      },
    });
    await fixture.context.goalState.retry(fixture.goal.id);
    const latest = await fixture.context.goalState.beginReview(fixture.goal.id);

    let received: unknown;
    await fixture.admission.run({
      workspaceRoot: fixture.workspaceRoot,
      parent: fixture.main,
      targetAgentName: "reviewer",
    }, async (context) => {
      received = context;
      return "ok";
    });

    expect(received).toEqual({
      goalId: fixture.goal.id,
      objective: "Protect Goal phase boundaries",
      acceptanceCriteria: "No forbidden child runs",
      status: "reviewing",
      attempt: 2,
      reviewGeneration: latest.reviewGeneration,
      lastFailureSummary: "First review found missing coverage",
    });
  });
});

async function createFixture(name: string) {
  const workspaceRoot = join(TMP_ROOT, name);
  await mkdir(workspaceRoot, { recursive: true });
  const context = createTestProjectContext(workspaceRoot);
  const mainSessionId = crypto.randomUUID();
  const goal = await context.goalState.commit({
    id: crypto.randomUUID(),
    projectSlug: context.project.slug,
    createdFromSessionId: crypto.randomUUID(),
    objective: "Protect Goal phase boundaries",
    acceptanceCriteria: "No forbidden child runs",
    mainSessionId,
  });
  const admission = new RoleDrivenSessionGoalDelegationAdmission({ resolve: async () => context });
  const main = {
    sessionId: mainSessionId,
    rootSessionId: mainSessionId,
    goalId: goal.id,
    agentName: "goal_lead" as const,
    sessionRole: "main" as const,
  };
  return { workspaceRoot, context, goal, admission, main };
}

async function expectDenied(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(SessionGoalDelegationDeniedError);
}
