import { afterAll, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";

import { TOOL_GOAL_CREATE, TOOL_GOAL_MANAGE, type GoalReviewReceipt, type GoalState } from "@archcode/protocol";
import { GoalStateManager } from "../../goals/state";
import { GoalCancellationCleanupError } from "../../goals/cancellation";
import { ProjectHitlQueue } from "../../hitl";
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
import { GoalCreateInputSchema, GoalManageInputSchema, goalCreateTool, goalManageTool } from "./goal-tools";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-tools", crypto.randomUUID());
const testSkillService = new SkillService({ builtinSkills: {} });
const DEFAULT_GOAL_ID = "11111111-1111-4111-8111-111111111111";

interface GoalManageCall {
  readonly method: string;
  readonly payload: unknown;
}

class SimplifiedGoalStateManagerMock {
  readonly calls: GoalManageCall[] = [];

  constructor(private readonly readableGoal: GoalState = makeGoalState()) {}

  async read(goalId: string): Promise<GoalState> {
    return { ...this.readableGoal, id: goalId };
  }

  async create(input: {
    projectSlug: string;
    createdFromSessionId: string;
    objective: string;
    acceptanceCriteria: string;
    useWorktree?: boolean;
  }): Promise<GoalState> {
    this.calls.push({ method: "create", payload: input });
    return makeGoalState({
      projectSlug: input.projectSlug,
      createdFromSessionId: input.createdFromSessionId,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      useWorktree: input.useWorktree,
    });
  }

  async beginReview(goalId: string, assertReady?: () => Promise<void>): Promise<GoalState> {
    await assertReady?.();
    this.calls.push({ method: "beginReview", payload: { goalId } });
    return makeGoalState({ id: goalId, status: "reviewing", reviewGeneration: this.readableGoal.reviewGeneration + 1 });
  }

  async finalizeReview(goalId: string, input: {
    readonly expectedReviewGeneration: number;
    readonly verdict: "DONE" | "NOT_DONE";
    readonly summary: string;
    readonly evidenceRefs?: readonly GoalReviewReceipt["evidenceRefs"][number][];
    readonly unresolvedItems?: readonly string[];
    readonly finalSummary?: string;
    readonly authorization: { readonly reviewerSessionId?: string };
  }): Promise<GoalState> {
    const review: GoalReviewReceipt = {
      reviewGeneration: input.expectedReviewGeneration,
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

  async retry(goalId: string): Promise<GoalState> {
    const mainSessionId = this.readableGoal.mainSessionId ?? "main-session";
    this.calls.push({ method: "retry", payload: { goalId } });
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
    agentName: "goal_lead",
    sessionRole: "main",
    goalId: DEFAULT_GOAL_ID,
    ...overrides,
  });
}

function engineerStore(overrides: Partial<SessionStoreState> = {}): StoreApi<SessionStoreState> {
  return createMockStore({
    sessionId: "engineer-session",
    rootSessionId: "engineer-session",
    agentName: "engineer",
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
  const project = {
    slug: "test-project",
    name: "Test Project",
    workspaceRoot,
    addedAt: new Date().toISOString(),
  };
  const resolvedGoalState = goalState as unknown as GoalStateManager;
  const hitl = new ProjectHitlQueue({ workspaceRoot });
  return {
    project,
    goalState: resolvedGoalState,
    goalLifecycle: goalState as unknown as ProjectContext["goalLifecycle"],
    createAutomation: async () => { throw new Error("unused automation creator"); },
    goalCancellation: {
      cancel: (goalId, request) => goalState.cancel(goalId, request.reason),
    },
    hitl,
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
  executionCwd = projectContext.project.workspaceRoot,
  toolName = TOOL_GOAL_MANAGE,
): ToolExecutionContext {
  return createToolExecutionContext({
    store,
    storeManager,
    toolName,
    toolCallId: "goal-manage-call",
    input,
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set([toolName]),
    agentName: store.getState().agentName,
    agentSkills: [],
    skillService: testSkillService,
    projectContext,
    cwd: executionCwd,
  });
}

async function executeCreate(
  input: unknown,
  options: {
    store?: StoreApi<SessionStoreState>;
    goalState?: SimplifiedGoalStateManagerMock;
  } = {},
): Promise<{ result: ToolExecutionResult; goalState: SimplifiedGoalStateManagerMock }> {
  const goalState = options.goalState ?? new SimplifiedGoalStateManagerMock();
  const parsed = goalCreateTool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      goalState,
      result: createToolErrorResult({
        kind: "schema",
        zodError: parsed.error,
        expectedInput: `Tool "${TOOL_GOAL_CREATE}" input must match its registered Zod schema.`,
      }),
    };
  }

  const projectContext = makeProjectContext(goalState, TMP_DIR);
  const output = await goalCreateTool.execute(
    parsed.data,
    makeCtx(parsed.data, options.store ?? engineerStore(), projectContext, projectContext.project.workspaceRoot, TOOL_GOAL_CREATE),
  );
  return { goalState, result: typeof output === "string" ? { output, isError: false } : output };
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
    id: overrides.id ?? DEFAULT_GOAL_ID,
    projectSlug: "test-project",
    createdFromSessionId: "engineer-session",
    title: null,
    objective: "Simplify Goal tools.",
    acceptanceCriteria: "The simplified lifecycle is enforced.",
    status: "running",
    attempt: 1,
    reviewGeneration: 0,
    mainSessionId: "main-session",
    childSessionIds: [],
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    startedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
    appliedBudgetHitlIds: overrides.appliedBudgetHitlIds ?? [],
    useWorktree: overrides.useWorktree ?? false,
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
  it("exposes committed creation and managed lifecycle descriptors", () => {
    expect(goalCreateTool.name).toBe(TOOL_GOAL_CREATE);
    expect(goalCreateTool.description).toContain("Commit and activate");
    expect(goalManageTool.name).toBe(TOOL_GOAL_MANAGE);
    expect(goalManageTool.description).toContain("begin_review, finalize_review, retry, or cancel");
  });

  it("accepts confirmed creation input separately and rejects create/start in managed lifecycle", () => {
    const goalId = "11111111-1111-4111-8111-111111111111";
    const validCases = [
      { action: "begin_review", goalId },
      { action: "finalize_review", goalId, expectedReviewGeneration: 1, verdict: "DONE", summary: "Verified", evidenceRefs: [validEvidenceRef()], finalSummary: "Done" },
      { action: "retry", goalId },
      { action: "cancel", goalId, reason: "No longer needed" },
    ];

    for (const input of validCases) {
      expect(GoalManageInputSchema.safeParse(input).success).toBe(true);
      expect(GoalManageInputSchema.safeParse({ ...input, extra: true }).success).toBe(false);
    }

    expect(GoalCreateInputSchema.safeParse({ objective: "Do the thing", acceptanceCriteria: "It works", useWorktree: true }).success).toBe(true);
    expect(GoalCreateInputSchema.safeParse({ action: "create", objective: "Do the thing", acceptanceCriteria: "It works" }).success).toBe(false);
    expect(GoalCreateInputSchema.safeParse({ objective: "Do the thing", acceptanceCriteria: "It works", createdFromSessionId: "forged" }).success).toBe(false);

    expect(GoalManageInputSchema.safeParse({ action: "create", objective: "Do the thing", acceptanceCriteria: "It works" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "start", goalId }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "block", goalId, kind: "approval", summary: "Waiting" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "resume", goalId }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "lock", goalId }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "advance_phase", goalId, nextPhase: "build" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "begin_review", goalId, reviewerSessionId: "unused" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({
      action: "block",
      goalId,
      kind: "approval",
      summary: "Waiting on approval",
      hitlId: "hitl-1",
    }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "finalize_review", goalId, outcome: "DONE", summary: "Verified", evidenceRefs: [validEvidenceRef()] }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "finalize_review", goalId, verdict: "DONE", summary: "Verified", evidenceRefs: [] }).success).toBe(false);
  });

  it("dispatches begin_review/retry/cancel to the lifecycle manager", async () => {
    const goalId = DEFAULT_GOAL_ID;
    const goalState = new SimplifiedGoalStateManagerMock();
    const inputs = [
      { action: "begin_review", goalId },
      { action: "retry", goalId },
      { action: "cancel", goalId, reason: "Stopped" },
    ];

    for (const input of inputs) {
      const { result } = await execute(input, { goalState });
      expect(result.isError).toBe(false);
    }

    expect(goalState.calls.map((call) => call.method)).toEqual([
      "beginReview",
      "retry",
      "cancel",
    ]);
  });

  it("rejects begin_review while a Build child is still active", async () => {
    const goalState = new SimplifiedGoalStateManagerMock(makeGoalState({ status: "running", mainSessionId: "main-session" }));
    const store = mainStore({
      childSessionLinks: [{
        parentSessionId: "main-session",
        parentToolCallId: "delegate-build",
        toolName: "delegate",
        childSessionId: "build-session",
        childAgentName: "build",
        depth: 1,
        background: true,
        status: "waiting_for_human",
        createdAt: Date.now(),
      }],
    });

    const { result } = await execute({ action: "begin_review", goalId: DEFAULT_GOAL_ID }, { goalState, store });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("GOAL_BUILD_ACTIVE");
    expect(goalState.calls).toEqual([]);
  });

  it("rejects begin_review while a nested Plan-to-Build child is still active", async () => {
    const planSessionId = crypto.randomUUID();
    const buildSessionId = crypto.randomUUID();
    const planStore = storeManager.create(planSessionId, TMP_DIR, {
      rootSessionId: "main-session",
      parentSessionId: "main-session",
      agentName: "plan",
      goalId: DEFAULT_GOAL_ID,
    });
    planStore.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: planSessionId,
        parentToolCallId: "delegate-build",
        toolName: "delegate",
        childSessionId: buildSessionId,
        childAgentName: "build",
        depth: 2,
        background: true,
        status: "running",
        createdAt: Date.now(),
      },
    });
    await storeManager.flushSession(planSessionId, TMP_DIR);
    const store = mainStore({
      childSessionLinks: [{
        parentSessionId: "main-session",
        parentToolCallId: "delegate-plan",
        toolName: "delegate",
        childSessionId: planSessionId,
        childAgentName: "plan",
        depth: 1,
        background: false,
        status: "completed",
        createdAt: Date.now(),
      }],
    });
    const goalState = new SimplifiedGoalStateManagerMock(makeGoalState({ status: "running", mainSessionId: "main-session" }));

    const { result } = await execute({ action: "begin_review", goalId: DEFAULT_GOAL_ID }, { goalState, store });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("GOAL_BUILD_ACTIVE");
    expect(goalState.calls).toEqual([]);
  });

  it("rejects lifecycle actions from a previous Goal Lead main Session", async () => {
    const goalState = new SimplifiedGoalStateManagerMock(makeGoalState({
      status: "not_done",
      mainSessionId: "current-main-session",
    }));

    const { result } = await execute(
      { action: "retry", goalId: DEFAULT_GOAL_ID },
      { goalState, store: mainStore({ sessionId: "previous-main-session" }) },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("GOAL_CONTEXT_REQUIRED");
    expect(goalState.calls).toEqual([]);
  });

  it("allows a not_done Goal Lead to retry or cancel but rejects other lifecycle actions", async () => {
    const workspaceRoot = join(TMP_DIR, `not-done-${crypto.randomUUID()}`);
    const manager = new GoalStateManager(workspaceRoot);
    const createNotDone = async () => {
      const committed = await manager.commit({
        id: crypto.randomUUID(),
        projectSlug: "test-project",
        createdFromSessionId: crypto.randomUUID(),
        objective: "Exercise not_done phase capabilities.",
        acceptanceCriteria: "Only retry and cancel remain executable.",
        mainSessionId: "main-session",
      });
      const reviewing = await manager.beginReview(committed.id);
      return await manager.finalizeReview(committed.id, {
        expectedReviewGeneration: reviewing.reviewGeneration,
        verdict: "NOT_DONE",
        summary: "More work remains.",
        authorization: {
          agentName: "reviewer",
          sessionRole: "review",
          sessionGoalId: committed.id,
          reviewerSessionId: "review-session",
        },
      });
    };
    const executeManaged = async (input: unknown, goalId: string) => {
      const parsed = goalManageTool.inputSchema.parse(input);
      const context = makeProjectContext(manager, workspaceRoot);
      return normalizeOutput(await goalManageTool.execute(parsed, makeCtx(parsed, mainStore({ goalId }), context, workspaceRoot)));
    };

    const notDone = await createNotDone();
    for (const input of [{ action: "begin_review", goalId: notDone.id }]) {
      expect((await executeManaged(input, notDone.id)).isError).toBe(true);
    }
    expect((await executeManaged({ action: "retry", goalId: notDone.id }, notDone.id)).isError).toBe(false);

    const cancellable = await createNotDone();
    expect((await executeManaged({ action: "cancel", goalId: cancellable.id }, cancellable.id)).isError).toBe(false);
  });

  it("commits a Goal only from an unbound Engineer root Session and derives provenance", async () => {
    const goalState = new SimplifiedGoalStateManagerMock();
    const input = { objective: "Do the thing", acceptanceCriteria: "It works", useWorktree: true };
    const { result } = await executeCreate(input, { goalState });

    expect(result.isError).toBe(false);
    expect(goalState.calls).toEqual([{ method: "create", payload: {
      projectSlug: "test-project",
      createdFromSessionId: "engineer-session",
      objective: "Do the thing",
      acceptanceCriteria: "It works",
      useWorktree: true,
    } }]);
    expect(JSON.parse(result.output)).toMatchObject({ projectSlug: "test-project", status: "running", createdFromSessionId: "engineer-session" });

    const standalone = await executeCreate(input, { store: engineerStore({ sessionRole: "standalone" }) });
    expect(standalone.result.isError).toBe(false);

    for (const store of [
      mainStore({ goalId: undefined }),
      engineerStore({ goalId: DEFAULT_GOAL_ID }),
      engineerStore({ sessionRole: "main" }),
      engineerStore({ parentSessionId: "parent-session", rootSessionId: "parent-session" }),
    ]) {
      const denied = await executeCreate(input, { goalState: new SimplifiedGoalStateManagerMock(), store });
      expect(denied.result.isError).toBe(true);
      expect(denied.result.output).toContain("GOAL_CREATE_DENIED");
    }
  });

  it("marks self-cancellation as an explicit Session-family execution stop", async () => {
    const goalState = new SimplifiedGoalStateManagerMock();

    const { result } = await execute(
      { action: "cancel", goalId: DEFAULT_GOAL_ID, reason: "Stop this Goal" },
      { goalState },
    );

    expect(result).toMatchObject({
      isError: false,
      meta: {
        executionControl: {
          action: "stop_session_family",
          reason: "goal_cancelled",
        },
      },
    });
  });

  it("still stops the current Session family when cleanup fails after durable cancellation", async () => {
    const goalState = new SimplifiedGoalStateManagerMock();
    const input = { action: "cancel" as const, goalId: DEFAULT_GOAL_ID, reason: "Stop this Goal" };
    const projectContext: ProjectContext = {
      ...makeProjectContext(goalState),
      goalCancellation: {
        cancel: async () => {
          const cancelled = makeGoalState({ id: DEFAULT_GOAL_ID, status: "cancelled" });
          throw new GoalCancellationCleanupError(DEFAULT_GOAL_ID, cancelled, new Error("checkpoint cleanup failed"));
        },
      },
    };

    const output = await goalManageTool.execute(input, makeCtx(input, mainStore(), projectContext));
    const result = normalizeOutput(output);

    expect(result.isError).toBe(true);
    expect(result.meta?.executionControl).toEqual({
      action: "stop_session_family",
      reason: "goal_cancelled_cleanup_incomplete",
    });
  });

  it("rejects every targeted action across Goals", async () => {
    const targetGoalId = DEFAULT_GOAL_ID;
    const currentGoalId = "22222222-2222-4222-8222-222222222222";
    const goalState = new SimplifiedGoalStateManagerMock();

    const targetedInputs = [
      { action: "begin_review", goalId: targetGoalId },
      { action: "retry", goalId: targetGoalId },
      { action: "cancel", goalId: targetGoalId },
    ] as const;

    for (const input of targetedInputs) {
      const { result } = await execute(input, {
        store: mainStore({ goalId: currentGoalId }),
        goalState,
      });
      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("permission-denied");
      expect(result.output).toContain("GOAL_CONTEXT_REQUIRED");
      expect(result.output).toContain(currentGoalId);
      expect(result.output).toContain(targetGoalId);
    }
    expect(goalState.calls).toEqual([]);
  });

  it("denies lifecycle actions for Reviewer sessions", async () => {
    const goalId = "11111111-1111-4111-8111-111111111111";

    const { result, goalState } = await execute(
      { action: "begin_review", goalId },
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
      expectedReviewGeneration: 1,
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
        expectedReviewGeneration: 1,
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
      expectedReviewGeneration: 1,
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
