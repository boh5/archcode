import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  TOOL_GOAL_EVIDENCE,
  TOOL_GOAL_MANAGE,
  type DoneCondition,
  type DoneResult,
  type GoalArtifactName,
  type GoalPhase,
  type GoalReviewOutcome,
  type GoalState,
  type GoalStatus,
  type GoalTokenBudgetState,
} from "@archcode/protocol";

import { ResumeCoordinator } from "../hitl/resume-coordinator";
import { HitlService } from "../hitl/service";
import { setLlmAdapterForTest } from "../llm";
import { runLlmText } from "../llm/run-text";
import type { LlmTextInput } from "../llm/types";
import { LoopStateManager } from "../loops/state";
import { SkillService } from "../skills";
import { createSessionStore, storeManager } from "../store/store";
import type { SessionStoreState } from "../store/types";
import { createRegistry } from "../tools/registry";
import { createTestProjectContext } from "../tools/test-project-context";
import { createToolExecutionContext } from "../tools/types";
import { goalEvidenceTool, goalManageTool } from "../tools/builtins/goal-tools";
import { BUDGET_APPROVAL_POINT, enforceGoalBudgetBeforeModelCall } from "./budget-enforcement";
import { GoalArtifactManager } from "./artifacts";
import { GoalHitlResumeAdapter } from "./hitl-resume-adapter";
import { GoalRunner } from "./runner";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-integration");
const EVIDENCE_ROOT = join(import.meta.dir, "..", "..", "..", "..", ".sisyphus", "evidence");
const RAW_PRIVATE_MARKER = "RAW_MODEL_PRIVATE_TEXT";
const dummyModel = {} as LlmTextInput["model"];
const testSkillService = new SkillService({ builtinSkills: {} });
const canonicalArtifacts: GoalArtifactName[] = ["plan.md", "build.md", "review.md", "spec-compliance.md", "approvals.md", "budget.md", "retry-log.md", "final-report.md"];

const artifactExistsCondition: DoneCondition = {
  id: "artifact-exists",
  kind: "file_exists",
  params: { path: "artifact.txt" },
};

const artifactMentionsPlanCondition: DoneCondition = {
  id: "artifact-mentions-plan",
  kind: "grep_contains",
  params: { path: "artifact.txt", pattern: "approved plan", minMatches: 1 },
};

const specComplianceCondition: DoneCondition = {
  id: "goal_test_done",
  kind: "spec_compliance",
  params: { specPath: "SPEC.md", focusAreas: ["AC-001", "AC-002"] },
};

const mockGenerateText = mock(async (input: Record<string, unknown>) => {
  void input;
  return { text: "ok", toolCalls: [] };
});

let workspaceRoot = "";
let manager: GoalStateManager;
let artifacts: GoalArtifactManager;
let loops: LoopStateManager;

beforeEach(async () => {
  storeManager.clearAll();
  mockGenerateText.mockReset();
  mockGenerateText.mockImplementation(async (input: Record<string, unknown>) => {
    void input;
    return { text: "ok", toolCalls: [] };
  });
  setLlmAdapterForTest({ generateText: mockGenerateText as never });

  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
  artifacts = new GoalArtifactManager(workspaceRoot);
  loops = new LoopStateManager(workspaceRoot);
});

afterAll(async () => {
  setLlmAdapterForTest(undefined);
  storeManager.clearAll();
  await rm(TMP_ROOT, { recursive: true, force: true });
});

async function createHitlRunner(options: {
  sessionIds?: string[];
  now?: () => Date;
  retryDelay?: (ms: number, abort: AbortSignal) => Promise<void>;
} = {}): Promise<{ runner: GoalRunner; hitl: HitlService; coordinator: ResumeCoordinator }> {
  const remainingSessionIds = [...(options.sessionIds ?? ["main-session-1", "retry-session-2", "retry-session-3"])] as string[];
  const hitl = new HitlService({
    workspaceRoot,
    project: { slug: "project-a", name: "Project A" },
    sessions: storeManager,
    goalState: manager,
    loopState: loops,
  });
  let runner: GoalRunner;
  runner = new GoalRunner({
    goalStateManager: manager,
    goalArtifacts: artifacts,
    workspaceRoot,
    hitlService: hitl,
    createSession: mock(async () => remainingSessionIds.shift() ?? `session-${crypto.randomUUID()}`),
    isSessionActive: mock(async () => false),
    now: options.now,
    retryDelay: options.retryDelay,
  });
  const coordinator = new ResumeCoordinator({
    hitl,
    adapters: {
      goal: new GoalHitlResumeAdapter({
        workspaceRoot,
        goalStateManager: manager,
        goalArtifacts: artifacts,
        hitlService: hitl,
        createRunner: () => runner,
      }),
    },
  });
  return {
    hitl,
    runner,
    coordinator,
  };
}

