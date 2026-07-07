import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";

import { TOOL_GOAL_EVIDENCE, TOOL_GOAL_MANAGE, type DoneCondition, type DoneResult, type GoalState, type HitlRecord } from "@archcode/protocol";
import { GoalArtifactManager } from "../../goals/artifacts";
import { GoalMemoryManager } from "../../goals/goal-memory";
import { GoalRunner } from "../../goals/runner";
import { GoalStateManager } from "../../goals/state";
import { HitlService, type CreateHitlRecordInput } from "../../hitl/service";
import { LoopStateManager } from "../../loops/state";
import { MemoryFileManager } from "../../memory/file-manager";
import type { ProjectContext } from "../../projects/types";
import { ProjectApprovalManager } from "../permission/project-approvals";
import { inferToolErrorKindFromResult } from "../errors";
import { createToolErrorResult } from "../errors";
import { createMockStore } from "../../store/test-helpers";
import { storeManager } from "../../store/store";
import { SkillService } from "../../skills";
import { silentLogger } from "../../logger";
import { createToolExecutionContext, type ToolExecutionContext, type ToolExecutionResult } from "../types";
import type { SessionStoreState } from "../../store/types";
import { GoalEvidenceInputSchema, goalEvidenceTool, GoalManageInputSchema, goalManageTool } from "./goal-tools";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-tools");
const testSkillService = new SkillService({ builtinSkills: {} });
const GOAL_TOOL_NAMES = [TOOL_GOAL_MANAGE, TOOL_GOAL_EVIDENCE];

const DONE_CONDITION: DoneCondition = {
  id: "artifact-exists",
  kind: "file_exists",
  params: { path: "artifact.txt" },
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function mainStore(overrides: Partial<SessionStoreState> = {}): StoreApi<SessionStoreState> {
  return createMockStore({
    sessionId: "goal-session",
    agentName: "orchestrator",
    sessionRole: "main",
    ...overrides,
  });
}

function reviewStore(goalId: string, overrides: Partial<SessionStoreState> = {}): StoreApi<SessionStoreState> {
  return createMockStore({
    sessionId: "review-session",
    agentName: "reviewer",
    sessionRole: "review",
    goalId,
    ...overrides,
  });
}

function makeCtx(
  toolName: string,
  input: unknown,
  store: StoreApi<SessionStoreState> = mainStore(),
  projectContext: ProjectContext = createTestProjectContext(),
): ToolExecutionContext {
  return createToolExecutionContext({
    store,
    storeManager,
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(GOAL_TOOL_NAMES),
    agentName: store.getState().agentName,
    agentSkills: [],
    skillService: testSkillService,
    projectContext,
  });
}

class CapturingHitlService extends HitlService {
  override async create(input: CreateHitlRecordInput): Promise<HitlRecord> {
    const now = input.createdAt ?? new Date().toISOString();
    return {
      hitlId: "captured-hitl",
      owner: input.owner,
      blockingKey: input.blockingKey,
      source: input.source,
      status: "pending",
      displayPayload: input.displayPayload,
      createdAt: now,
      updatedAt: now,
    };
  }
}

function createTestProjectContext(options: { approvalDecision?: "approved" | "denied" } = {}): ProjectContext {
  return {
    project: {
      slug: "test-project",
      name: "Test Project",
      workspaceRoot: TMP_DIR,
      addedAt: new Date().toISOString(),
    },
    goalState: new GoalStateManager(TMP_DIR),
    goalArtifacts: new GoalArtifactManager(TMP_DIR),
    goalMemory: new GoalMemoryManager(TMP_DIR),
    loopState: new LoopStateManager(TMP_DIR),
    hitl: options.approvalDecision === undefined ? new HitlService() : new CapturingHitlService(),
    memory: new MemoryFileManager({
      project: join(TMP_DIR, ".archcode", "memory"),
      user: join(TMP_DIR, ".archcode", "user-memory"),
    }),
    approvals: new ProjectApprovalManager(silentLogger),
  };
}

async function execute(
  input: unknown,
  store?: StoreApi<SessionStoreState>,
  projectContext?: ProjectContext,
): Promise<ToolExecutionResult> {
  const parsed = goalManageTool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return createToolErrorResult({
      kind: "schema",
      zodError: parsed.error,
      expectedInput: `Tool "${TOOL_GOAL_MANAGE}" input must match its registered Zod schema.`,
    });
  }

  const ctx = makeCtx(TOOL_GOAL_MANAGE, parsed.data, store, projectContext);
  const output = await goalManageTool.execute(parsed.data, ctx);
  return typeof output === "string" ? { output, isError: false } : output;
}

