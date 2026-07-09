import { afterAll, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";

import { TOOL_GOAL_MANAGE, type GoalBlockerKind, type GoalReviewReceipt, type GoalState } from "@archcode/protocol";
import { GoalStateManager } from "../../goals/state";
import { HitlService } from "../../hitl/service";
import { LoopStateManager } from "../../loops/state";
import { MemoryFileManager } from "../../memory/file-manager";
import type { ProjectContext } from "../../projects/types";
import { SkillService } from "../../skills";
import { createMockStore } from "../../store/test-helpers";
import { storeManager } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import { createToolErrorResult, inferToolErrorKindFromResult } from "../errors";
import { ProjectApprovalManager } from "../permission/project-approvals";
import { createToolExecutionContext, type ToolExecutionContext, type ToolExecutionResult } from "../types";
import { silentLogger } from "../../logger";
import { GoalManageInputSchema, goalManageTool } from "./goal-tools";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-tools");
const testSkillService = new SkillService({ builtinSkills: {} });

interface GoalManageCall {
  readonly method: string;
  readonly payload: unknown;
}

class SimplifiedGoalStateManagerMock {
  readonly calls: GoalManageCall[] = [];

  async create(input: {
    projectId: string;
    objective: string;
    acceptanceCriteria: string;
  }): Promise<GoalState> {
    this.calls.push({ method: "create", payload: input });
    return makeGoalState({
      projectId: input.projectId,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
    });
  }

  async start(goalId: string, input: { readonly mainSessionId?: string }): Promise<GoalState> {
    const mainSessionId = input.mainSessionId ?? "main-session";
    this.calls.push({ method: "start", payload: { goalId, mainSessionId } });
    return makeGoalState({ id: goalId, status: "running", mainSessionId, startedAt: "2026-07-08T00:00:00.000Z" });
  }

  async block(goalId: string, blocker: {
    kind: GoalBlockerKind;
    summary: string;
    hitlId?: string;
    source?: string;
    resumeStatus?: "running" | "reviewing";
  }): Promise<GoalState> {
    this.calls.push({ method: "block", payload: { goalId, blocker } });
    return makeGoalState({
      id: goalId,
      status: "blocked",
      blocker: { ...blocker, createdAt: "2026-07-08T00:00:00.000Z" },
      pendingHitlIds: blocker.hitlId === undefined ? [] : [blocker.hitlId],
    });
  }

  async clearBlocker(goalId: string, hitlId?: string): Promise<GoalState> {
    this.calls.push({ method: "clearBlocker", payload: { goalId, hitlId } });
    return makeGoalState({ id: goalId, status: "running" });
  }

  async beginReview(goalId: string): Promise<GoalState> {
    this.calls.push({ method: "beginReview", payload: { goalId } });
    return makeGoalState({ id: goalId, status: "reviewing" });
  }

  async finalizeReview(goalId: string, input: {
    readonly verdict: "DONE" | "NOT_DONE";
    readonly summary: string;
    readonly evidenceRefs?: readonly GoalReviewReceipt["evidenceRefs"][number][];
    readonly unresolvedItems?: readonly string[];
    readonly finalSummary?: string;
    readonly authorization: { readonly reviewerSessionId?: string };
  }): Promise<GoalState> {
    const review: GoalReviewReceipt = {
      verdict: input.verdict,
      summary: input.summary,
      evidenceRefs: [...(input.evidenceRefs ?? [])],
      reviewerSessionId: input.authorization.reviewerSessionId ?? "review-session",
      decidedAt: "2026-07-08T00:00:00.000Z",
      ...(input.unresolvedItems === undefined ? {} : { unresolvedItems: [...input.unresolvedItems] }),
    };
    const finalSummary = input.finalSummary;
    this.calls.push({ method: "finalizeReview", payload: { goalId, review, finalSummary } });
    return makeGoalState({
      id: goalId,
      status: review.verdict === "DONE" ? "done" : "not_done",
      review,
      finalSummary,
      completedAt: review.verdict === "DONE" ? review.decidedAt : undefined,
      lastFailureSummary: review.verdict === "NOT_DONE" ? review.summary : undefined,
    });
  }

  async retry(goalId: string, input: { readonly mainSessionId?: string }): Promise<GoalState> {
    const mainSessionId = input.mainSessionId ?? "main-session";
    this.calls.push({ method: "retry", payload: { goalId, mainSessionId } });
    return makeGoalState({ id: goalId, status: "running", attempt: 2, mainSessionId });
  }

  async cancel(goalId: string, reason?: string): Promise<GoalState> {
    this.calls.push({ method: "cancel", payload: { goalId, reason } });
    return makeGoalState({ id: goalId, status: "cancelled", finalSummary: reason, cancelledAt: "2026-07-08T00:00:00.000Z" });
  }
}

function mainStore(overrides: Partial<SessionStoreState> = {}): StoreApi<SessionStoreState> {
  return createMockStore({
    sessionId: "main-session",
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

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function makeProjectContext(
  goalState: SimplifiedGoalStateManagerMock | GoalStateManager = new SimplifiedGoalStateManagerMock(),
  workspaceRoot = TMP_DIR,
): ProjectContext {
  return {
    project: {
      slug: "test-project",
      name: "Test Project",
      workspaceRoot,
      addedAt: new Date().toISOString(),
    },
    goalState: goalState as unknown as GoalStateManager,
    loopState: new LoopStateManager(workspaceRoot),
    hitl: new HitlService(),
    memory: new MemoryFileManager({
      project: join(workspaceRoot, ".archcode", "memory"),
      user: join(workspaceRoot, ".archcode", "user-memory"),
    }),
    approvals: new ProjectApprovalManager(silentLogger),
  };
}

function makeCtx(
  input: unknown,
  store: StoreApi<SessionStoreState>,
  projectContext: ProjectContext,
): ToolExecutionContext {
  return createToolExecutionContext({
    store,
    storeManager,
    toolName: TOOL_GOAL_MANAGE,
    toolCallId: "goal-manage-call",
    input,
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set([TOOL_GOAL_MANAGE]),
    agentName: store.getState().agentName,
    agentSkills: [],
    skillService: testSkillService,
    projectContext,
  });
}

async function execute(
  input: unknown,
  options: {
    store?: StoreApi<SessionStoreState>;
    goalState?: SimplifiedGoalStateManagerMock;
  } = {},
): Promise<{ result: ToolExecutionResult; goalState: SimplifiedGoalStateManagerMock }> {
  const goalState = options.goalState ?? new SimplifiedGoalStateManagerMock();
  const parsed = goalManageTool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      goalState,
      result: createToolErrorResult({
        kind: "schema",
        zodError: parsed.error,
        expectedInput: `Tool "${TOOL_GOAL_MANAGE}" input must match its registered Zod schema.`,
      }),
    };
  }

  const projectContext = makeProjectContext(goalState);
  const output = await goalManageTool.execute(parsed.data, makeCtx(parsed.data, options.store ?? mainStore(), projectContext));
  return { goalState, result: typeof output === "string" ? { output, isError: false } : output };
}

function normalizeOutput(output: string | ToolExecutionResult): ToolExecutionResult {
  return typeof output === "string" ? { output, isError: false } : output;
}

function makeGoalState(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    projectId: "test-project",
    title: null,
    objective: "Simplify Goal tools.",
    acceptanceCriteria: "The simplified lifecycle is enforced.",
    status: "draft",
    attempt: 1,
    pendingHitlIds: [],
    approvalRefs: [],
    childSessionIds: [],
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function validEvidenceRef() {
  return {
    kind: "test_output",
    ref: "bun test packages/agent-core/src/tools/builtins/goal-tools.test.ts",
    summary: "Targeted goal tool tests passed.",
  };
}

describe("goal_manage builtin tool", () => {
  it("exports only the simplified lifecycle descriptor from the goal-tools barrel", () => {
    expect(goalManageTool.name).toBe(TOOL_GOAL_MANAGE);
    expect(goalManageTool.description).toContain("create, start, block, resume, begin_review, finalize_review, retry, or cancel");
  });

  it("accepts exactly the simplified action allowlist and rejects legacy fields", () => {
    const goalId = "11111111-1111-4111-8111-111111111111";
    const validCases = [
      { action: "create", objective: "Do the thing", acceptanceCriteria: "It works" },
      { action: "start", goalId },
      { action: "block", goalId, kind: "approval", summary: "Waiting on approval", hitlId: "hitl-1", source: "test", resumeStatus: "running" },
      { action: "resume", goalId, hitlId: "hitl-1" },
      { action: "begin_review", goalId, reviewerSessionId: "review-session" },
      { action: "finalize_review", goalId, verdict: "DONE", summary: "Verified", evidenceRefs: [validEvidenceRef()], finalSummary: "Done" },
      { action: "retry", goalId },
      { action: "cancel", goalId, reason: "No longer needed" },
    ];

    for (const input of validCases) {
      expect(GoalManageInputSchema.safeParse(input).success).toBe(true);
      expect(GoalManageInputSchema.safeParse({ ...input, extra: true }).success).toBe(false);
    }

    expect(GoalManageInputSchema.safeParse({ action: "lock", goalId }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "advance_phase", goalId, nextPhase: "build" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "create", title: "Goal", objective: "Do the thing", acceptanceCriteria: "It works" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "create", title: "Goal", doneConditions: [], retryPolicy: {}, approvalPoints: [] }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "finalize_review", goalId, outcome: "DONE", summary: "Verified", evidenceRefs: [validEvidenceRef()] }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "finalize_review", goalId, verdict: "DONE", summary: "Verified", evidenceRefs: [] }).success).toBe(false);
  });

  it("dispatches create/start/block/resume/begin_review/retry/cancel to the simplified manager", async () => {
    const goalId = "11111111-1111-4111-8111-111111111111";
    const goalState = new SimplifiedGoalStateManagerMock();
    const inputs = [
      { action: "create", objective: "Do the thing", acceptanceCriteria: "It works" },
      { action: "start", goalId },
      { action: "block", goalId, kind: "permission", summary: "Need permission", source: "tool", resumeStatus: "reviewing" },
      { action: "resume", goalId, hitlId: "hitl-1" },
      { action: "begin_review", goalId, reviewerSessionId: "review-session" },
      { action: "retry", goalId },
      { action: "cancel", goalId, reason: "Stopped" },
    ];

    for (const input of inputs) {
      const { result } = await execute(input, { goalState });
      expect(result.isError).toBe(false);
    }

    expect(goalState.calls.map((call) => call.method)).toEqual([
      "create",
      "start",
      "block",
      "clearBlocker",
      "beginReview",
      "retry",
      "cancel",
    ]);
  });

  it("enforces start claim ownership through the Goal state manager", async () => {
    const workspaceRoot = join(TMP_DIR, `state-${crypto.randomUUID()}`);
    const manager = new GoalStateManager(workspaceRoot);
    const projectContext = makeProjectContext(manager, workspaceRoot);
    const created = await manager.create({
      projectId: "test-project",
      objective: "Keep Goal ownership inside the state machine.",
      acceptanceCriteria: "Repeated starts are idempotent for the same main session and rejected for a different one.",
    });
    const input = { action: "start", goalId: created.id } as const;

    const first = normalizeOutput(await goalManageTool.execute(input, makeCtx(input, mainStore({ sessionId: "main-session-a" }), projectContext)));
    const second = normalizeOutput(await goalManageTool.execute(input, makeCtx(input, mainStore({ sessionId: "main-session-a" }), projectContext)));
    const conflicting = normalizeOutput(await goalManageTool.execute(input, makeCtx(input, mainStore({ sessionId: "main-session-b" }), projectContext)));

    expect(first.isError).toBe(false);
    expect(JSON.parse(first.output) as GoalState).toMatchObject({ status: "running", mainSessionId: "main-session-a" });
    expect(second.isError).toBe(false);
    expect(JSON.parse(second.output) as GoalState).toMatchObject({ status: "running", mainSessionId: "main-session-a" });
    expect(conflicting.isError).toBe(true);
    expect(conflicting.output).toContain("GOAL_INVALID_TRANSITION");
    expect(conflicting.output).toContain("Invalid goal transition running -> running");
    const persisted = await manager.read(created.id);
    expect(persisted).toMatchObject({ status: "running", mainSessionId: "main-session-a" });
  });

  it("denies lifecycle actions for Reviewer sessions", async () => {
    const goalId = "11111111-1111-4111-8111-111111111111";

    const { result, goalState } = await execute(
      { action: "start", goalId },
      { store: reviewStore(goalId) },
    );

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("permission-denied");
    expect(result.output).toContain("GOAL_MANAGE_ACTION_DENIED");
    expect(goalState.calls).toEqual([]);
  });

  it("rejects finalize_review for non-Reviewer sessions before mutation", async () => {
    const goalId = "11111111-1111-4111-8111-111111111111";

    const { result, goalState } = await execute({
      action: "finalize_review",
      goalId,
      verdict: "NOT_DONE",
      summary: "Missing test evidence.",
      evidenceRefs: [],
    });

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("permission-denied");
    expect(result.output).toContain("GOAL_REVIEWER_REQUIRED");
    expect(goalState.calls).toEqual([]);
  });

  it("allows the matching Reviewer review session to finalize a receipt", async () => {
    const goalId = "11111111-1111-4111-8111-111111111111";

    const { result, goalState } = await execute(
      {
        action: "finalize_review",
        goalId,
        verdict: "DONE",
        summary: "All acceptance criteria are verified.",
        evidenceRefs: [validEvidenceRef()],
        unresolvedItems: [],
        finalSummary: "Goal completed.",
      },
      { store: reviewStore(goalId) },
    );

    expect(result.isError).toBe(false);
    const completed = JSON.parse(result.output) as GoalState;
    expect(completed.status).toBe("done");
    expect(completed.review).toMatchObject({
      verdict: "DONE",
      summary: "All acceptance criteria are verified.",
      reviewerSessionId: "review-session",
    });
    expect(goalState.calls).toHaveLength(1);
    expect(goalState.calls[0]).toMatchObject({ method: "finalizeReview" });
  });

  it("denies finalize_review for wrong roles and wrong Goal-scoped review sessions", async () => {
    const goalId = "11111111-1111-4111-8111-111111111111";
    const otherGoalId = "22222222-2222-4222-8222-222222222222";
    const input = {
      action: "finalize_review",
      goalId,
      verdict: "NOT_DONE",
      summary: "More work required.",
      evidenceRefs: [],
    };

    for (const store of [
      reviewStore(goalId, { sessionRole: "main" }),
      reviewStore(otherGoalId),
      mainStore({ agentName: "build", sessionRole: "review", goalId }),
    ]) {
      const { result, goalState } = await execute(input, { store });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("GOAL_REVIEWER_REQUIRED");
      expect(goalState.calls).toEqual([]);
    }
  });
});