function appendGoalStateChange(store: ReturnType<typeof createSessionStore>, state: GoalState): void {
  store.getState().append({ type: "goal.state_change", goalId: state.id, status: state.status, state });
}

function stateChangePhaseSequence(state: SessionStoreState): string[] {
  return state.events
    .map((event) => event.payload)
    .filter((payload): payload is Extract<typeof payload, { type: "goal.state_change" }> => payload.type === "goal.state_change")
    .map((payload) => `${payload.status}:${payload.state.phase}`);
}

function stateChangeStatuses(state: SessionStoreState): GoalStatus[] {
  return state.events
    .map((event) => event.payload)
    .filter((payload): payload is Extract<typeof payload, { type: "goal.state_change" }> => payload.type === "goal.state_change")
    .map((payload) => payload.status);
}

async function waitForGoal(goalId: string, predicate: (goal: GoalState) => boolean): Promise<GoalState> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const goal = await manager.read(goalId);
    if (predicate(goal)) return goal;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Goal state");
}

function goalStateFilePath(goalId: string): string {
  return join(workspaceRoot, ".archcode", "goals", goalId, "goal.json");
}

async function readGoalStateFile(goalId: string): Promise<GoalState> {
  return JSON.parse(await Bun.file(goalStateFilePath(goalId)).text()) as GoalState;
}

async function executeGoalEvidence(
  store: ReturnType<typeof createSessionStore>,
  goalId: string,
  conditionId: string,
): Promise<DoneResult> {
  const result = await executeGoalEvidenceRaw(store, goalId, conditionId);
  expect(result.isError).toBe(false);
  return JSON.parse(result.output) as DoneResult;
}

async function executeGoalEvidenceRaw(
  store: ReturnType<typeof createSessionStore>,
  goalId: string,
  conditionId: string,
) {
  const registry = createRegistry([goalEvidenceTool]);
  const input = { action: "check_done", goalId, conditionId };
  const ctx = createToolExecutionContext({
    store,
    storeManager,
    toolName: TOOL_GOAL_EVIDENCE,
    toolCallId: `${TOOL_GOAL_EVIDENCE}-${conditionId}`,
    input,
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set([TOOL_GOAL_EVIDENCE]),
    agentName: store.getState().agentName,
    agentSkills: [],
    skillService: testSkillService,
    projectContext: goalToolProjectContext(),
  });

  const result = await registry.execute(
    { toolName: TOOL_GOAL_EVIDENCE, toolCallId: `${TOOL_GOAL_EVIDENCE}-${conditionId}`, input },
    ctx,
  );
  return result;
}

async function executeGoalManage(
  store: ReturnType<typeof createSessionStore>,
  input:
    | { action: "create"; title: string; author: string; doneConditions: DoneCondition[]; retryPolicy: GoalState["retryPolicy"]; approvalPoints: GoalState["approvalPoints"] }
    | { action: "lock"; goalId: string }
    | { action: "start"; goalId: string }
    | { action: "advance_phase"; goalId: string; nextPhase: Extract<GoalPhase, "build" | "review"> }
    | { action: "retry"; goalId: string }
    | { action: "finalize_review"; goalId: string; outcome: GoalReviewOutcome; summary?: string },
): Promise<GoalState> {
  const result = await executeGoalManageRaw(store, input);
  expect(result.isError).toBe(false);
  return JSON.parse(result.output) as GoalState;
}

