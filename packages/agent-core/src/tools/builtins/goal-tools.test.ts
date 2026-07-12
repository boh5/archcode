import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";

import { TOOL_GOAL_CREATE, TOOL_GOAL_MANAGE, type GoalBlockerKind, type GoalReviewReceipt, type GoalState } from "@archcode/protocol";
import { GoalStateManager } from "../../goals/state";
import { GoalCancellationCleanupError } from "../../goals/cancellation";
import { WorktreeService } from "../../worktrees";
import { HitlService } from "../../hitl/service";
import { createPreparedHitlResume, ResumeCoordinator } from "../../hitl/resume-coordinator";
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
import { GoalCreateInputSchema, GoalManageInputSchema, goalCreateTool, goalManageTool } from "./goal-tools";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-tools");
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
    projectId: string;
    objective: string;
    acceptanceCriteria: string;
    useWorktree?: boolean;
  }): Promise<GoalState> {
    this.calls.push({ method: "create", payload: input });
    return makeGoalState({
      projectId: input.projectId,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      useWorktree: input.useWorktree,
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
    source?: string;
    resumeStatus: "running" | "reviewing";
  }): Promise<GoalState> {
    this.calls.push({ method: "block", payload: { goalId, blocker } });
    return makeGoalState({
      id: goalId,
      status: "blocked",
      blocker: { ...blocker, createdAt: "2026-07-08T00:00:00.000Z" },
      pendingHitlIds: [],
    });
  }

  async clearBlocker(goalId: string, hitlId?: string): Promise<GoalState> {
    this.calls.push({ method: "clearBlocker", payload: { goalId, hitlId } });
    return makeGoalState({ id: goalId, status: "running" });
  }

  async beginReview(goalId: string): Promise<GoalState> {
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
  onGoalCreated?: (goal: GoalState) => void,
): ProjectContext {
  const project = {
    slug: "test-project",
    name: "Test Project",
    workspaceRoot,
    addedAt: new Date().toISOString(),
  };
  const resolvedGoalState = goalState as unknown as GoalStateManager;
  const loopState = new LoopStateManager(workspaceRoot);
  const hitl = new HitlService({ workspaceRoot, project, sessions: storeManager, goalState: resolvedGoalState, loopState });
  return {
    project,
    goalState: resolvedGoalState,
    goalCancellation: {
      cancel: (goalId, request) => goalState.cancel(goalId, request.reason),
    },
    loopState,
    hitl,
    hitlResumeCoordinator: new ResumeCoordinator({
      hitl,
      adapters: {
        session: { prepare: async () => createPreparedHitlResume(async () => undefined) },
        goal: { prepare: async () => createPreparedHitlResume(async () => undefined) },
        loop: { prepare: async () => createPreparedHitlResume(async () => undefined) },
      },
      logger: silentLogger,
    }),
    memory: new MemoryFileManager({
      project: join(workspaceRoot, ".archcode", "memory"),
      user: join(workspaceRoot, ".archcode", "user-memory"),
    }),
    approvals: new ProjectApprovalManager(silentLogger),
    ...(onGoalCreated === undefined ? {} : { onGoalCreated }),
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
    onGoalCreated?: (goal: GoalState) => void;
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

  const projectContext = makeProjectContext(goalState, TMP_DIR, options.onGoalCreated);
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
    projectId: "test-project",
    title: null,
    objective: "Simplify Goal tools.",
    acceptanceCriteria: "The simplified lifecycle is enforced.",
    status: "draft",
    attempt: 1,
    reviewGeneration: 0,
    mainSessionId: "main-session",
    pendingHitlIds: [],
    approvalRefs: [],
    appliedHitlIds: [],
    childSessionIds: [],
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
    version: overrides.version ?? 2,
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

async function initializeGitRepo(cwd: string): Promise<{ readonly firstSha: string; readonly baseSha: string }> {
  await mkdir(cwd, { recursive: true });
  await runGit(cwd, ["init", "--initial-branch=main"]);
  await runGit(cwd, ["config", "user.email", "goal-tool@example.com"]);
  await runGit(cwd, ["config", "user.name", "Goal Tool Test"]);
  await writeFile(join(cwd, "README.md"), "# Goal tool claim\n");
  await runGit(cwd, ["add", "README.md"]);
  await runGit(cwd, ["commit", "-m", "initial commit"]);
  const firstSha = await runGit(cwd, ["rev-parse", "HEAD"]);
  await writeFile(join(cwd, "base.txt"), "Goal creation base\n");
  await runGit(cwd, ["add", "base.txt"]);
  await runGit(cwd, ["commit", "-m", "Goal creation base"]);
  return { firstSha, baseSha: await runGit(cwd, ["rev-parse", "HEAD"]) };
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

describe("goal_manage builtin tool", () => {
  it("exposes separate draft creation and managed lifecycle descriptors", () => {
    expect(goalCreateTool.name).toBe(TOOL_GOAL_CREATE);
    expect(goalCreateTool.description).toContain("draft Goal");
    expect(goalManageTool.name).toBe(TOOL_GOAL_MANAGE);
    expect(goalManageTool.description).toContain("block, resume, begin_review, finalize_review, retry, or cancel");
  });

  it("accepts draft input separately and rejects create/start in managed lifecycle", () => {
    const goalId = "11111111-1111-4111-8111-111111111111";
    const validCases = [
      { action: "block", goalId, kind: "approval", summary: "Waiting on approval", source: "test", resumeStatus: "running" },
      { action: "resume", goalId, hitlId: "hitl-1" },
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

    expect(GoalManageInputSchema.safeParse({ action: "create", objective: "Do the thing", acceptanceCriteria: "It works" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "start", goalId }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "lock", goalId }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "advance_phase", goalId, nextPhase: "build" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "begin_review", goalId, reviewerSessionId: "unused" }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({
      action: "block",
      goalId,
      kind: "approval",
      summary: "Waiting on approval",
      hitlId: "hitl-1",
      resumeStatus: "running",
    }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "finalize_review", goalId, outcome: "DONE", summary: "Verified", evidenceRefs: [validEvidenceRef()] }).success).toBe(false);
    expect(GoalManageInputSchema.safeParse({ action: "finalize_review", goalId, verdict: "DONE", summary: "Verified", evidenceRefs: [] }).success).toBe(false);
  });

  it("dispatches block/resume/begin_review/retry/cancel to the simplified manager", async () => {
    const goalId = DEFAULT_GOAL_ID;
    const goalState = new SimplifiedGoalStateManagerMock();
    const inputs = [
      { action: "block", goalId, kind: "permission", summary: "Need permission", source: "tool", resumeStatus: "reviewing" },
      { action: "resume", goalId, hitlId: "hitl-1" },
      { action: "begin_review", goalId },
      { action: "retry", goalId },
      { action: "cancel", goalId, reason: "Stopped" },
    ];

    for (const input of inputs) {
      const { result } = await execute(input, { goalState });
      expect(result.isError).toBe(false);
    }

    expect(goalState.calls.map((call) => call.method)).toEqual([
      "block",
      "clearBlocker",
      "beginReview",
      "retry",
      "cancel",
    ]);
    expect(goalState.calls[0]?.payload).toEqual({
      goalId,
      blocker: {
        kind: "permission",
        summary: "Need permission",
        source: "tool",
        resumeStatus: "reviewing",
      },
    });
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
      const draft = await manager.create({
        projectId: "test-project",
        objective: "Exercise not_done phase capabilities.",
        acceptanceCriteria: "Only retry and cancel remain executable.",
        mainSessionId: "main-session",
      });
      await manager.start(draft.id);
      const reviewing = await manager.beginReview(draft.id);
      return await manager.finalizeReview(draft.id, {
        expectedReviewGeneration: reviewing.reviewGeneration,
        verdict: "NOT_DONE",
        summary: "More work remains.",
        authorization: {
          agentName: "reviewer",
          sessionRole: "review",
          sessionGoalId: draft.id,
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
    for (const input of [
      { action: "block", goalId: notDone.id, kind: "question", summary: "invalid", resumeStatus: "running" },
      { action: "resume", goalId: notDone.id },
      { action: "begin_review", goalId: notDone.id },
    ]) {
      expect((await executeManaged(input, notDone.id)).isError).toBe(true);
    }
    expect((await executeManaged({ action: "retry", goalId: notDone.id }, notDone.id)).isError).toBe(false);

    const cancellable = await createNotDone();
    expect((await executeManaged({ action: "cancel", goalId: cancellable.id }, cancellable.id)).isError).toBe(false);
  });

  it("creates a draft Goal only from an unbound Engineer root Session", async () => {
    const goalState = new SimplifiedGoalStateManagerMock();
    const createdGoals: GoalState[] = [];
    const input = { objective: "Do the thing", acceptanceCriteria: "It works", useWorktree: true };
    const { result } = await executeCreate(input, { goalState, onGoalCreated: (goal) => createdGoals.push(goal) });

    expect(result.isError).toBe(false);
    expect(goalState.calls).toEqual([{ method: "create", payload: {
      projectId: "test-project",
      objective: "Do the thing",
      acceptanceCriteria: "It works",
      useWorktree: true,
    } }]);
    expect(createdGoals).toHaveLength(1);
    expect(createdGoals[0]).toMatchObject({ projectId: "test-project", status: "draft" });

    for (const store of [
      mainStore({ goalId: undefined }),
      engineerStore({ goalId: DEFAULT_GOAL_ID }),
      engineerStore({ loopId: "22222222-2222-4222-8222-222222222222" }),
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
      { action: "block", goalId: targetGoalId, kind: "approval", summary: "Wait", resumeStatus: "running" },
      { action: "resume", goalId: targetGoalId },
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

  it("validates the persisted Goal branch claim before lifecycle actions", async () => {
    const goalId = crypto.randomUUID();
    const workspaceRoot = join(TMP_DIR, `claim-${crypto.randomUUID()}`);
    const { firstSha } = await initializeGitRepo(workspaceRoot);
    const created = await new WorktreeService({ canonicalRoot: workspaceRoot }).create({
      owner: { type: "goal", id: goalId },
    });
    const isolated = makeGoalState({
      id: goalId,
      useWorktree: true,
      worktree: {
        path: created.worktreePath,
        branchName: created.branchName,
        baseSha: created.baseSha,
        createdAt: "2026-07-08T00:00:00.000Z",
      },
    });
    const manager = new SimplifiedGoalStateManagerMock(isolated);
    const context = makeProjectContext(manager, workspaceRoot);

    await writeFile(join(created.worktreePath, "descendant.txt"), "committed descendant\n");
    await runGit(created.worktreePath, ["add", "descendant.txt"]);
    await runGit(created.worktreePath, ["commit", "-m", "Goal descendant"]);
    await writeFile(join(created.worktreePath, "dirty.txt"), "in-progress review state\n");
    const finalizeInput = {
      action: "finalize_review",
      goalId,
      expectedReviewGeneration: 1,
      verdict: "DONE",
      summary: "Validated descendant work.",
      evidenceRefs: [validEvidenceRef()],
    } as const;

    const allowed = normalizeOutput(await goalManageTool.execute(
      finalizeInput,
      makeCtx(finalizeInput, reviewStore(goalId), context, created.worktreePath),
    ));
    expect(allowed.isError).toBe(false);
    expect(manager.calls.map((call) => call.method)).toEqual(["finalizeReview"]);

    await runGit(created.worktreePath, ["switch", "-c", "foreign-review-branch"]);
    const wrongBranch = normalizeOutput(await goalManageTool.execute(
      finalizeInput,
      makeCtx(finalizeInput, reviewStore(goalId), context, created.worktreePath),
    ));
    expect(wrongBranch.isError).toBe(true);
    expect(wrongBranch.output).toContain("GOAL_WORKTREE_CHANGED");
    expect(manager.calls.map((call) => call.method)).toEqual(["finalizeReview"]);

    await runGit(created.worktreePath, ["switch", created.branchName]);
    await runGit(created.worktreePath, ["reset", "--hard", firstSha]);
    const beginReviewInput = { action: "begin_review", goalId } as const;
    const resetBehind = normalizeOutput(await goalManageTool.execute(
      beginReviewInput,
      makeCtx(beginReviewInput, mainStore({ goalId }), context, created.worktreePath),
    ));
    expect(resetBehind.isError).toBe(true);
    expect(resetBehind.output).toContain("GOAL_WORKTREE_CHANGED");
    expect(manager.calls.map((call) => call.method)).toEqual(["finalizeReview"]);
  });

  it("denies lifecycle actions for Reviewer sessions", async () => {
    const goalId = "11111111-1111-4111-8111-111111111111";

    const { result, goalState } = await execute(
      { action: "block", goalId, kind: "approval", summary: "Wait", resumeStatus: "running" },
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