async function executeEvidence(
  input: unknown,
  store?: StoreApi<SessionStoreState>,
  projectContext?: ProjectContext,
): Promise<ToolExecutionResult> {
  const parsed = goalEvidenceTool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return createToolErrorResult({
      kind: "schema",
      zodError: parsed.error,
      expectedInput: `Tool "${TOOL_GOAL_EVIDENCE}" input must match its registered Zod schema.`,
    });
  }

  const ctx = makeCtx(TOOL_GOAL_EVIDENCE, parsed.data, store, projectContext);
  const output = await goalEvidenceTool.execute(parsed.data, ctx);
  return typeof output === "string" ? { output, isError: false } : output;
}

function validCreateInput(overrides: Record<string, unknown> = {}) {
  return {
    action: "create",
    title: "Ship goal tools",
    doneConditions: [DONE_CONDITION],
    retryPolicy: { maxRetries: 3, backoffMs: 0, escalateOnFailure: true },
    approvalPoints: [] as string[],
    author: "orchestrator",
    ...overrides,
  };
}

async function createDraftGoal(): Promise<GoalState> {
  await writeFile(join(TMP_DIR, "artifact.txt"), "done\n");
  const result = await execute(validCreateInput());
  expect(result.isError).toBe(false);
  return JSON.parse(result.output) as GoalState;
}

async function createLockedGoal(store = mainStore({ sessionId: "locker-session" })): Promise<GoalState> {
  const draft = await createDraftGoal();
  const locked = await execute({ action: "lock", goalId: draft.id }, store);
  expect(locked.isError).toBe(false);
  return JSON.parse(locked.output) as GoalState;
}

async function createRunningReviewGoal(): Promise<GoalState> {
  const store = mainStore({ sessionId: "main-session" });
  const locked = await createLockedGoal(store);
  const started = await execute({ action: "start", goalId: locked.id }, store);
  expect(started.isError).toBe(false);
  const build = await execute({ action: "advance_phase", goalId: locked.id, nextPhase: "build" }, store);
  expect(build.isError).toBe(false);
  const review = await execute({ action: "advance_phase", goalId: locked.id, nextPhase: "review" }, store);
  expect(review.isError).toBe(false);
  return JSON.parse(review.output) as GoalState;
}

async function createRunningReviewGoalForReviewer(reviewerAgent: string): Promise<GoalState> {
  const store = mainStore({ sessionId: "main-session" });
  const draft = await createDraftGoal();
  await new GoalStateManager(TMP_DIR).patch(draft.id, { reviewerAgent });
  const locked = await execute({ action: "lock", goalId: draft.id }, store);
  expect(locked.isError).toBe(false);
  const started = await execute({ action: "start", goalId: draft.id }, store);
  expect(started.isError).toBe(false);
  const build = await execute({ action: "advance_phase", goalId: draft.id, nextPhase: "build" }, store);
  expect(build.isError).toBe(false);
  const review = await execute({ action: "advance_phase", goalId: draft.id, nextPhase: "review" }, store);
  expect(review.isError).toBe(false);
  return JSON.parse(review.output) as GoalState;
}

