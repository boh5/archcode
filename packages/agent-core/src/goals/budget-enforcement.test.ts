import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { DoneCondition, GoalTokenBudgetState } from "@archcode/protocol";

import type { ModelCallOptions } from "../config/provider";
import { HitlService } from "../hitl/service";
import type { HitlEvent } from "../hitl/types";
import type { ModelInfo } from "../provider/model";
import type { ProjectContext } from "../projects/types";
import { SkillService } from "../skills";
import { createSessionStore, storeManager } from "../store/store";
import { createRegistry } from "../tools";
import { createTestProjectContext } from "../tools/test-project-context";
import { silentLogger } from "../logger";
import { setLlmAdapterForTest } from "../llm";
import { runQueryLoop } from "../agents/query/loop";
import type { QueryLoopOptions } from "../agents/query/types";
import { BUDGET_APPROVAL_POINT, createGoalBudgetEnforcementHooks, enforceGoalBudgetBeforeModelCall } from "./budget-enforcement";
import type { GoalState } from "./state";

type StreamTextFn = typeof import("ai").streamText;

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-budget-enforcement");
const testSkillService = new SkillService({ builtinSkills: {} });
const condition: DoneCondition = { id: "tests", kind: "tests_pass", params: { command: "bun test" } };
const modelInfo = {
  model: { modelId: "mock-model", provider: "mock-provider" },
  displayName: "Mock Model",
  limit: { context: 1000, output: 100 },
  modalities: { input: ["text"], output: ["text"] },
  providerId: "mock-provider",
  modelId: "mock-model",
  qualifiedId: "mock-provider:mock-model",
} as unknown as ModelInfo;

let workspaceRoot = "";
let projectContext: ProjectContext;
let hitlEvents: Array<{ sessionId: string; event: HitlEvent }>;

beforeEach(async () => {
  setLlmAdapterForTest(undefined);
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  hitlEvents = [];
  projectContext = createTestProjectContext(workspaceRoot);
  projectContext.hitl = new HitlService({
    submitHitlEvent(sessionId, event) {
      hitlEvents.push({ sessionId, event });
    },
  });
  await projectContext.hitl.load(workspaceRoot);
});

