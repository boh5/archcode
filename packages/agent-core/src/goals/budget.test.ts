import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { createEmptySessionStats } from "@archcode/protocol";
import type { GoalState, NormalizedUsage, SessionStats, ToolChildSessionLink } from "@archcode/protocol";

import { sessionFileInternals } from "../store/helpers";
import type { SessionFile } from "../store/helpers";
import type { SessionRole } from "../store/types";
import { calculateGoalTokenBudget, updateGoalTokenBudget } from "./budget";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-budget");
const FIXED_NOW = new Date("2026-07-03T00:00:00.000Z");

let workspaceRoot = "";
let manager: GoalStateManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = join(TMP_ROOT, crypto.randomUUID());
  await mkdir(workspaceRoot, { recursive: true });
  manager = new GoalStateManager(workspaceRoot);
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("Goal token budget accounting", () => {
  it("aggregates a transitive session tree from main to child to grandchild", async () => {
    const goal = await createGoal();
    const mainSessionId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const grandchildSessionId = crypto.randomUUID();

    await writeSession({ sessionId: mainSessionId, goalId: goal.id, sessionRole: "main", usage: usage(60, 30, 10, 100) });
    await writeSession({
      sessionId: childSessionId,
      rootSessionId: mainSessionId,
      parentSessionId: mainSessionId,
      goalId: goal.id,
      sessionRole: "build",
      usage: usage(20, 15, 5, 40),
    });
    await writeSession({
      sessionId: grandchildSessionId,
      rootSessionId: mainSessionId,
      parentSessionId: childSessionId,
      goalId: goal.id,
      sessionRole: "review",
      usage: usage(4, 5, 1, 10),
    });
    await manager.updateSessionIds(goal.id, mainSessionId, [childSessionId]);

    const result = await calculateGoalTokenBudget(workspaceRoot, await manager.read(goal.id), { now: () => FIXED_NOW });

    expect(result.includedSessionIds).toEqual([childSessionId, grandchildSessionId, mainSessionId].sort());
    expect(result.budget).toMatchObject({
      status: "ok",
      inputTokens: 84,
      outputTokens: 50,
      reasoningTokens: 16,
      cachedInputTokens: 0,
      totalTokens: 150,
      updatedAt: FIXED_NOW.toISOString(),
    });
  });

  it("includes failed attempts and retry sessions exactly once", async () => {
    const goal = await createGoal();
    const failedMainSessionId = crypto.randomUUID();
    const currentRetrySessionId = crypto.randomUUID();
    const duplicateChildSessionId = crypto.randomUUID();

    await writeSession({
      sessionId: failedMainSessionId,
      goalId: goal.id,
      sessionRole: "main",
      usage: usage(40, 35, 5, 80),
      executionStatus: "failed",
      childSessionLinks: [childLink(failedMainSessionId, duplicateChildSessionId), childLink(failedMainSessionId, duplicateChildSessionId)],
    });
    await writeSession({
      sessionId: duplicateChildSessionId,
      rootSessionId: failedMainSessionId,
      parentSessionId: failedMainSessionId,
      goalId: goal.id,
      sessionRole: "review",
      usage: usage(8, 8, 4, 20),
      executionStatus: "failed",
    });
    await writeSession({
      sessionId: currentRetrySessionId,
      goalId: goal.id,
      sessionRole: "main",
      usage: usage(100, 40, 10, 150),
    });
    await manager.updateSessionIds(goal.id, currentRetrySessionId, [duplicateChildSessionId, duplicateChildSessionId]);

    const result = await calculateGoalTokenBudget(workspaceRoot, await manager.read(goal.id), { now: () => FIXED_NOW });

    expect(result.includedSessionIds).toEqual([currentRetrySessionId, duplicateChildSessionId, failedMainSessionId].sort());
    expect(result.budget.totalTokens).toBe(250);
    expect(result.budget.inputTokens).toBe(148);
    expect(result.budget.outputTokens).toBe(83);
    expect(result.budget.reasoningTokens).toBe(19);
  });

  it("excludes background maintenance sessions linked outside Goal execution roles", async () => {
    const goal = await createGoal();
    const mainSessionId = crypto.randomUUID();
    const titleSessionId = crypto.randomUUID();
    const memorySessionId = crypto.randomUUID();
    const unrelatedGoalSessionId = crypto.randomUUID();

    await writeSession({
      sessionId: mainSessionId,
      goalId: goal.id,
      sessionRole: "main",
      usage: usage(60, 30, 10, 100),
      childSessionLinks: [
        childLink(mainSessionId, titleSessionId, { title: "title-generation", childAgentName: "title-generation", background: true }),
      ],
    });
    await writeSession({
      sessionId: titleSessionId,
      rootSessionId: mainSessionId,
      parentSessionId: mainSessionId,
      goalId: goal.id,
      title: "title-generation",
      agentName: "title-generation",
      usage: usage(400, 400, 199, 999),
    });
    await writeSession({
      sessionId: memorySessionId,
      goalId: goal.id,
      title: "memory-extraction",
      agentName: "memory-extraction",
      usage: usage(499, 400, 100, 999),
    });
    await writeSession({
      sessionId: unrelatedGoalSessionId,
      goalId: crypto.randomUUID(),
      sessionRole: "main",
      usage: usage(500, 400, 99, 999),
    });
    await manager.updateSessionIds(goal.id, mainSessionId, []);

    const result = await calculateGoalTokenBudget(workspaceRoot, await manager.read(goal.id), { now: () => FIXED_NOW });

    expect(result.includedSessionIds).toEqual([mainSessionId]);
    expect(result.excludedMaintenanceSessionIds).toEqual([memorySessionId, titleSessionId].sort());
    expect(result.budget.totalTokens).toBe(100);
  });

  it("persists idempotently by overwriting the Goal tokenBudget state", async () => {
    const goal = await createGoal();
    const mainSessionId = crypto.randomUUID();
    await writeSession({ sessionId: mainSessionId, goalId: goal.id, sessionRole: "main", usage: usage(90, 50, 10, 150) });
    await manager.updateSessionIds(goal.id, mainSessionId, []);

    const first = await updateGoalTokenBudget(manager, workspaceRoot, goal.id, {
      warningThresholdTokens: 100,
      maxTokens: 200,
      now: () => FIXED_NOW,
    });
    const second = await updateGoalTokenBudget(manager, workspaceRoot, goal.id, {
      warningThresholdTokens: 100,
      maxTokens: 200,
      now: () => FIXED_NOW,
    });
    const persisted = await manager.read(goal.id);

    expect(first.budget).toEqual(second.budget);
    expect(persisted.tokenBudget).toEqual(first.budget);
    expect(persisted.tokenBudget).toMatchObject({ status: "warning", totalTokens: 150, maxTokens: 200, warningThresholdTokens: 100 });
  });

  it("marks the budget exceeded when the hard token limit is reached", async () => {
    const goal = await createGoal();
    const mainSessionId = crypto.randomUUID();
    await writeSession({ sessionId: mainSessionId, goalId: goal.id, sessionRole: "main", usage: usage(120, 70, 10, 200) });
    await manager.updateSessionIds(goal.id, mainSessionId, []);

    const result = await calculateGoalTokenBudget(workspaceRoot, await manager.read(goal.id), {
      warningThresholdTokens: 100,
      maxTokens: 200,
      now: () => FIXED_NOW,
    });

    expect(result.budget.status).toBe("exceeded");
  });
});

