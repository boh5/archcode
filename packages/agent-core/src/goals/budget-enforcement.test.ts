import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GoalBudgetSummary } from "@archcode/protocol";

import { ProjectHitlQueue } from "../hitl/project-queue";
import { createSessionStore } from "../store/store";
import { silentLogger } from "../logger";
import { createTestHitlCodec } from "../tools/test-project-context";
import {
  BUDGET_APPROVAL_POINT,
  GoalBudgetEnforcementStopError,
  enforceGoalBudgetAfterStepEnd,
  enforceGoalBudgetBeforeModelCall,
  type GoalBudgetProjectContext,
} from "./budget-enforcement";
import { GoalStateManager, type GoalState } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-budget-enforcement", crypto.randomUUID());

let workspaceRoot = "";
let projectContext: GoalBudgetProjectContext;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  projectContext = {
    goalState: new GoalStateManager(workspaceRoot, silentLogger),
    hitl: new ProjectHitlQueue({ workspaceRoot, codec: createTestHitlCodec() }),
  };
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("Goal budget enforcement", () => {
  test("warning summary creates approval_budget_1 without changing Goal lifecycle", async () => {
    const goal = await createRunningGoal(budget({ status: "warning", usedTokens: 890, maxTokens: 1000 }));
    const store = createGoalStore(goal.id);

    const result = await enforceGoalBudgetBeforeModelCall({ store, projectContext, modelOptions: { maxOutputTokens: 50 } }).catch((error: unknown) => error);

    const pending = await waitForPendingBudgetApproval(goal.id);
    const blocked = await projectContext.goalState.read(goal.id);
    expect(result).toBeInstanceOf(GoalBudgetEnforcementStopError);
    expect(pending.source).toEqual({
      type: "goal_budget",
      approvalPoint: BUDGET_APPROVAL_POINT,
    });
    expect(blocked).toMatchObject({
      status: "running",
      budgetApproval: { hitlId: pending.hitlId, approvalPoint: BUDGET_APPROVAL_POINT },
      budget: { status: "warning", usedTokens: 890, maxTokens: 1000, reason: "Budget warning approval is pending" },
    });
    expect(await Bun.file(join(workspaceRoot, ".archcode", "goals", goal.id, "budget.md")).exists()).toBe(false);
  });

  test("re-entry repairs a crash after idempotent queue creation without persisting a detached pending reason", async () => {
    const goal = await createRunningGoal(budget({ status: "warning", usedTokens: 890, maxTokens: 1000 }));
    const store = createGoalStore(goal.id);
    const goalState = projectContext.goalState;
    const realAttach = goalState.attachBudgetApproval.bind(goalState);
    let failAttach = true;
    goalState.attachBudgetApproval = async (goalId, input) => {
      if (failAttach) {
        failAttach = false;
        throw new Error("simulated attach crash");
      }
      return await realAttach(goalId, input);
    };

    const first = await enforceGoalBudgetBeforeModelCall({ store, projectContext, modelOptions: { maxOutputTokens: 50 } }).catch((error: unknown) => error);
    const afterCrash = await goalState.read(goal.id);
    const queue = projectContext.hitl as ProjectHitlQueue;
    const queuedAfterCrash = await queue.list({ owner: { type: "goal", id: goal.id } });

    expect(first).toBeInstanceOf(Error);
    expect(first).not.toBeInstanceOf(GoalBudgetEnforcementStopError);
    expect(afterCrash.budgetApproval).toBeUndefined();
    expect(afterCrash.budget?.reason).not.toBe("Budget warning approval is pending");
    expect(queuedAfterCrash).toHaveLength(1);

    const second = await enforceGoalBudgetBeforeModelCall({ store, projectContext, modelOptions: { maxOutputTokens: 50 } }).catch((error: unknown) => error);
    const repaired = await goalState.read(goal.id);
    const queuedAfterRepair = await queue.list({ owner: { type: "goal", id: goal.id } });

    expect(second).toBeInstanceOf(GoalBudgetEnforcementStopError);
    expect(queuedAfterRepair).toHaveLength(1);
    expect(repaired).toMatchObject({
      budgetApproval: { hitlId: queuedAfterCrash[0]?.hitlId, approvalPoint: BUDGET_APPROVAL_POINT },
      budget: { status: "warning", reason: "Budget warning approval is pending" },
    });
  });

  test("hard limit stops execution without changing Goal lifecycle", async () => {
    const goal = await createRunningGoal(budget({ status: "blocked", usedTokens: 1005, maxTokens: 1000 }));
    const store = createGoalStore(goal.id);

    const result = await enforceGoalBudgetBeforeModelCall({ store, projectContext, modelOptions: { maxOutputTokens: 50 } }).catch((error: unknown) => error);

    const blocked = await projectContext.goalState.read(goal.id);
    expect(result).toBeInstanceOf(GoalBudgetEnforcementStopError);
    expect(blocked.status).toBe("running");
    expect(blocked.budget).toMatchObject({ status: "blocked", usedTokens: 1005, maxTokens: 1000, reason: "Budget hard limit exceeded" });
    expect(blocked.budgetApproval).toBeUndefined();
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
    expect(blocked.status).toBe("running");
    expect(blocked.budgetApproval).toBeUndefined();
  });
});

async function createRunningGoal(budgetSummary: GoalBudgetSummary): Promise<GoalState> {
  const goal = await projectContext.goalState.commit({
    id: crypto.randomUUID(),
    projectSlug: "test-project",
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
    const queue = projectContext.hitl as ProjectHitlQueue;
    const pending = (await queue.list({ owner: { type: "goal", id: goalId }, statuses: ["pending"] })).find((request) => {
      return request.source.type === "goal_budget" && request.source.approvalPoint === BUDGET_APPROVAL_POINT;
    });
    if (pending) return pending;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for budget approval");
}