async function executeGoalManageRaw(
  store: ReturnType<typeof createSessionStore>,
  input:
    | { action: "create"; title: string; author: string; doneConditions: DoneCondition[]; retryPolicy: GoalState["retryPolicy"]; approvalPoints: GoalState["approvalPoints"] }
    | { action: "lock"; goalId: string }
    | { action: "start"; goalId: string }
    | { action: "advance_phase"; goalId: string; nextPhase: Extract<GoalPhase, "build" | "review"> }
    | { action: "retry"; goalId: string }
    | { action: "finalize_review"; goalId: string; outcome: GoalReviewOutcome; summary?: string },
) {
  const registry = createRegistry([goalManageTool]);
  const ctx = createToolExecutionContext({
    store,
    storeManager,
    toolName: TOOL_GOAL_MANAGE,
    toolCallId: `${TOOL_GOAL_MANAGE}-${input.action}`,
    input,
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set([TOOL_GOAL_MANAGE]),
    agentName: store.getState().agentName,
    agentSkills: [],
    skillService: testSkillService,
    projectContext: goalToolProjectContext(),
  });

  return registry.execute({ toolName: TOOL_GOAL_MANAGE, toolCallId: `${TOOL_GOAL_MANAGE}-${input.action}`, input }, ctx);
}

function goalToolProjectContext() {
  const projectContext = createTestProjectContext(workspaceRoot);
  projectContext.project = { ...projectContext.project, slug: "project-a", name: "Project A" };
  projectContext.goalState = manager;
  projectContext.goalArtifacts = artifacts;
  return projectContext;
}

function generateTextPrompts(): string[] {
  return (mockGenerateText.mock.calls as unknown as Array<[Record<string, unknown>]>).map((call) => String(call[0].prompt));
}

function tokenBudget(totalTokens: number): GoalTokenBudgetState {
  return {
    status: "ok",
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    totalTokens,
    warningThresholdTokens: 900,
    maxTokens: 1000,
    updatedAt: "2026-07-03T00:00:00.000Z",
  };
}

function task18Spec(ac002Status: "satisfied" | "failed"): string {
  const ac002Evidence = ac002Status === "satisfied"
    ? "retry repaired artifact tabs and redacted approval queue coverage"
    : "Goal detail retry tab coverage missing";
  const ac002Repair = ac002Status === "satisfied"
    ? "none"
    : "Repair AC-002 by adding Goal detail artifact tabs and redacted approval queue verification";
  return [
    "# goal_test_done Spec",
    "",
    "- AC-001: Canonical artifacts exist status: satisfied; evidence: plan, build, review, and final artifacts are present; file: .archcode/goals; command: goal_evidence action:check_done; result: artifact set verified",
    `- AC-002: Goal daily-use UI and retry evidence status: ${ac002Status}; evidence: ${ac002Evidence}; file: apps/web/src/routes/goal-detail.test.tsx, apps/web/src/routes/dashboard.test.tsx; command: bun test apps/web/src/routes/goal-detail.test.tsx apps/web/src/routes/dashboard.test.tsx; result: ${ac002Status === "satisfied" ? "web route checks pass" : "web route checks incomplete"}; repair: ${ac002Repair}`,
    "",
  ].join("\n");
}