afterAll(async () => {
  setLlmAdapterForTest(undefined);
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("Goal budget enforcement", () => {
  test("warning projection creates approval_budget_1 and pauses while approval is pending", async () => {
    const goal = await createRunningGoal(budget({ totalTokens: 890, warningThresholdTokens: 900, maxTokens: 1000 }));
    const store = createGoalStore(goal.id);
    const streamText = mockUnexpectedStreamText();
    const run = runQueryLoop(makeOptions(store, { maxOutputTokens: 50 }), "Continue Goal");

    const pending = await waitForPendingBudgetApproval();
    const paused = await waitForGoalStatus(goal.id, "paused");

    expect(pending.trigger.approvalPoint).toBe(BUDGET_APPROVAL_POINT);
    expect(pending.approvalKey).toBe(`${projectContext.project.slug}:${goal.id}:session-budget:approval_point:${BUDGET_APPROVAL_POINT}`);
    expect(paused.status).toBe("paused");
    expect(paused.tokenBudget).toMatchObject({ status: "paused", totalTokens: 890 });
    expect(streamText).toHaveBeenCalledTimes(0);

    projectContext.hitl.cancel(pending.hitlId, "test cleanup", projectContext.project.slug);
    await run;
  });

  test("approval denial pauses Goal before any model call", async () => {
    const goal = await createRunningGoal(budget({ totalTokens: 890, warningThresholdTokens: 900, maxTokens: 1000 }));
    const store = createGoalStore(goal.id);
    const streamText = mockUnexpectedStreamText();
    const run = runQueryLoop(makeOptions(store, { maxOutputTokens: 50 }), "Continue Goal");

    const pending = await waitForPendingBudgetApproval();
    projectContext.hitl.respond(pending.hitlId, { decision: "denied", comment: "Stop spending tokens" }, projectContext.project.slug);
    await run;

    const paused = await projectContext.goalState.read(goal.id);
    expect(streamText).toHaveBeenCalledTimes(0);
    expect(paused.status).toBe("paused");
    expect(paused.lastError).toBe("Budget warning approval denied");
  });

  test("hard limit pauses Goal, writes budget ledger, and prevents an additional model call", async () => {
    const goal = await createRunningGoal(budget({ totalTokens: 1005, warningThresholdTokens: 900, maxTokens: 1000 }));
    const store = createGoalStore(goal.id);
    const streamText = mockUnexpectedStreamText();

    await runQueryLoop(makeOptions(store, { maxOutputTokens: 50 }), "Continue Goal");

    const paused = await projectContext.goalState.read(goal.id);
    const ledger = await projectContext.goalArtifacts.readArtifact(goal.id, "budget.md");
    expect(streamText).toHaveBeenCalledTimes(0);
    expect(paused.status).toBe("paused");
    expect(paused.tokenBudget).toMatchObject({ status: "paused", totalTokens: 1005, maxTokens: 1000 });
    expect(paused.lastError).toBe("Budget hard limit exceeded");
    expect(ledger).toContain("# Budget Ledger");
    expect(ledger).toContain("Status | hard_limit_exceeded");
    expect(ledger).toContain("Total token count | 1005");
  });

  test("after step usage update hard stop prevents the next model call", async () => {
    const goal = await createRunningGoal(budget({ totalTokens: 950, warningThresholdTokens: 990, maxTokens: 1000 }));
    const store = createGoalStore(goal.id);
    const streamText = mockStreamTextOnce({
      finishReason: "tool-calls",
      text: "need a tool",
      usage: { inputTokens: 40, outputTokens: 20, reasoningTokens: 0, cachedInputTokens: 0, totalTokens: 60 },
      toolCalls: [],
    });

    await runQueryLoop(makeOptions(store, { maxOutputTokens: 10 }), "Continue Goal");

    const paused = await projectContext.goalState.read(goal.id);
    const ledger = await projectContext.goalArtifacts.readArtifact(goal.id, "budget.md");
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(paused.status).toBe("paused");
    expect(paused.tokenBudget).toMatchObject({ status: "paused", totalTokens: 1010, maxTokens: 1000 });
    expect(ledger).toContain("Source | after_step_usage_update");
    expect(ledger).toContain("Total token count | 1010");
  });

  test("acknowledged budget warning records approval and is not requested repeatedly without claiming running", async () => {
    const goal = await createRunningGoal(budget({ totalTokens: 890, warningThresholdTokens: 900, maxTokens: 1000 }));
    const store = createGoalStore(goal.id);
    const first = enforceGoalBudgetBeforeModelCall({ store, projectContext, modelOptions: { maxOutputTokens: 50 } });
    const pending = await waitForPendingBudgetApproval();

    projectContext.hitl.respond(pending.hitlId, { decision: "acknowledged", comment: "Budget accepted" }, projectContext.project.slug);
    await first;
    await enforceGoalBudgetBeforeModelCall({ store, projectContext, modelOptions: { maxOutputTokens: 50 } });

    const persisted = await projectContext.goalState.read(goal.id);
    const requestEvents = hitlEvents.filter((entry) => entry.event.type === "hitl.request");
    expect(requestEvents).toHaveLength(1);
    expect(projectContext.hitl.listPending(projectContext.project.slug, goal.id)).toHaveLength(0);
    expect(persisted.status).toBe("paused");
    expect(persisted.lastError).toBe("Budget warning approval is pending");
    expect(persisted.tokenBudget).toMatchObject({
      warningApprovalPoint: BUDGET_APPROVAL_POINT,
      warningApprovalThresholdTokens: 900,
      warningApprovedTotalTokens: 890,
    });
  });
});

async function createRunningGoal(tokenBudget: GoalTokenBudgetState): Promise<GoalState> {
  const goal = await projectContext.goalState.create("test-project", "Budgeted Goal", "architect", [condition]);
  await projectContext.goalState.lock(goal.id, "architect");
  await projectContext.goalState.updateSessionIds(goal.id, "session-budget", []);
  await projectContext.goalState.updateTokenBudget(goal.id, tokenBudget);
  return projectContext.goalState.transitionStatus(goal.id, "running");
}

function createGoalStore(goalId: string) {
  const store = createSessionStore("session-budget", workspaceRoot);
  store.setState({ agentName: "orchestrator", goalId, sessionRole: "main" });
  return store;
}

function makeOptions(store: ReturnType<typeof createGoalStore>, modelOptions: ModelCallOptions): QueryLoopOptions {
  const hooks = createGoalBudgetEnforcementHooks();
  return {
    modelInfo,
    logger: silentLogger,
    modelOptions,
    toolRegistry: createRegistry([]),
    store,
    allowedTools: [],
    agentSkills: [],
    skillService: testSkillService,
    storeManager,
    projectContext,
    workspaceRoot,
    hooks: {
      beforeModelCall: [hooks.beforeModelCall],
      afterStepEnd: [hooks.afterStepEnd],
    },
  };
}

function budget(input: { totalTokens: number; warningThresholdTokens: number; maxTokens: number }): GoalTokenBudgetState {
  return {
    status: input.totalTokens >= input.maxTokens ? "exceeded" : input.totalTokens >= input.warningThresholdTokens ? "warning" : "ok",
    maxTokens: input.maxTokens,
    warningThresholdTokens: input.warningThresholdTokens,
    inputTokens: input.totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    totalTokens: input.totalTokens,
    updatedAt: new Date("2026-07-03T00:00:00.000Z").toISOString(),
  };
}

function mockUnexpectedStreamText() {
  const streamText = mock(() => {
    throw new Error("Budget enforcement should stop before model calls");
  });
  setLlmAdapterForTest({ streamText: streamText as unknown as StreamTextFn });
  return streamText;
}

function mockStreamTextOnce(round: {
  finishReason: string;
  text: string;
  usage: unknown;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
}) {
  const streamText = mock(() => ({
    fullStream: (async function* () {
      yield { type: "text-delta" as const, text: round.text };
    })(),
    finishReason: Promise.resolve(round.finishReason),
    usage: Promise.resolve(round.usage),
    text: Promise.resolve(round.text),
    toolCalls: Promise.resolve(round.toolCalls),
    toolResults: Promise.resolve([]),
  }));
  setLlmAdapterForTest({ streamText: streamText as unknown as StreamTextFn });
  return streamText;
}

async function waitForPendingBudgetApproval() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pending = projectContext.hitl.listPending(projectContext.project.slug).find((request) => {
      return request.trigger.approvalPoint === BUDGET_APPROVAL_POINT;
    });
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for budget approval");
}

async function waitForGoalStatus(goalId: string, status: GoalState["status"]): Promise<GoalState> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const goal = await projectContext.goalState.read(goalId);
    if (goal.status === status) return goal;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for goal status ${status}`);
}
