import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { ProjectHitlQueue, type HitlRecord } from "../hitl/project-queue";
import { silentLogger } from "../logger";
import { GoalBudgetHandler } from "./budget-handler";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "budget-handler", crypto.randomUUID());
const NOW = new Date("2026-07-14T00:00:00.000Z");

let goals: GoalStateManager;
let queue: ProjectHitlQueue;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  goals = new GoalStateManager(TMP_ROOT, silentLogger);
  queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, now: () => NOW });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("GoalBudgetHandler", () => {
  test("approval clears the budget blocker and records an idempotent applied fact", async () => {
    const record = await answeredBudgetRecord("approved");
    const handler = new GoalBudgetHandler({ goalStateManager: goals, now: () => NOW });

    await handler.apply(record);
    await handler.apply(record);

    const goal = await goals.read(record.owner.id);
    expect(goal).toMatchObject({
      status: "running",
      budget: { status: "ok", reason: "Budget warning approved at warning-1" },
      appliedBudgetHitlIds: [record.hitlId],
    });
    expect(goal.budgetApproval).toBeUndefined();
  });

  test("denial blocks the budget without failing or cancelling Goal lifecycle", async () => {
    const record = await answeredBudgetRecord("denied");
    await new GoalBudgetHandler({ goalStateManager: goals, now: () => NOW }).apply(record);

    const goal = await goals.read(record.owner.id);
    expect(goal.status).toBe("running");
    expect(goal.budget).toMatchObject({ status: "blocked", reason: "Budget warning denied at warning-1" });
    expect(goal.appliedBudgetHitlIds).toEqual([record.hitlId]);
  });

  test("cancel is a denied budget decision rather than Goal cancellation", async () => {
    const goalId = await createBudgetGoal();
    const record = (await queue.create(budgetInput(goalId, "cancel"))).record;
    await goals.attachBudgetApproval(goalId, approval(record));
    const answered = await queue.cancel(record.hitlId, { type: "cancel", reason: "Keep the Goal blocked" });

    await new GoalBudgetHandler({ goalStateManager: goals, now: () => NOW }).apply(answered);

    const goal = await goals.read(goalId);
    expect(goal.status).toBe("running");
    expect(goal.budget).toMatchObject({ status: "blocked", reason: "Keep the Goal blocked" });
  });

  test("approval never overrides a hard-exceeded budget", async () => {
    const record = await answeredBudgetRecord("approved", { usedTokens: 1000, maxTokens: 1000 });
    await new GoalBudgetHandler({ goalStateManager: goals, now: () => NOW }).apply(record);

    expect((await goals.read(record.owner.id)).budget).toMatchObject({
      status: "blocked",
      reason: "Budget hard limit exceeded",
    });
  });

  test("rejects Session, non-budget, and unresolved records", async () => {
    const handler = new GoalBudgetHandler({ goalStateManager: goals });
    const goalId = await createBudgetGoal();
    const pending = (await queue.create(budgetInput(goalId, "pending"))).record;

    await expect(handler.apply(pending)).rejects.toThrow("requires an answered record");
    await expect(handler.apply({
      ...pending,
      owner: { type: "session", id: "session-1" },
      source: { type: "ask_user", toolCallId: "ask-1" },
    })).rejects.toThrow("cannot apply session owner");
  });
});

async function answeredBudgetRecord(
  decision: "approved" | "denied",
  usage: { usedTokens: number; maxTokens: number } = { usedTokens: 890, maxTokens: 1000 },
): Promise<HitlRecord> {
  const goalId = await createBudgetGoal(usage);
  const record = (await queue.create(budgetInput(goalId, decision))).record;
  await goals.attachBudgetApproval(goalId, approval(record));
  return await queue.respond(record.hitlId, { type: "budget_decision", decision });
}

async function createBudgetGoal(
  usage: { usedTokens: number; maxTokens: number } = { usedTokens: 890, maxTokens: 1000 },
): Promise<string> {
  const goalId = crypto.randomUUID();
  await goals.commit({
    id: goalId,
    projectSlug: "archcode",
    createdFromSessionId: "source-session",
    objective: "Test budget decisions.",
    acceptanceCriteria: "Budget decision is applied once.",
    mainSessionId: "goal-session",
  });
  await goals.updateBudgetSummary(goalId, {
    status: "warning",
    ...usage,
    reason: "Budget warning approval is pending",
    updatedAt: NOW.toISOString(),
  });
  return goalId;
}

function budgetInput(goalId: string, key: string) {
  return {
    requestKey: `goal:${goalId}:budget:${key}`,
    owner: { type: "goal" as const, id: goalId },
    source: { type: "goal_budget" as const, approvalPoint: "warning-1" },
    displayPayload: { title: "Approve Goal budget", redacted: true as const },
  };
}

function approval(record: HitlRecord) {
  return {
    hitlId: record.hitlId,
    approvalPoint: "warning-1",
  };
}