async function waitForPendingApproval(hitl: HitlService, goalId: string, approvalPoint: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pending = (await hitl.list({ scope: "goal", ownerId: goalId })).find((request) => {
      return "approvalPoint" in request.source && request.source.approvalPoint === approvalPoint;
    });
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${approvalPoint} approval`);
}

async function approvePending(coordinator: ResumeCoordinator, hitl: HitlService, goalId: string, approvalPoint: string, comment: string): Promise<void> {
  const pending = await waitForPendingApproval(hitl, goalId, approvalPoint);
  const serialized = JSON.stringify(pending);
  expect(pending.displayPayload?.redacted).toBe(true);
  expect(serialized).toContain("displayPayload");
  expect(serialized).not.toContain("sk-test-secret");
  const result = await coordinator.respond(pending.hitlId, { type: "approval_decision", decision: "approved", comment });
  expect(result.scheduled).toBe(true);
  await waitForGoal(goalId, (goal) => goal.resumeCheckpoint === undefined);
}

async function requestBudgetApprovalThroughHook(coordinator: ResumeCoordinator, hitl: HitlService, goal: GoalState): Promise<GoalState> {
  const projectContext = createTestProjectContext(workspaceRoot);
  projectContext.project = { ...projectContext.project, slug: "project-a", name: "Project A" };
  projectContext.goalState = manager;
  projectContext.goalArtifacts = artifacts;
  projectContext.hitl = hitl;

  const store = createSessionStore(goal.mainSessionId ?? "budget-session", workspaceRoot);
  store.setState({ agentName: "orchestrator", sessionRole: "main", goalId: goal.id });
  await expect(enforceGoalBudgetBeforeModelCall({
    store,
    projectContext,
    modelOptions: { maxOutputTokens: 50 },
  })).rejects.toThrow("Goal paused: budget warning approval is pending");
  const pending = await waitForPendingApproval(hitl, goal.id, BUDGET_APPROVAL_POINT);
  const serialized = JSON.stringify(pending);
  expect(pending.displayPayload.redacted).toBe(true);
  expect(serialized).not.toContain("sk-test-secret");
  const response = await coordinator.respond(pending.hitlId, { type: "approval_decision", decision: "approved", comment: "Budget approved" });
  expect(response.scheduled).toBe(true);
  await waitForGoal(goal.id, (state) => state.resumeCheckpoint === undefined);

  const paused = await manager.read(goal.id);
  expect(paused.status).toBe("paused");
  expect(paused.tokenBudget).toMatchObject({ status: "paused", totalTokens: 890, warningThresholdTokens: 900 });
  expect(await readArtifact("budget.md", goal.id)).toContain("Event | warning_pending");
  const approved = await manager.updateTokenBudget(goal.id, {
    ...paused.tokenBudget!,
    status: "ok",
    warningApprovalPoint: BUDGET_APPROVAL_POINT,
    warningApprovalThresholdTokens: paused.tokenBudget?.warningThresholdTokens,
    warningApprovedAt: new Date().toISOString(),
    warningApprovedTotalTokens: paused.tokenBudget?.totalTokens,
  });
  expect(approved.status).toBe("paused");
  expect(approved.tokenBudget).toMatchObject({
    warningApprovalPoint: BUDGET_APPROVAL_POINT,
    warningApprovedTotalTokens: 890,
  });
  return manager.transitionStatus(goal.id, "running");
}

async function advancePlanToBuildWithApproval(runner: GoalRunner, coordinator: ResumeCoordinator, hitl: HitlService, goalId: string): Promise<GoalState> {
  const paused = await runner.advancePhase(goalId, "build");
  expect(paused).toMatchObject({ status: "paused", phase: "plan" });
  await approvePending(coordinator, hitl, goalId, "after_plan", "Plan approved");
  return waitForGoal(goalId, (goal) => goal.status === "running" && goal.phase === "build");
}

function reviewerStore(sessionId: string, goalId: string): ReturnType<typeof createSessionStore> {
  const store = createSessionStore(sessionId, workspaceRoot);
  store.setState({ agentName: "reviewer", sessionRole: "review", goalId });
  return store;
}

async function readArtifact(name: GoalArtifactName, goalId: string): Promise<string> {
  const content = await artifacts.readArtifact(goalId, name);
  expect(content).not.toBeNull();
  return content ?? "";
}

async function expectArtifacts(goalId: string, names: GoalArtifactName[]): Promise<void> {
  const actual = (await artifacts.listArtifacts(goalId)).map((artifact) => artifact.name).sort();
  expect(actual).toEqual([...names].sort());
  expect(canonicalArtifacts).toEqual(["plan.md", "build.md", "review.md", "spec-compliance.md", "approvals.md", "budget.md", "retry-log.md", "final-report.md"]);
}

async function expectPlanLocked(goal: GoalState): Promise<void> {
  try {
    await artifacts.writeArtifact(goal, "plan.md", "# Mutated plan", { agentName: "plan" });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("GoalArtifactPlanLockedError");
    return;
  }
  throw new Error("Expected plan.md to be locked after plan phase");
}

async function expectNoRawPrivateMarker(goalId: string): Promise<void> {
  const persisted = await readGoalStateFile(goalId);
  expect(JSON.stringify(persisted)).not.toContain(RAW_PRIVATE_MARKER);
  for (const artifact of await artifacts.listArtifacts(goalId)) {
    const content = await readArtifact(artifact.name, goalId);
    expect(content).not.toContain(RAW_PRIVATE_MARKER);
  }
}

async function writeEvidenceFile(name: string, lines: string[]): Promise<void> {
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  await Bun.write(join(EVIDENCE_ROOT, name), `${lines.join("\n")}\n`);
}

describe("Goal integration happy path", () => {
  test("runs goal_manage create → lock → start → advance_phase → goal_evidence check_done → finalize_review", async () => {
    mockGenerateText
      .mockImplementationOnce(async () => ({ text: "plan: approved plan", toolCalls: [] }))
      .mockImplementationOnce(async () => ({ text: "build: wrote artifact.txt", toolCalls: [] }))
      .mockImplementationOnce(async () => ({ text: "review: goal_evidence action check_done should pass", toolCalls: [] }));

    const sessionStore = createSessionStore("main-session-1", workspaceRoot);
    sessionStore.setState({ agentName: "orchestrator", sessionRole: "main" });

    const draft = await executeGoalManage(sessionStore, {
      action: "create",
      title: "Ship mocked Goal happy path",
      author: "architect",
      doneConditions: [artifactExistsCondition, artifactMentionsPlanCondition],
      retryPolicy: { maxRetries: 1, backoffMs: 0, escalateOnFailure: true },
      approvalPoints: [],
    });
    appendGoalStateChange(sessionStore, draft);

    const locked = await executeGoalManage(sessionStore, { action: "lock", goalId: draft.id });
    appendGoalStateChange(sessionStore, locked);

    const running = await executeGoalManage(sessionStore, { action: "start", goalId: locked.id });
    appendGoalStateChange(sessionStore, running);
    expect(running).toMatchObject({ status: "running", phase: "plan", mainSessionId: "main-session-1" });

    const plan = await runLlmText({ model: dummyModel, prompt: `Plan goal ${running.id}` });
    expect(plan.text).toContain("approved plan");

    const build = await executeGoalManage(sessionStore, { action: "advance_phase", goalId: running.id, nextPhase: "build" });
    appendGoalStateChange(sessionStore, build);
    expect(build.phase).toBe("build");

    const buildOutput = await runLlmText({ model: dummyModel, prompt: `Build goal ${build.id}` });
    expect(buildOutput.text).toContain("artifact.txt");
    await Bun.write(join(workspaceRoot, "artifact.txt"), `${plan.text}\n${buildOutput.text}\napproved plan evidence\n`);

    const reviewPhase = await executeGoalManage(sessionStore, { action: "advance_phase", goalId: build.id, nextPhase: "review" });
    appendGoalStateChange(sessionStore, reviewPhase);
    expect(reviewPhase.phase).toBe("review");
    sessionStore.setState({ agentName: "reviewer", sessionRole: "review", goalId: reviewPhase.id });

    const reviewOutput = await runLlmText({ model: dummyModel, prompt: `Review goal ${reviewPhase.id}` });
    expect(reviewOutput.text).toContain("goal_evidence");

    const fileExistsResult = await executeGoalEvidence(sessionStore, reviewPhase.id, artifactExistsCondition.id);
    const grepResult = await executeGoalEvidence(sessionStore, reviewPhase.id, artifactMentionsPlanCondition.id);
    sessionStore.getState().append({ type: "goal.done_check", goalId: reviewPhase.id, results: [fileExistsResult, grepResult] });

    expect(fileExistsResult).toMatchObject({ conditionId: artifactExistsCondition.id, passed: true });
    expect(fileExistsResult.evidence).toContain("exists=true");
    expect(grepResult).toMatchObject({ conditionId: artifactMentionsPlanCondition.id, passed: true });
    expect(grepResult.evidence).toContain("matches");

    const verifying = await manager.read(reviewPhase.id);
    appendGoalStateChange(sessionStore, verifying);
    expect(verifying.status).toBe("verifying");

    const completed = await executeGoalManage(sessionStore, {
      action: "finalize_review",
      goalId: reviewPhase.id,
      outcome: "DONE",
      summary: "Reviewer verified the mocked happy path Done Conditions.",
    });
    appendGoalStateChange(sessionStore, completed);
    expect(completed.status).toBe("completed");

    const completedFile = await readGoalStateFile(reviewPhase.id);
    expect(completedFile.status).toBe("completed");
    expect(completedFile.reviewReport).toMatchObject({ outcome: "DONE", summary: "Reviewer verified the mocked happy path Done Conditions." });
    for (const condition of completedFile.doneConditions.filter((candidate) => candidate.required !== false)) {
      const result = completedFile.doneResults[condition.id];
      expect(result?.passed).toBe(true);
      expect(result?.evidence.length).toBeGreaterThan(0);
    }

    expect(mockGenerateText).toHaveBeenCalledTimes(3);
    expect(generateTextPrompts()).toEqual([
      `Plan goal ${running.id}`,
      `Build goal ${build.id}`,
      `Review goal ${reviewPhase.id}`,
    ]);
    expect(stateChangeStatuses(sessionStore.getState())).toEqual([
      "draft",
      "locked",
      "running",
      "running",
      "running",
      "verifying",
      "completed",
    ]);
    expect(stateChangePhaseSequence(sessionStore.getState())).toEqual([
      "draft:plan",
      "locked:plan",
      "running:plan",
      "running:build",
      "running:review",
      "verifying:review",
      "completed:review",
    ]);
    expect(sessionStore.getState().events.some((event) => event.kind === "goal.done_check")).toBe(true);
  });

  test("Task 18 DONE daily-use flow locks plan, approves after plan, records spec evidence, and completes without raw model output", async () => {
    mockGenerateText
      .mockImplementationOnce(async () => ({ text: `plan raw ${RAW_PRIVATE_MARKER}`, toolCalls: [] }))
      .mockImplementationOnce(async () => ({ text: `build raw ${RAW_PRIVATE_MARKER}`, toolCalls: [] }))
      .mockImplementationOnce(async () => ({ text: `review raw ${RAW_PRIVATE_MARKER}`, toolCalls: [] }));
    const { runner, hitl, coordinator } = await createHitlRunner({ sessionIds: ["daily-main-session"] });
    const sessionStore = createSessionStore("daily-main-session", workspaceRoot);
    await Bun.write(join(workspaceRoot, "SPEC.md"), task18Spec("satisfied"));

    const draft = await manager.create(
      "project-a",
      "goal_test_done",
      "architect",
      [specComplianceCondition],
      { maxRetries: 1, backoffMs: 0, escalateOnFailure: true },
      ["after_plan", "before_complete"],
    );
    appendGoalStateChange(sessionStore, draft);
    const locked = await manager.lock(draft.id, "architect");
    appendGoalStateChange(sessionStore, locked);
    const running = await runner.start(locked.id);
    appendGoalStateChange(sessionStore, running);

    const planOutput = await runLlmText({ model: dummyModel, prompt: `Plan Task 18 goal ${running.id}` });
    expect(planOutput.text).toContain(RAW_PRIVATE_MARKER);
    await artifacts.writeArtifact(running, "plan.md", "# Plan\n\nStructured Task 18 plan artifact, no raw model output.", { agentName: "plan" });

    const build = await advancePlanToBuildWithApproval(runner, coordinator, hitl, running.id);
    appendGoalStateChange(sessionStore, build);
    expect(build.phase).toBe("build");
    await expectPlanLocked(build);

    const budgeted = await manager.updateTokenBudget(build.id, tokenBudget(890));
    expect(budgeted.tokenBudget).toMatchObject({ status: "ok", totalTokens: 890, maxTokens: 1000 });
    await requestBudgetApprovalThroughHook(coordinator, hitl, budgeted);

    const buildOutput = await runLlmText({ model: dummyModel, prompt: `Build Task 18 goal ${build.id}` });
    expect(buildOutput.text).toContain(RAW_PRIVATE_MARKER);
    const reviewPhase = await runner.advancePhase(build.id, "review");
    appendGoalStateChange(sessionStore, reviewPhase);
    expect(reviewPhase.phase).toBe("review");

    const reviewOutput = await runLlmText({ model: dummyModel, prompt: `Review Task 18 goal ${reviewPhase.id}` });
    expect(reviewOutput.text).toContain(RAW_PRIVATE_MARKER);

    const wrongStore = createSessionStore("wrong-session", workspaceRoot);
    wrongStore.setState({ agentName: "orchestrator", sessionRole: "main", goalId: reviewPhase.id });
    const denied = await executeGoalEvidenceRaw(wrongStore, reviewPhase.id, specComplianceCondition.id);
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("GOAL_REVIEWER_REQUIRED");

    const reviewStore = reviewerStore("daily-review-session", reviewPhase.id);
    const specResult = await executeGoalEvidence(reviewStore, reviewPhase.id, specComplianceCondition.id);
    reviewStore.getState().append({ type: "goal.done_check", goalId: reviewPhase.id, results: [specResult] });
    expect(specResult).toMatchObject({ conditionId: specComplianceCondition.id, passed: true });
    expect(specResult.specCompliance?.criteria.map((criterion) => criterion.criterionId)).toEqual(["AC-001", "AC-002"]);
    expect(specResult.specCompliance?.criteria.every((criterion) => criterion.compliant)).toBe(true);

    const pausedForCompletion = await runner.finalizeReviewerReview(reviewPhase.id, "DONE", { summary: "Reviewer verified Task 18 DONE criteria." });
    expect(pausedForCompletion).toMatchObject({ status: "paused", phase: "review" });
    const beforeCompletePending = await waitForPendingApproval(hitl, reviewPhase.id, "before_complete");
    const completionResponse = await coordinator.respond(beforeCompletePending.hitlId, { type: "approval_decision", decision: "approved", comment: "Completion approved" });
    expect(completionResponse.scheduled).toBe(true);
    const completed = await waitForGoal(reviewPhase.id, (goal) => goal.status === "completed");
    appendGoalStateChange(sessionStore, completed);

    expect(completed.status).toBe("completed");
    expect(completed.reviewReport).toMatchObject({ outcome: "DONE", summary: "Reviewer verified Task 18 DONE criteria." });
    expect(completed.repairContext).toBeUndefined();
    expect((await readGoalStateFile(reviewPhase.id)).status).toBe("completed");
    await expectArtifacts(reviewPhase.id, ["plan.md", "build.md", "review.md", "spec-compliance.md", "approvals.md", "budget.md", "final-report.md"]);
    expect(await readArtifact("review.md", reviewPhase.id)).toContain("DONE");
    expect(await readArtifact("spec-compliance.md", reviewPhase.id)).toContain("AC-002");
    expect(await readArtifact("approvals.md", reviewPhase.id)).toContain("after_plan | approved | approved | Plan approved");
    expect(await readArtifact("final-report.md", reviewPhase.id)).toContain("Final status | completed");
    expect(await readArtifact("final-report.md", reviewPhase.id)).toContain("Total token count | 890");
    expect(await readArtifact("final-report.md", reviewPhase.id)).toContain(`Budget warning approval point | ${BUDGET_APPROVAL_POINT}`);
    await expectNoRawPrivateMarker(reviewPhase.id);

    expect(mockGenerateText).toHaveBeenCalledTimes(3);
    expect(generateTextPrompts()).toEqual([
      `Plan Task 18 goal ${running.id}`,
      `Build Task 18 goal ${build.id}`,
      `Review Task 18 goal ${reviewPhase.id}`,
    ]);
    await writeEvidenceFile("task-18-full-done.txt", [
      "Task 18 DONE path evidence",
      `goalId=${reviewPhase.id}`,
      `status=${completed.status}`,
      `reviewOutcome=${completed.reviewReport?.outcome}`,
      `artifacts=${(await artifacts.listArtifacts(reviewPhase.id)).map((artifact) => artifact.name).join(",")}`,
      `budgetApproval=${BUDGET_APPROVAL_POINT}`,
      "criteria=AC-001:satisfied,AC-002:satisfied",
      "rawPrivateMarkerPersisted=false",
    ]);
  });

  test("Task 18 NOT_DONE repair flow schedules retry, exposes structured context, then completes DONE on attempt 2", async () => {
    let nowMs = Date.parse("2026-07-03T12:00:00.000Z");
    const delayCalls: number[] = [];
    const { runner, hitl, coordinator } = await createHitlRunner({
      sessionIds: ["retry-main-session-1", "retry-main-session-2"],
      now: () => new Date(nowMs),
      retryDelay: mock(async (ms: number, abort: AbortSignal) => {
        delayCalls.push(ms);
        expect(abort.aborted).toBe(false);
        nowMs += ms;
      }),
    });
    await Bun.write(join(workspaceRoot, "SPEC.md"), task18Spec("failed"));

    const goal = await manager.create(
      "project-a",
      "goal_test_done retry repair",
      "architect",
      [specComplianceCondition],
      { maxRetries: 2, backoffMs: 5_000, escalateOnFailure: true },
      ["after_plan"],
    );
    const locked = await manager.lock(goal.id, "architect");
    const attempt1 = await runner.start(locked.id);
    await artifacts.writeArtifact(attempt1, "plan.md", "# Plan\n\nAttempt 1 plan artifact.", { agentName: "plan" });
    const attempt1Build = await advancePlanToBuildWithApproval(runner, coordinator, hitl, attempt1.id);
    const budgetedAttempt1 = await manager.updateTokenBudget(attempt1Build.id, tokenBudget(890));
    await requestBudgetApprovalThroughHook(coordinator, hitl, budgetedAttempt1);
    const attempt1Review = await runner.advancePhase(attempt1Build.id, "review");
    const attempt1Store = reviewerStore("retry-review-session-1", attempt1Review.id);
    const failedSpec = await executeGoalEvidence(attempt1Store, attempt1Review.id, specComplianceCondition.id);
    expect(failedSpec.passed).toBe(false);
    expect(failedSpec.specCompliance?.criteria.find((criterion) => criterion.criterionId === "AC-002")).toMatchObject({
      compliant: false,
      status: "failed",
    });

    const retry = await runner.finalizeReviewerReview(attempt1Review.id, "NOT_DONE", { summary: "AC-002 needs repair before completion." });

    expect(delayCalls).toEqual([5_000]);
    expect(retry).toMatchObject({ status: "running", phase: "plan", retryCount: 1, mainSessionId: "retry-main-session-2" });
    expect(retry.repairContext?.issues).toEqual([
      expect.objectContaining({
        conditionId: "AC-002",
        evidenceSummary: expect.stringContaining("Goal detail retry tab coverage missing"),
        repairGuidance: expect.stringContaining("Repair AC-002"),
        repairTarget: expect.stringContaining("apps/web/src/routes/goal-detail.test.tsx"),
        failingCommands: ["bun test apps/web/src/routes/goal-detail.test.tsx apps/web/src/routes/dashboard.test.tsx"],
      }),
    ]);
    expect(retry.retryState?.lastAttempt).toMatchObject({ attempt: 1, status: "running", startedAt: "2026-07-03T12:00:05.000Z" });
    const retryLogAfterNotDone = await readArtifact("retry-log.md", retry.id);
    expect(retryLogAfterNotDone).toContain("| 1 | scheduled | Reviewer NOT_DONE: required Done Conditions need repair (AC-002). | none | 2026-07-03T12:00:05.000Z | not exhausted |");
    expect(retryLogAfterNotDone).toContain("| 1 | running | Reviewer NOT_DONE: required Done Conditions need repair (AC-002). | retry-main-session-2 | not scheduled | not exhausted |");
    expect(await readArtifact("review.md", retry.id)).toContain("NOT_DONE");

    await Bun.write(join(workspaceRoot, "SPEC.md"), task18Spec("satisfied"));
    const attempt2Build = await advancePlanToBuildWithApproval(runner, coordinator, hitl, retry.id);
    const attempt2Review = await runner.advancePhase(attempt2Build.id, "review");
    const attempt2Store = reviewerStore("retry-review-session-2", attempt2Review.id);
    const repairedSpec = await executeGoalEvidence(attempt2Store, attempt2Review.id, specComplianceCondition.id);
    expect(repairedSpec.passed).toBe(true);
    const completed = await runner.finalizeReviewerReview(attempt2Review.id, "DONE", { summary: "Retry repaired AC-002 and all criteria are satisfied." });

    expect(completed.status).toBe("completed");
    expect(completed.retryCount).toBe(1);
    expect(completed.reviewReport).toMatchObject({ outcome: "DONE" });
    expect(completed.repairContext).toBeUndefined();
    expect(completed.doneResults[specComplianceCondition.id]?.specCompliance?.criteria.map((criterion) => `${criterion.criterionId}:${criterion.status}`)).toEqual([
      "AC-001:satisfied",
      "AC-002:satisfied",
    ]);
    expect(await readArtifact("review.md", completed.id)).toContain("DONE");
    expect(await readArtifact("final-report.md", completed.id)).toContain("Retry count | 1");
    expect(await readArtifact("final-report.md", completed.id)).toContain("Review outcome | DONE");
    await expectArtifacts(completed.id, ["plan.md", "build.md", "review.md", "spec-compliance.md", "approvals.md", "budget.md", "retry-log.md", "final-report.md"]);
    await expectNoRawPrivateMarker(completed.id);

    await writeEvidenceFile("task-18-not-done-retry.txt", [
      "Task 18 NOT_DONE retry evidence",
      `goalId=${completed.id}`,
      "attempt1=NOT_DONE AC-002 failed",
      `retryCount=${completed.retryCount}`,
      `retryDelayCalls=${delayCalls.join(",")}`,
      "retryLog=scheduled,running",
      "attempt2=DONE AC-001:satisfied AC-002:satisfied",
      `finalStatus=${completed.status}`,
      "rawPrivateMarkerPersisted=false",
    ]);
  });
});