async function createGoal(): Promise<GoalState> {
  const goal = await manager.create("project-a", "Token budget", "architect", [{
    id: "tests",
    kind: "tests_pass",
    params: { command: "bun test" },
  }]);
  return manager.lock(goal.id, "architect");
}

async function writeSession(input: {
  readonly sessionId: string;
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
  readonly goalId?: string;
  readonly sessionRole?: SessionRole;
  readonly agentName?: string;
  readonly title?: string;
  readonly usage?: NormalizedUsage;
  readonly executionStatus?: SessionFile["executions"][number]["status"];
  readonly childSessionLinks?: ToolChildSessionLink[];
}): Promise<void> {
  const stats: SessionStats = {
    ...createEmptySessionStats(),
    usage: input.usage ?? createEmptySessionStats().usage,
  };
  await sessionFileInternals.saveSessionTranscript({
    sessionId: input.sessionId,
    createdAt: 1,
    agentName: input.agentName ?? roleAgentName(input.sessionRole),
    title: input.title ?? null,
    messages: [],
    steps: [],
    stats,
    executions: [{ id: `${input.sessionId}:run`, startedAt: 1, status: input.executionStatus ?? "completed", endedAt: 2, durationMs: 1 }],
    todos: [],
    pendingInteractions: [],
    reminders: [],
    childSessionLinks: input.childSessionLinks ?? [],
    rootSessionId: input.rootSessionId ?? input.sessionId,
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
    ...(input.sessionRole === undefined ? {} : { sessionRole: input.sessionRole }),
  }, workspaceRoot);
}

function usage(inputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number): NormalizedUsage {
  return { inputTokens, outputTokens, reasoningTokens, totalTokens, cachedInputTokens: 0 };
}

function childLink(
  parentSessionId: string,
  childSessionId: string,
  overrides: Partial<ToolChildSessionLink> = {},
): ToolChildSessionLink {
  return {
    parentSessionId,
    parentToolCallId: `${childSessionId}:tool`,
    toolName: "delegate",
    childSessionId,
    childAgentName: "build",
    depth: 1,
    background: false,
    status: "completed",
    createdAt: 1,
    ...overrides,
  };
}

function roleAgentName(role: SessionRole | undefined): string {
  if (role === "review") return "reviewer";
  return role ?? "orchestrator";
}