async function recordPassingEvidence(goalId: string): Promise<GoalState> {
  const manager = new GoalStateManager(TMP_DIR);
  const runner = new GoalRunner({
    goalStateManager: manager,
    goalArtifacts: new GoalArtifactManager(TMP_DIR),
    hitlService: {
      create: async (input) => ({
        hitlId: crypto.randomUUID(),
        owner: input.owner,
        blockingKey: input.blockingKey,
        source: input.source,
        status: "pending",
        displayPayload: input.displayPayload,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      list: async () => [],
    },
    workspaceRoot: TMP_DIR,
    createSession: async () => "main-session",
  });
  return runner.recordAuthorizedReviewerDoneResult(goalId, DONE_CONDITION.id, {
    conditionId: DONE_CONDITION.id,
    passed: true,
    evidence: "artifact.txt exists",
    checkedAt: new Date().toISOString(),
  }, {
    agentName: "reviewer",
    sessionRole: "review",
    sessionGoalId: goalId,
  });
}

async function expectManageDeniedWithoutStatusMutation(
  input: Record<string, unknown>,
  store: StoreApi<SessionStoreState>,
  expectedCode: string,
) {
  const manager = new GoalStateManager(TMP_DIR);
  const before = typeof input.goalId === "string" ? await manager.read(input.goalId) : undefined;

  const result = await execute(input, store);

  expect(result.isError).toBe(true);
  expect(result.output).toContain(expectedCode);
  if (before) {
    expect(await manager.read(before.id)).toMatchObject({ status: before.status, phase: before.phase });
  }
  return result;
}

async function expectEvidenceDeniedWithoutStatusMutation(
  input: Record<string, unknown>,
  store: StoreApi<SessionStoreState>,
  expectedCode: string,
) {
  const manager = new GoalStateManager(TMP_DIR);
  const before = typeof input.goalId === "string" ? await manager.read(input.goalId) : undefined;

  const result = await executeEvidence(input, store);

  expect(result.isError).toBe(true);
  expect(result.output).toContain(expectedCode);
  if (before) {
    expect(await manager.read(before.id)).toMatchObject({ status: before.status, phase: before.phase });
  }
  return result;
}

describe("goal_manage builtin tool", () => {
  it("exports only the new lifecycle descriptor from the goal-tools barrel", () => {
    expect(goalManageTool.name).toBe(TOOL_GOAL_MANAGE);
  });

  it("create creates a draft goal through GoalRunner.createDraft", async () => {
    const result = await execute(validCreateInput({ approvalPoints: ["after_plan"] }));

    expect(result.isError).toBe(false);
    const goal = JSON.parse(result.output) as GoalState;
    expect(goal).toMatchObject({
      projectId: "test-project",
      title: "Ship goal tools",
      status: "draft",
      phase: "plan",
      author: "orchestrator",
      retryCount: 0,
      retryPolicy: { maxRetries: 3, backoffMs: 0, escalateOnFailure: true },
      approvalPoints: ["after_plan"],
    });
    expect(goal.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(goal.doneConditions).toHaveLength(1);

    const persisted = await new GoalStateManager(TMP_DIR).read(goal.id);
    expect(persisted.status).toBe("draft");
  });

  it("lock locks a draft goal through GoalRunner.lockDraft and records the main session id", async () => {
    const draft = await createDraftGoal();
    const store = mainStore({ sessionId: "session-locker" });

    const result = await execute({ action: "lock", goalId: draft.id }, store);

    expect(result.isError).toBe(false);
    const goal = JSON.parse(result.output) as GoalState;
    expect(goal).toMatchObject({ id: draft.id, status: "locked", lockedBy: "session-locker" });
    expect(goal.lockedAt).toBeString();
  });

  it("start claims a locked goal through GoalRunner.claimStart for the current main session", async () => {
    const store = mainStore({ sessionId: "main-session" });
    const locked = await createLockedGoal(store);

    const result = await execute({ action: "start", goalId: locked.id }, store);

    expect(result.isError).toBe(false);
    const goal = JSON.parse(result.output) as GoalState;
    expect(goal).toMatchObject({ id: locked.id, status: "running", mainSessionId: "main-session", phase: "plan" });
  });

  it("advance_phase delegates to GoalRunner.advancePhase", async () => {
    const store = mainStore({ sessionId: "main-session" });
    const locked = await createLockedGoal(store);
    await execute({ action: "start", goalId: locked.id }, store);

    const build = await execute({ action: "advance_phase", goalId: locked.id, nextPhase: "build" }, store);
    const review = await execute({ action: "advance_phase", goalId: locked.id, nextPhase: "review" }, store);

    expect(build.isError).toBe(false);
    expect(JSON.parse(build.output)).toMatchObject({ id: locked.id, status: "running", phase: "build" });
    expect(review.isError).toBe(false);
    expect(JSON.parse(review.output)).toMatchObject({ id: locked.id, status: "running", phase: "review" });
  });

  it("advance_phase requests owner-local after_plan approval and pauses", async () => {
    const projectContext = createTestProjectContext({ approvalDecision: "denied" });
    await writeFile(join(TMP_DIR, "artifact.txt"), "done\n");
    const store = mainStore({ sessionId: "main-session" });
    const created = await execute(validCreateInput({ approvalPoints: ["after_plan"] }), store, projectContext);
    expect(created.isError).toBe(false);
    const goal = JSON.parse(created.output) as GoalState;
    await execute({ action: "lock", goalId: goal.id }, store, projectContext);
    await execute({ action: "start", goalId: goal.id }, store, projectContext);

    const result = await execute({ action: "advance_phase", goalId: goal.id, nextPhase: "build" }, store, projectContext);

    expect(result.isError).toBe(false);
    const paused = JSON.parse(result.output) as GoalState;
    expect(paused).toMatchObject({ id: goal.id, status: "paused", phase: "plan", lastError: "Waiting for after_plan approval" });
    expect(paused.resumeCheckpoint).toMatchObject({ hitlId: "captured-hitl", kind: "goal_approval", action: "advancePhase", approvalPoint: "after_plan" });
  });

  it("retry delegates to GoalRunner.handleFailedVerification", async () => {
    const reviewGoal = await createRunningReviewGoal();
    const manager = new GoalStateManager(TMP_DIR);
    await manager.transitionStatus(reviewGoal.id, "failed");

    const result = await execute({ action: "retry", goalId: reviewGoal.id }, mainStore({ sessionId: "retry-session" }));

    expect(result.isError).toBe(false);
    const goal = JSON.parse(result.output) as GoalState;
    expect(goal).toMatchObject({ id: reviewGoal.id, status: "running", phase: "plan", retryCount: 1, mainSessionId: "retry-session" });
    expect(goal.lastError).toBe("Retry requested by goal_manage.retry");
  });

  it("rejects invalid actions plus irrelevant and extra fields for every strict action schema", async () => {
    const draft = await createDraftGoal();
    const validCases = [
      validCreateInput(),
      { action: "lock", goalId: draft.id },
      { action: "start", goalId: draft.id },
      { action: "advance_phase", goalId: draft.id, nextPhase: "build" },
      { action: "retry", goalId: draft.id },
      { action: "finalize_review", goalId: draft.id, outcome: "NOT_DONE", summary: "Needs repair" },
    ];

    for (const input of validCases) {
      expect(GoalManageInputSchema.safeParse(input).success).toBe(true);
      expect(GoalManageInputSchema.safeParse({ ...input, extra: true }).success).toBe(false);
    }

    expect(GoalManageInputSchema.safeParse({ ...validCreateInput(), goalId: draft.id }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "lock", goalId: draft.id, title: "irrelevant" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "start", goalId: draft.id, title: "irrelevant" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "advance_phase", goalId: draft.id, nextPhase: "build", outcome: "DONE" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "retry", goalId: draft.id, nextPhase: "review" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "finalize_review", goalId: draft.id, outcome: "NOT_DONE", nextPhase: "build" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "complete", goalId: draft.id }).success).toBe(false);

    const result = await execute({ action: "lock", goalId: draft.id, extra: true });

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("schema");
  });

  it("denies finalize_review for orchestrator main sessions", async () => {
    const goal = await createRunningReviewGoal();

    await expectManageDeniedWithoutStatusMutation(
      { action: "finalize_review", goalId: goal.id, outcome: "NOT_DONE", summary: "Needs repair" },
      mainStore({ sessionId: "main-session" }),
      "GOAL_REVIEWER_REQUIRED",
    );
  });

  it("allows the matching reviewer review session to finalize NOT_DONE", async () => {
    const goal = await createRunningReviewGoal();

    const result = await execute(
      { action: "finalize_review", goalId: goal.id, outcome: "NOT_DONE", summary: "Required artifact evidence is still missing." },
      reviewStore(goal.id),
    );

    expect(result.isError).toBe(false);
    const failed = JSON.parse(result.output) as GoalState;
    expect(failed).toMatchObject({ id: goal.id, status: "running", phase: "plan", retryCount: 1 });
    expect(failed.mainSessionId).toBeString();
    expect(failed.mainSessionId).not.toBe("review-session");
    expect(failed.reviewReport).toMatchObject({ outcome: "NOT_DONE", summary: "Required artifact evidence is still missing." });
  });

  it("denies reviewer lifecycle actions", async () => {
    const draft = await createDraftGoal();

    await expectManageDeniedWithoutStatusMutation(
      { action: "lock", goalId: draft.id },
      reviewStore(draft.id),
      "GOAL_MANAGE_ACTION_DENIED",
    );
  });

  it("denies finalize_review for wrong goal sessions and wrong reviewer agents", async () => {
    const goal = await createRunningReviewGoalForReviewer("qa-reviewer");
    const otherGoal = await createRunningReviewGoal();

    await expectManageDeniedWithoutStatusMutation(
      { action: "finalize_review", goalId: goal.id, outcome: "NOT_DONE" },
      reviewStore(goal.id),
      "GOAL_REVIEWER_REQUIRED",
    );

    await expectManageDeniedWithoutStatusMutation(
      { action: "finalize_review", goalId: goal.id, outcome: "NOT_DONE" },
      reviewStore(otherGoal.id, { agentName: "qa-reviewer" }),
      "GOAL_REVIEWER_REQUIRED",
    );
  });

  it("finalize_review DONE cannot bypass missing Done Condition evidence", async () => {
    const goal = await createRunningReviewGoal();

    const result = await execute({ action: "finalize_review", goalId: goal.id, outcome: "DONE" }, reviewStore(goal.id));

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("GOAL_REVIEW_PHASE_REQUIRED");
    const persisted = await new GoalStateManager(TMP_DIR).read(goal.id);
    expect(persisted.status).toBe("running");
    expect(persisted.reviewReport).toBeUndefined();
  });

  it("allows matching reviewer to finalize DONE after required evidence", async () => {
    const goal = await createRunningReviewGoal();
    await recordPassingEvidence(goal.id);

    const result = await execute(
      { action: "finalize_review", goalId: goal.id, outcome: "DONE", summary: "All required Done Conditions passed." },
      reviewStore(goal.id),
    );

    expect(result.isError).toBe(false);
    const completed = JSON.parse(result.output) as GoalState;
    expect(completed.status).toBe("completed");
    expect(completed.reviewReport).toMatchObject({ outcome: "DONE", summary: "All required Done Conditions passed." });
  });

  it("finalize_review DONE requests owner-local before_complete approval and pauses", async () => {
    const projectContext = createTestProjectContext({ approvalDecision: "denied" });
    await writeFile(join(TMP_DIR, "artifact.txt"), "done\n");
    const store = mainStore({ sessionId: "main-session" });
    const created = await execute(validCreateInput({ approvalPoints: ["before_complete"] }), store, projectContext);
    expect(created.isError).toBe(false);
    const goal = JSON.parse(created.output) as GoalState;
    await execute({ action: "lock", goalId: goal.id }, store, projectContext);
    await execute({ action: "start", goalId: goal.id }, store, projectContext);
    await execute({ action: "advance_phase", goalId: goal.id, nextPhase: "build" }, store, projectContext);
    await execute({ action: "advance_phase", goalId: goal.id, nextPhase: "review" }, store, projectContext);
    await new GoalRunner({
      goalStateManager: projectContext.goalState,
      goalArtifacts: projectContext.goalArtifacts,
      hitlService: projectContext.hitl,
      workspaceRoot: TMP_DIR,
      createSession: async () => "main-session",
    }).recordAuthorizedReviewerDoneResult(goal.id, DONE_CONDITION.id, {
      conditionId: DONE_CONDITION.id,
      passed: true,
      evidence: "artifact.txt exists",
      checkedAt: new Date().toISOString(),
    }, {
      agentName: "reviewer",
      sessionRole: "review",
      sessionGoalId: goal.id,
    });

    const result = await execute({ action: "finalize_review", goalId: goal.id, outcome: "DONE" }, reviewStore(goal.id), projectContext);

    expect(result.isError).toBe(false);
    const paused = JSON.parse(result.output) as GoalState;
    expect(paused).toMatchObject({ id: goal.id, status: "paused", phase: "review", lastError: "Waiting for before_complete approval" });
    expect(paused.resumeCheckpoint).toMatchObject({ hitlId: "captured-hitl", kind: "goal_approval", action: "complete", approvalPoint: "before_complete" });
    expect(paused.reviewReport?.outcome).toBe("DONE");
  });

  it("returns GOAL_NOT_FOUND for missing goals", async () => {
    const missingGoalId = crypto.randomUUID();

    const result = await execute({ action: "lock", goalId: missingGoalId });

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("GOAL_NOT_FOUND");
  });
});

describe("goal_evidence builtin tool", () => {
  it("exports the Reviewer evidence descriptor from the goal-tools barrel", () => {
    expect(goalEvidenceTool.name).toBe(TOOL_GOAL_EVIDENCE);
  });

  it("records passing evidence through GoalRunner and transitions running goals to verifying without finalizing", async () => {
    const goal = await createRunningReviewGoal();

    const result = await executeEvidence(
      { action: "check_done", goalId: goal.id, conditionId: DONE_CONDITION.id },
      reviewStore(goal.id),
    );

    expect(result.isError).toBe(false);
    const done = JSON.parse(result.output) as DoneResult;
    expect(done).toMatchObject({ conditionId: DONE_CONDITION.id, passed: true });
    const persisted = await new GoalStateManager(TMP_DIR).read(goal.id);
    expect(persisted.status).toBe("verifying");
    expect(persisted.phase).toBe("review");
    expect(persisted.doneResults[DONE_CONDITION.id]).toMatchObject({ conditionId: DONE_CONDITION.id, passed: true });
    expect(persisted.reviewReport).toBeUndefined();
  });

  it("records failing evidence and still preserves the running to verifying transition", async () => {
    await rm(join(TMP_DIR, "artifact.txt"), { force: true });
    const goal = await createRunningReviewGoal();
    await rm(join(TMP_DIR, "artifact.txt"), { force: true });

    const result = await executeEvidence(
      { action: "check_done", goalId: goal.id, conditionId: DONE_CONDITION.id },
      reviewStore(goal.id),
    );

    expect(result.isError).toBe(false);
    const done = JSON.parse(result.output) as DoneResult;
    expect(done).toMatchObject({ conditionId: DONE_CONDITION.id, passed: false });
    const persisted = await new GoalStateManager(TMP_DIR).read(goal.id);
    expect(persisted.status).toBe("verifying");
    expect(persisted.doneResults[DONE_CONDITION.id]).toMatchObject({ passed: false });
    expect(persisted.reviewReport).toBeUndefined();
  });

  it("denies orchestrator, wrong roles, wrong goals, and wrong reviewer agents", async () => {
    const goal = await createRunningReviewGoalForReviewer("qa-reviewer");
    const otherGoal = await createRunningReviewGoal();
    const input = { action: "check_done", goalId: goal.id, conditionId: DONE_CONDITION.id };

    await expectEvidenceDeniedWithoutStatusMutation(input, mainStore({ sessionId: "main-session" }), "GOAL_REVIEWER_REQUIRED");
    await expectEvidenceDeniedWithoutStatusMutation(input, reviewStore(goal.id, { agentName: "qa-reviewer", sessionRole: "main" }), "GOAL_REVIEWER_REQUIRED");
    await expectEvidenceDeniedWithoutStatusMutation(input, reviewStore(otherGoal.id, { agentName: "qa-reviewer" }), "GOAL_REVIEWER_REQUIRED");
    await expectEvidenceDeniedWithoutStatusMutation(input, reviewStore(goal.id), "GOAL_REVIEWER_REQUIRED");
  });

  it("denies wrong phase and wrong status before evaluating evidence", async () => {
    const store = mainStore({ sessionId: "main-session" });
    const locked = await createLockedGoal(store);
    const started = await execute({ action: "start", goalId: locked.id }, store);
    expect(started.isError).toBe(false);
    await expectEvidenceDeniedWithoutStatusMutation(
      { action: "check_done", goalId: locked.id, conditionId: DONE_CONDITION.id },
      reviewStore(locked.id),
      "GOAL_REVIEW_PHASE_REQUIRED",
    );

    const reviewGoal = await createRunningReviewGoal();
    await new GoalStateManager(TMP_DIR).transitionStatus(reviewGoal.id, "paused");
    await expectEvidenceDeniedWithoutStatusMutation(
      { action: "check_done", goalId: reviewGoal.id, conditionId: DONE_CONDITION.id },
      reviewStore(reviewGoal.id),
      "GOAL_REVIEW_PHASE_REQUIRED",
    );
  });

  it("returns GOAL_CONDITION_NOT_FOUND for missing Done Conditions", async () => {
    const goal = await createRunningReviewGoal();

    const result = await executeEvidence(
      { action: "check_done", goalId: goal.id, conditionId: "missing-condition" },
      reviewStore(goal.id),
    );

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("GOAL_CONDITION_NOT_FOUND");
    const persisted = await new GoalStateManager(TMP_DIR).read(goal.id);
    expect(persisted.status).toBe("running");
    expect(persisted.doneResults).toEqual({});
  });

  it("rejects invalid actions plus irrelevant and extra fields through the strict action schema", async () => {
    const goal = await createRunningReviewGoal();
    const validInput = { action: "check_done", goalId: goal.id, conditionId: DONE_CONDITION.id };

    expect(GoalEvidenceInputSchema.safeParse(validInput).success).toBe(true);
    expect(GoalEvidenceInputSchema.safeParse({ ...validInput, extra: true }).success).toBe(false);
    expect(GoalEvidenceInputSchema.safeParse({ action: "check_done", goalId: goal.id, conditionId: DONE_CONDITION.id, outcome: "DONE" }).success).toBe(false);
    expect(GoalEvidenceInputSchema.safeParse({ action: "check_done", goalId: goal.id, conditionId: DONE_CONDITION.id, summary: "irrelevant" }).success).toBe(false);
    expect(GoalEvidenceInputSchema.safeParse({ action: "finalize_review", goalId: goal.id, conditionId: DONE_CONDITION.id }).success).toBe(false);

    const result = await executeEvidence({ action: "check_done", goalId: goal.id, conditionId: DONE_CONDITION.id, extra: true }, reviewStore(goal.id));

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("schema");
  });
});
