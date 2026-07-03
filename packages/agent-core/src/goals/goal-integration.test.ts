import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  TOOL_GOAL_CHECK_DONE,
  type DoneCondition,
  type DoneResult,
  type GoalState,
  type GoalStatus,
} from "@archcode/protocol";

import type { HitlResponse } from "../hitl/types";
import { setLlmAdapterForTest } from "../llm";
import { runLlmText } from "../llm/run-text";
import type { LlmTextInput } from "../llm/types";
import { SkillService } from "../skills";
import { createSessionStore, storeManager } from "../store/store";
import type { SessionStoreState } from "../store/types";
import { createRegistry } from "../tools/registry";
import { createTestProjectContext } from "../tools/test-project-context";
import { createToolExecutionContext } from "../tools/types";
import { createGoalCheckDoneTool } from "../tools/builtins/goal-tools";
import { GoalArtifactManager } from "./artifacts";
import { GoalRunner } from "./runner";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-integration");
const dummyModel = {} as LlmTextInput["model"];
const testSkillService = new SkillService({ builtinSkills: {} });

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

const mockGenerateText = mock(async (input: Record<string, unknown>) => {
  void input;
  return { text: "ok", toolCalls: [] };
});

let workspaceRoot = "";
let manager: GoalStateManager;

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
});

