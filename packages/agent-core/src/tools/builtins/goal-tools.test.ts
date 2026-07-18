import { afterAll, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";

import { TOOL_GOAL_CREATE, TOOL_GOAL_MANAGE, type DelegationContract, type FinalizedToolResult, type GoalReviewReceipt, type GoalState } from "@archcode/protocol";
import { hashDelegationContract } from "../../delegation/contract";
import { GoalStateManager } from "../../goals/state";
import { GoalCancellationCleanupError } from "../../goals/cancellation";
import { testReviewExecutionFields } from "../../goals/test-review-fixture";
import { ProjectHitlQueue } from "../../hitl";
import { MemoryFileManager } from "../../memory/file-manager";
import type { ProjectContext } from "../../projects/types";
import { SkillService } from "../../skills";
import { createMockStore } from "../../store/test-helpers";
import { storeManager } from "../../store/store";
import type { SessionStoreState, SessionToolBatch } from "../../store/types";
import { createToolErrorResult, inferToolErrorKindFromResult } from "../errors";
import { ProjectApprovalManager } from "../permission/project-approvals";
import {
  countStructuredResultFailures,
  createStructuredResultCorrectionGate,
} from "../structured-result-correction";
import { expectTextDraft } from "../test-results";
import { createTestToolRegistryFixture, type TestToolRegistryFixture } from "../test-registry";
import { createToolExecutionContext, type RawToolResult, type RegistryExecutionOutcome, type ToolExecutionContext } from "../types";
import { silentLogger } from "../../logger";
import { createTestHitlCodec, createTestProjectTodoService } from "../test-project-context";
import { GoalCreateInputSchema, GoalManageInputSchema, goalCreateTool, goalManageTool } from "./goal-tools";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-tools", crypto.randomUUID());
const testSkillService = new SkillService({ builtinSkills: {} });
const DEFAULT_GOAL_ID = "11111111-1111-4111-8111-111111111111";
const registryFixtures: TestToolRegistryFixture[] = [];

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
    readonly executionId: string;
    readonly delegationContractHash: string;
    readonly result: GoalReviewReceipt["result"];
    readonly evidenceRefs?: readonly GoalReviewReceipt["evidenceRefs"][number][];
    readonly unresolvedItems?: readonly string[];
    readonly finalSummary?: string;
    readonly authorization: { readonly reviewerSessionId?: string };
  }): Promise<GoalState> {
    const review: GoalReviewReceipt = {
      reviewGeneration: input.expectedReviewGeneration,
      verdict: input.verdict,
      summary: input.summary,
      executionId: input.executionId,
      delegationContractHash: input.delegationContractHash,
      result: input.result,
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
  const delegationContract: DelegationContract = {
    agent_type: "reviewer",
    title: "Review Goal",
    objective: "Verify the Goal acceptance criteria",
    owned_scope: [],
    non_goals: [],
    acceptance_criteria: [{ id: "acceptance", condition: "Goal is verified", requiredEvidence: "Review evidence" }],
    evidence: [],
    verification: [],
    depends_on: [],
    skills: [],
    background: false,
  };
  return createMockStore({
    sessionId: "review-session",
    agentName: "reviewer",
    sessionRole: "review",
    goalId,
    currentExecutionId: "review-execution",
    delegationContract,
    delegationContractHash: hashDelegationContract(delegationContract),
    ...overrides,
  });
}

afterAll(async () => {
  await Promise.all(registryFixtures.splice(0).map((fixture) => fixture.dispose()));
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
  const hitl = new ProjectHitlQueue({ workspaceRoot, codec: createTestHitlCodec() });
  return {
    project,
    goalState: resolvedGoalState,
    goalLifecycle: goalState as unknown as ProjectContext["goalLifecycle"],
    createAutomation: async () => { throw new Error("unused automation creator"); },
    todos: createTestProjectTodoService(workspaceRoot, project.slug),
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
): Promise<{ result: RawToolResult; goalState: SimplifiedGoalStateManagerMock }> {
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
  return { goalState, result: output };
}

async function execute(
  input: unknown,
  options: {
    store?: StoreApi<SessionStoreState>;
    goalState?: SimplifiedGoalStateManagerMock;
  } = {},
): Promise<{ result: RawToolResult; goalState: SimplifiedGoalStateManagerMock }> {
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
  return { goalState, result: output };
}

function normalizeOutput(output: RawToolResult): RawToolResult {
  return output;
}

function finalizedInlineResult(result: RawToolResult): FinalizedToolResult {
  const text = expectTextDraft(result);
  const count = { bytes: new TextEncoder().encode(text).byteLength, lines: text.length === 0 ? 0 : text.split("\n").length };
  return {
    isError: result.isError,
    output: {
      preview: text,
      completeness: "complete",
      observed: count,
      canonical: count,
      stored: count,
      omitted: { bytes: 0, lines: 0 },
      recovery: { kind: "none" },
    },
    ...(result.details === undefined ? {} : { details: result.details }),
  };
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

function finalizeReviewInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: "finalize_review",
    goalId: DEFAULT_GOAL_ID,
    expectedReviewGeneration: 1,
    verdict: "DONE",
    summary: "All acceptance criteria are verified.",
    evidenceRefs: [validEvidenceRef()],
    unresolvedItems: [],
    finalSummary: "Goal completed.",
    result: testReviewExecutionFields("DONE").result,
    ...overrides,
  };
}

async function executeGoalManageWithCorrection(
  input: unknown,
  store: StoreApi<SessionStoreState>,
  policy: "strict" | "best_effort",
  initialFailures = 0,
): Promise<Extract<RegistryExecutionOutcome, { kind: "settled" }>> {
  const ctx = makeCtx(input, store, makeProjectContext());
  ctx.structuredResultCorrection = createStructuredResultCorrectionGate(
    policy,
    initialFailures,
    "goal_manage.finalize_review",
  );
  const outcome = await createGoalManageRegistry().execute({
    toolName: TOOL_GOAL_MANAGE,
    toolCallId: crypto.randomUUID(),
    input,
  }, ctx);
  if (outcome.kind !== "settled") throw new Error("Expected settled goal_manage result");
  return outcome;
}

function createGoalManageRegistry() {
  const fixture = createTestToolRegistryFixture({ descriptors: [goalManageTool] });
  registryFixtures.push(fixture);
  return fixture.registry;
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
      { action: "finalize_review", goalId, expectedReviewGeneration: 1, verdict: "DONE", summary: "Verified", evidenceRefs: [validEvidenceRef()], finalSummary: "Done", result: testReviewExecutionFields("DONE").result },
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
        title: "Build child",
        depth: 1,
        background: true,
        status: "waiting_for_human",
        createdAt: Date.now(),
      }],
    });

    const { result } = await execute({ action: "begin_review", goalId: DEFAULT_GOAL_ID }, { goalState, store });

    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("GOAL_BUILD_ACTIVE");
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
        title: "Build child",
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
        title: "Plan child",
        depth: 1,
        background: false,
        status: "completed",
        createdAt: Date.now(),
      }],
    });
    const goalState = new SimplifiedGoalStateManagerMock(makeGoalState({ status: "running", mainSessionId: "main-session" }));

    const { result } = await execute({ action: "begin_review", goalId: DEFAULT_GOAL_ID }, { goalState, store });

    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("GOAL_BUILD_ACTIVE");
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
    expect(expectTextDraft(result)).toContain("GOAL_CONTEXT_REQUIRED");
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
        ...testReviewExecutionFields("NOT_DONE"),
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
    expect(JSON.parse(expectTextDraft(result))).toMatchObject({ projectSlug: "test-project", status: "running", createdFromSessionId: "engineer-session" });

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
      expect(expectTextDraft(denied.result)).toContain("GOAL_CREATE_DENIED");
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
      sidecar: {
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
    expect(result.sidecar?.executionControl).toEqual({
      action: "stop_session_family",
      reason: "goal_cancelled",
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
      expect(expectTextDraft(result)).toContain("GOAL_CONTEXT_REQUIRED");
      expect(expectTextDraft(result)).toContain(currentGoalId);
      expect(expectTextDraft(result)).toContain(targetGoalId);
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
    expect(expectTextDraft(result)).toContain("GOAL_MANAGE_ACTION_DENIED");
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
      result: testReviewExecutionFields("NOT_DONE").result,
    });

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("permission-denied");
    expect(expectTextDraft(result)).toContain("GOAL_REVIEWER_REQUIRED");
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
        result: testReviewExecutionFields("DONE").result,
      },
      { store: reviewStore(goalId) },
    );

    expect(result.isError).toBe(false);
    const completed = JSON.parse(expectTextDraft(result)) as GoalState;
    expect(completed.status).toBe("done");
    expect(completed.review).toMatchObject({
      verdict: "DONE",
      summary: "All acceptance criteria are verified.",
      reviewerSessionId: "review-session",
    });
    expect(goalState.calls).toHaveLength(1);
    expect(goalState.calls[0]).toMatchObject({ method: "finalizeReview" });
  });

  it("fails the first schema-invalid strict finalize_review with CHILD_RESULT_REQUIRED", async () => {
    const result = await executeGoalManageWithCorrection({
      action: "finalize_review",
      goalId: DEFAULT_GOAL_ID,
    }, reviewStore(DEFAULT_GOAL_ID), "strict");

    expect(JSON.parse(result.result.output.preview).code).toBe("CHILD_RESULT_REQUIRED");
    expect(result.sidecar?.executionControl).toMatchObject({
      action: "fail_execution",
      reason: "child_result_required",
    });
  });

  it("fails the first semantically invalid strict finalize_review with CHILD_RESULT_REQUIRED", async () => {
    const invalidResult = testReviewExecutionFields("DONE").result;
    invalidResult.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];

    const result = await executeGoalManageWithCorrection(
      finalizeReviewInput({ result: invalidResult }),
      reviewStore(DEFAULT_GOAL_ID),
      "strict",
    );

    expect(JSON.parse(result.result.output.preview).code).toBe("CHILD_RESULT_REQUIRED");
    expect(result.sidecar?.executionControl).toMatchObject({ action: "fail_execution" });
  });

  it("gives best-effort finalize_review one shared schema-to-semantic correction before failure", async () => {
    const store = reviewStore(DEFAULT_GOAL_ID);
    const gate = createStructuredResultCorrectionGate(
      "best_effort",
      0,
      "goal_manage.finalize_review",
    );
    const ctx = makeCtx({}, store, makeProjectContext());
    ctx.structuredResultCorrection = gate;
    const registry = createGoalManageRegistry();

    const schemaFailure = await registry.execute({
      toolName: TOOL_GOAL_MANAGE,
      toolCallId: "goal-review-schema-failure",
      input: { action: "finalize_review", goalId: DEFAULT_GOAL_ID },
    }, ctx);
    if (schemaFailure.kind !== "settled") throw new Error("Expected settled schema failure");
    expect(JSON.parse(schemaFailure.result.output.preview).code).toBe("STRUCTURED_RESULT_CORRECTION_REQUIRED");
    expect(schemaFailure.sidecar?.executionControl).toBeUndefined();

    const invalidResult = testReviewExecutionFields("DONE").result;
    invalidResult.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];
    const semanticFailure = await registry.execute({
      toolName: TOOL_GOAL_MANAGE,
      toolCallId: "goal-review-semantic-failure",
      input: finalizeReviewInput({ result: invalidResult }),
    }, ctx);
    if (semanticFailure.kind !== "settled") throw new Error("Expected settled semantic failure");
    expect(JSON.parse(semanticFailure.result.output.preview).code).toBe("CHILD_RESULT_REQUIRED");
    expect(semanticFailure.sidecar?.executionControl).toMatchObject({ action: "fail_execution" });
  });

  it("does not spend the finalize_review correction on another goal_manage action", async () => {
    const store = reviewStore(DEFAULT_GOAL_ID);
    const gate = createStructuredResultCorrectionGate(
      "best_effort",
      0,
      "goal_manage.finalize_review",
    );
    const ctx = makeCtx({}, store, makeProjectContext());
    ctx.structuredResultCorrection = gate;
    const registry = createGoalManageRegistry();

    const unrelated = await registry.execute({
      toolName: TOOL_GOAL_MANAGE,
      toolCallId: "invalid-begin-review",
      input: { action: "begin_review" },
    }, ctx);
    if (unrelated.kind !== "settled") throw new Error("Expected settled unrelated failure");
    expect(JSON.parse(unrelated.result.output.preview).code).not.toBe("STRUCTURED_RESULT_CORRECTION_REQUIRED");

    const firstFinalizeFailure = await registry.execute({
      toolName: TOOL_GOAL_MANAGE,
      toolCallId: "first-finalize-review",
      input: { action: "finalize_review", goalId: DEFAULT_GOAL_ID },
    }, ctx);
    if (firstFinalizeFailure.kind !== "settled") throw new Error("Expected settled finalize failure");
    expect(JSON.parse(firstFinalizeFailure.result.output.preview).code).toBe("STRUCTURED_RESULT_CORRECTION_REQUIRED");
  });

  it("rebuilds the finalize_review correction count from the durable current execution", async () => {
    const store = reviewStore(DEFAULT_GOAL_ID);
    const durableFailure = createStructuredResultCorrectionGate(
      "best_effort",
      0,
      "goal_manage.finalize_review",
    ).recordFailure(new Error("schema mismatch"));
    const now = new Date().toISOString();
    const batch: SessionToolBatch = {
      batchId: "goal-review-batch",
      executionId: "review-execution",
      step: 1,
      agentName: "reviewer",
      allowedTools: [TOOL_GOAL_MANAGE],
      agentSkills: [],
      partitions: [{ type: "serial", callIds: ["failed-finalize"] }],
      calls: [{
        ordinal: 0,
        partitionIndex: 0,
        toolCallId: "failed-finalize",
        toolName: TOOL_GOAL_MANAGE,
        input: { action: "finalize_review", goalId: DEFAULT_GOAL_ID },
        traits: { readOnly: false, destructive: false, concurrencySafe: false },
        state: "failed",
        attempt: 1,
        result: finalizedInlineResult(durableFailure),
      }],
      createdAt: now,
      updatedAt: now,
    };
    store.setState({ toolBatches: [batch] });

    const failures = countStructuredResultFailures(
      store.getState(),
      "goal_manage.finalize_review",
    );
    expect(failures).toBe(1);
    const recovered = await executeGoalManageWithCorrection(
      { action: "finalize_review", goalId: DEFAULT_GOAL_ID },
      store,
      "best_effort",
      failures,
    );
    expect(JSON.parse(recovered.result.output.preview).code).toBe("CHILD_RESULT_REQUIRED");
    expect(recovered.sidecar?.executionControl).toMatchObject({ action: "fail_execution" });
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
      result: testReviewExecutionFields("NOT_DONE").result,
    };

    for (const store of [
      reviewStore(goalId, { sessionRole: "main" }),
      reviewStore(otherGoalId),
      mainStore({ agentName: "build", sessionRole: "review", goalId }),
    ]) {
      const { result, goalState } = await execute(input, { store });
      expect(result.isError).toBe(true);
      expect(expectTextDraft(result)).toContain("GOAL_REVIEWER_REQUIRED");
      expect(goalState.calls).toEqual([]);
    }
  });
});
