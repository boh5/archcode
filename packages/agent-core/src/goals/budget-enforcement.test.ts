import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GoalBudgetSummary } from "@archcode/protocol";

import type { ModelCallOptions } from "../config/provider";
import { HitlService } from "../hitl/service";
import type { ProjectContext } from "../projects/types";
import { SessionStoreManager } from "../store/session-store-manager";
import { createSessionStore } from "../store/store";
import { createTestProjectContext } from "../tools/test-project-context";
import { silentLogger } from "../logger";
import { BUDGET_APPROVAL_POINT, GoalBudgetEnforcementStopError, enforceGoalBudgetAfterStepEnd, enforceGoalBudgetBeforeModelCall } from "./budget-enforcement";
import type { GoalState } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-budget-enforcement");

let workspaceRoot = "";
let projectContext: ProjectContext;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  projectContext = createTestProjectContext(workspaceRoot);
  projectContext.hitl = new HitlService({
    workspaceRoot,
    project: projectContext.project,
    sessions: new SessionStoreManager({ logger: silentLogger }),
    goalState: projectContext.goalState,
  });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("Goal budget enforcement", () => {
  test("warning summary creates approval_budget_1 and blocks without artifact ledger", async () => {
    const goal = await createRunningGoal(budget({ status: "warning", usedTokens: 890, maxTokens: 1000 }));
    const store = createGoalStore(goal.id);

    const result = await enforceGoalBudgetBeforeModelCall({ store, projectContext, modelOptions: { maxOutputTokens: 50 } }).catch((error: unknown) => error);

    const pending = await waitForPendingBudgetApproval(goal.id);
    const blocked = await projectContext.goalState.read(goal.id);
    expect(result).toBeInstanceOf(GoalBudgetEnforcementStopError);
    expect(pending.source).toEqual({
      type: "goal_budget",
      goalId: goal.id,
      approvalPoint: BUDGET_APPROVAL_POINT,
      resumeStatus: "running",
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      pendingHitlIds: [pending.hitlId],
      blocker: { kind: "budget", hitlId: pending.hitlId, resumeStatus: "running" },
      budget: { status: "warning", usedTokens: 890, maxTokens: 1000, reason: "Budget warning approval is pending" },
    });
    expect(await Bun.file(join(workspaceRoot, ".archcode", "goals", goal.id, "budget.md")).exists()).toBe(false);
  });

  test("hard limit updates budget summary and blocks without budget.md", async () => {
    const goal = await createRunningGoal(budget({ status: "blocked", usedTokens: 1005, maxTokens: 1000 }));
    const store = createGoalStore(goal.id);

    const result = await enforceGoalBudgetBeforeModelCall({ store, projectContext, modelOptions: { maxOutputTokens: 50 } }).catch((error: unknown) => error);

    const blocked = await projectContext.goalState.read(goal.id);
    expect(result).toBeInstanceOf(GoalBudgetEnforcementStopError);
    expect(blocked.status).toBe("blocked");
    expect(blocked.budget).toMatchObject({ status: "blocked", usedTokens: 1005, maxTokens: 1000, reason: "Budget hard limit exceeded" });
    expect(blocked.blocker).toMatchObject({ kind: "budget", source: "hard_limit" });
    expect(await Bun.file(join(workspaceRoot, ".archcode", "goals", goal.id, "budget.md")).exists()).toBe(false);
  });

  test("after step usage update blocks when merged usage reaches hard limit", async () => {
    const goal = await createRunningGoal(budget({ status: "ok", usedTokens: 950, maxTokens: 1000 }));
    const store = createGoalStore(goal.id);
    store.setState({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60, reasoningTokens: 0, cachedInputTokens: 0 } }],
    });

    const result = await enforceGoalBudgetAfterStepEnd({ store, projectContext }).catch((error: unknown) => error);

    const blocked = await projectContext.goalState.read(goal.id);
    expect(result).toBeInstanceOf(GoalBudgetEnforcementStopError);
    expect(blocked.budget).toMatchObject({ status: "blocked", usedTokens: 1010, maxTokens: 1000 });
    expect(blocked.blocker).toMatchObject({ kind: "budget", summary: "Budget hard limit exceeded" });
  });
});

async function createRunningGoal(budgetSummary: GoalBudgetSummary): Promise<GoalState> {
  const goal = await projectContext.goalState.commit({
    id: crypto.randomUUID(),
    projectId: "test-project",
    createdFromSessionId: crypto.randomUUID(),
    objective: "Exercise budget enforcement.",
    acceptanceCriteria: "Budget enforcement updates Goal state only.",
    mainSessionId: "session-budget",
  });
  await projectContext.goalState.updateBudgetSummary(goal.id, budgetSummary);
  return await projectContext.goalState.read(goal.id);
}

function createGoalStore(goalId: string) {
  const store = createSessionStore("session-budget", workspaceRoot);
  store.setState({ agentName: "engineer", goalId, sessionRole: "main" });
  return store;
}

function budget(input: { status: GoalBudgetSummary["status"]; usedTokens: number; maxTokens: number }): GoalBudgetSummary {
  return {
    status: input.status,
    usedTokens: input.usedTokens,
    maxTokens: input.maxTokens,
    updatedAt: new Date("2026-07-03T00:00:00.000Z").toISOString(),
  };
}

async function waitForPendingBudgetApproval(goalId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pending = (await projectContext.hitl.list({ scope: "goal", ownerId: goalId })).find((request) => {
      return request.source.type === "goal_budget" && request.source.approvalPoint === BUDGET_APPROVAL_POINT;
    });
    if (pending) return pending;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for budget approval");
}