afterAll(async () => {
  setLlmAdapterForTest(undefined);
  storeManager.clearAll();
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function approvedResponse(): HitlResponse {
  return { hitlId: crypto.randomUUID(), kind: "approval", status: "resolved", response: { decision: "approved" } };
}

function createRunner(sessionIds: string[] = ["main-session-1"]): GoalRunner {
  const remainingSessionIds = [...sessionIds];
  return new GoalRunner({
    goalStateManager: manager,
    goalArtifacts: new GoalArtifactManager(workspaceRoot),
    workspaceRoot,
    hitlService: {
      request: mock(async () => approvedResponse()),
      listPending: mock(() => []),
    },
    createSession: mock(async () => remainingSessionIds.shift() ?? `session-${crypto.randomUUID()}`),
    isSessionActive: mock(async () => false),
  });
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

function goalStateFilePath(goalId: string): string {
  return join(workspaceRoot, ".archcode", "goals", goalId, "goal.json");
}

async function readGoalStateFile(goalId: string): Promise<GoalState> {
  return JSON.parse(await Bun.file(goalStateFilePath(goalId)).text()) as GoalState;
}

async function executeGoalCheckDone(
  store: ReturnType<typeof createSessionStore>,
  goalId: string,
  conditionId: string,
): Promise<DoneResult> {
  const registry = createRegistry([createGoalCheckDoneTool()]);
  const ctx = createToolExecutionContext({
    store,
    storeManager,
    toolName: TOOL_GOAL_CHECK_DONE,
    toolCallId: `${TOOL_GOAL_CHECK_DONE}-${conditionId}`,
    input: { goalId, conditionId },
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set([TOOL_GOAL_CHECK_DONE]),
    agentName: store.getState().agentName,
    agentSkills: [],
    skillService: testSkillService,
    projectContext: createTestProjectContext(workspaceRoot),
  });

  const result = await registry.execute(
    { toolName: TOOL_GOAL_CHECK_DONE, toolCallId: `${TOOL_GOAL_CHECK_DONE}-${conditionId}`, input: { goalId, conditionId } },
    ctx,
  );
  expect(result.isError).toBe(false);
  return JSON.parse(result.output) as DoneResult;
}

function generateTextPrompts(): string[] {
  return (mockGenerateText.mock.calls as unknown as Array<[Record<string, unknown>]>).map((call) => String(call[0].prompt));
}

describe("Goal integration happy path", () => {
  test("runs create → lock → run → plan → approval → build → review → goal_check_done → complete", async () => {
    mockGenerateText
      .mockImplementationOnce(async () => ({ text: "plan: approved plan", toolCalls: [] }))
      .mockImplementationOnce(async () => ({ text: "build: wrote artifact.txt", toolCalls: [] }))
      .mockImplementationOnce(async () => ({ text: "review: goal_check_done should pass", toolCalls: [] }));

    const sessionStore = createSessionStore("main-session-1");
    const runner = createRunner(["main-session-1"]);

    const draft = await manager.create(
      "project-a",
      "Ship mocked Goal happy path",
      "architect",
      [artifactExistsCondition, artifactMentionsPlanCondition],
      { maxRetries: 1, backoffMs: 0, escalateOnFailure: true },
      ["after_plan", "before_complete"],
    );
    appendGoalStateChange(sessionStore, draft);

    const locked = await manager.lock(draft.id, "architect");
    appendGoalStateChange(sessionStore, locked);

    const running = await runner.start(locked.id);
    appendGoalStateChange(sessionStore, running);
    expect(running).toMatchObject({ status: "running", phase: "plan", mainSessionId: "main-session-1" });

    const plan = await runLlmText({ model: dummyModel, prompt: `Plan goal ${running.id}` });
    expect(plan.text).toContain("approved plan");

    const build = await runner.advancePhase(running.id, "build");
    appendGoalStateChange(sessionStore, build);
    expect(build.phase).toBe("build");

    const buildOutput = await runLlmText({ model: dummyModel, prompt: `Build goal ${build.id}` });
    expect(buildOutput.text).toContain("artifact.txt");
    await Bun.write(join(workspaceRoot, "artifact.txt"), `${plan.text}\n${buildOutput.text}\napproved plan evidence\n`);

    const reviewPhase = await runner.advancePhase(build.id, "review");
    appendGoalStateChange(sessionStore, reviewPhase);
    expect(reviewPhase.phase).toBe("review");
    sessionStore.setState({ agentName: "reviewer", sessionRole: "review", goalId: reviewPhase.id });

    const reviewOutput = await runLlmText({ model: dummyModel, prompt: `Review goal ${reviewPhase.id}` });
    expect(reviewOutput.text).toContain("goal_check_done");

    const fileExistsResult = await executeGoalCheckDone(sessionStore, reviewPhase.id, artifactExistsCondition.id);
    const grepResult = await executeGoalCheckDone(sessionStore, reviewPhase.id, artifactMentionsPlanCondition.id);
    sessionStore.getState().append({ type: "goal.done_check", goalId: reviewPhase.id, results: [fileExistsResult, grepResult] });

    expect(fileExistsResult).toMatchObject({ conditionId: artifactExistsCondition.id, passed: true });
    expect(fileExistsResult.evidence).toContain("exists=true");
    expect(grepResult).toMatchObject({ conditionId: artifactMentionsPlanCondition.id, passed: true });
    expect(grepResult.evidence).toContain("matches");

    const verifying = await manager.read(reviewPhase.id);
    appendGoalStateChange(sessionStore, verifying);
    expect(verifying.status).toBe("verifying");

    const reviewed = await runner.review(reviewPhase.id);
    appendGoalStateChange(sessionStore, reviewed);
    expect(reviewed.status).toBe("reviewed");

    const reviewedFile = await readGoalStateFile(reviewPhase.id);
    expect(reviewedFile.status).toBe("reviewed");
    for (const condition of reviewedFile.doneConditions.filter((candidate) => candidate.required !== false)) {
      const result = reviewedFile.doneResults[condition.id];
      expect(result?.passed).toBe(true);
      expect(result?.evidence.length).toBeGreaterThan(0);
    }

    const completed = await runner.complete(reviewPhase.id);
    appendGoalStateChange(sessionStore, completed);
    expect(completed.status).toBe("completed");
    expect((await readGoalStateFile(reviewPhase.id)).status).toBe("completed");

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
      "reviewed",
      "completed",
    ]);
    expect(stateChangePhaseSequence(sessionStore.getState())).toEqual([
      "draft:plan",
      "locked:plan",
      "running:plan",
      "running:build",
      "running:review",
      "verifying:review",
      "reviewed:review",
      "completed:review",
    ]);
    expect(sessionStore.getState().events.some((event) => event.kind === "goal.done_check")).toBe(true);
  });
});
