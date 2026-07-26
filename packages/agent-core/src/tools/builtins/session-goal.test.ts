import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH } from "@archcode/protocol";
import { mkdir } from "node:fs/promises";

import { SessionGoalService } from "../../session-goal";
import { storeManager } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import { createTestTempRoot } from "../../testing/test-temp-root";
import { testExecutionRecord } from "../../testing/test-execution-fixtures";
import { createTestProjectContext } from "../test-project-context";
import type { ToolExecutionContext } from "../types";
import {
  CreateGoalInputSchema,
  UpdateGoalInputSchema,
  createGoalTool,
  getGoalTool,
  updateGoalTool,
} from "./session-goal";

const tempRoot = createTestTempRoot("session-goal-tools");

beforeAll(async () => {
  await mkdir(tempRoot.path, { recursive: true });
});

afterAll(async () => {
  storeManager.clearAll();
  await tempRoot.cleanup();
});

function context(options: { readonly discussion?: boolean } = {}): ToolExecutionContext {
  const sessionId = crypto.randomUUID();
  const store = storeManager.create(sessionId, tempRoot.path, { agentName: "lead" });
  const projectContext = createTestProjectContext(tempRoot.path);
  if (options.discussion === true) {
    projectContext.todos.state.findByDiscussionSessionId = async () => ({ id: "discussion" }) as never;
  }
  return {
    store,
    storeManager,
    toolName: "create_goal",
    toolCallId: crypto.randomUUID(),
    input: {},
    step: 1,
    abort: new AbortController().signal,
    agentName: "lead",
    startedAt: Date.now(),
    allowedTools: new Set(["create_goal", "get_goal", "update_goal"]),
    projectContext,
    sessionGoalService: new SessionGoalService(storeManager),
    cwd: tempRoot.path,
  };
}

function text(result: Awaited<ReturnType<typeof createGoalTool.execute>>): string {
  if (result.draft.kind !== "text") throw new Error(`Expected text result, got ${result.draft.kind}`);
  return result.draft.text;
}

async function createGoal(ctx: ToolExecutionContext, objective = "Keep working until every migration test passes."): Promise<void> {
  const result = await createGoalTool.execute({ objective }, ctx);
  expect(result.isError).toBe(false);
}

function attachGoalReview(
  ctx: ToolExecutionContext,
  options: {
    readonly outputs?: readonly string[];
    readonly profile?: "deep" | "fast";
    readonly skills?: readonly string[];
    readonly bindingGenerationDelta?: number;
  } = {},
): string {
  const rootState = ctx.store.getState();
  const goal = rootState.goal!;
  const profile = options.profile ?? "deep";
  const skills = [...(options.skills ?? ["goal-review"])];
  const sessionId = crypto.randomUUID();
  const createdAt = Math.max(Date.now(), goal.updatedAt) + 1;
  const reviewStore = storeManager.create(sessionId, tempRoot.path, {
    agentName: "analyst",
    rootSessionId: rootState.sessionId,
    parentSessionId: rootState.sessionId,
    activeSkillNames: skills,
    delegationRequest: {
      agent_type: "analyst",
      profile,
      title: "Independent Goal review",
      objective: "Review the current Goal independently.",
      skills,
      background: true,
    },
  });
  const outputs = options.outputs ?? ["\nVERDICT: APPROVED\n\nAll acceptance criteria pass."];
  const executions = outputs.map(() => testExecutionRecord(crypto.randomUUID(), "completed"));
  (reviewStore.setState as (patch: object) => void)({
    goalReviewBinding: {
      goalInstanceId: goal.instanceId,
      goalGeneration: goal.generation + (options.bindingGenerationDelta ?? 0),
      rootSessionId: rootState.sessionId,
      createdAt,
    },
    executions,
    messages: outputs.map((output, index) => {
      const messageId = crypto.randomUUID();
      return {
        id: messageId,
        role: "assistant" as const,
        parts: [{ type: "text" as const, id: `${messageId}:text`, text: output, createdAt, completedAt: createdAt + 1 }],
        createdAt,
        completedAt: createdAt + 1,
        executionId: executions[index]!.id,
      };
    }),
  });
  ctx.store.setState({
    childSessionLinks: [{
      parentSessionId: rootState.sessionId,
      parentToolCallId: crypto.randomUUID(),
      toolName: "delegate",
      childSessionId: sessionId,
      childAgentName: "analyst",
      childProfile: profile,
      childSkillNames: skills,
      title: "Independent Goal review",
      depth: 1,
      background: true,
      status: "completed",
      createdAt,
    }],
  });
  return sessionId;
}

function appendCompletedTool(
  ctx: ToolExecutionContext,
  endedAt: number,
  toolName: string,
  input: unknown,
): void {
  const messageId = crypto.randomUUID();
  ctx.store.setState({
    messages: [...ctx.store.getState().messages, {
      id: messageId,
      role: "assistant",
      parts: [{
        type: "tool",
        state: "completed",
        id: `${messageId}:tool`,
        toolCallId: `${messageId}:call`,
        toolName,
        input,
        result: {
          isError: false,
          output: {
            preview: "done",
            completeness: "complete",
            observed: { bytes: 4, lines: 1 },
            canonical: { bytes: 4, lines: 1 },
            stored: { bytes: 4, lines: 1 },
            omitted: { bytes: 0, lines: 0 },
            recovery: { kind: "none" },
          },
        },
        createdAt: endedAt - 1,
        startedAt: endedAt - 1,
        endedAt,
      }],
      createdAt: endedAt - 1,
      completedAt: endedAt,
    }],
  });
}

describe("Session Goal model tools", () => {
  test("create_goal has the strict objective-only contract", () => {
    expect(CreateGoalInputSchema.safeParse({ objective: "Keep working until done." }).success).toBe(true);
    expect(CreateGoalInputSchema.safeParse({}).success).toBe(false);
    expect(CreateGoalInputSchema.safeParse({ objective: "Goal", token_budget: 20_000 }).success).toBe(false);
  });

  test("create_goal returns only a receipt and blocked reason uses the shared bound", async () => {
    const objective = "Keep working until the receipt contract is verified.";
    const ctx = context();
    const result = await createGoalTool.execute({ objective }, ctx);
    expect(result.isError).toBe(false);
    const receipt = JSON.parse(text(result)) as Record<string, unknown>;
    expect(receipt).toEqual({
      status: "created",
      instanceId: expect.any(String),
      generation: 1,
    });
    expect(JSON.stringify(receipt)).not.toContain(objective);

    expect(UpdateGoalInputSchema.safeParse({
      status: "blocked",
      reason: "x".repeat(SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH),
    }).success).toBe(true);
    expect(UpdateGoalInputSchema.safeParse({
      status: "blocked",
      reason: "x".repeat(SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH + 1),
    }).success).toBe(false);
  });

  test("get_goal returns accounting only and never duplicates GoalNotice semantics", async () => {
    const ctx = context();
    const target = {
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    };
    await ctx.sessionGoalService!.create({
      ...target,
      authority: { kind: "user_control" },
      objective: "Semantic objective must stay in GoalNotice.",
      tokenBudget: 100,
    });
    await ctx.sessionGoalService!.recordUsage({
      ...target,
      authority: { kind: "runtime" },
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        reasoningTokens: 2,
        cachedInputTokens: 1,
      },
      executionTimeMs: 25,
    });
    await ctx.sessionGoalService!.block({
      ...target,
      authority: { kind: "agent" },
      reason: "Semantic blocker must stay in GoalNotice.",
    });

    const result = await getGoalTool.execute({}, ctx);
    expect(result.isError).toBe(false);
    const accounting = JSON.parse(text(result)) as Record<string, unknown>;
    expect(accounting).toEqual({
      tokenBudget: 100,
      usage: {
        tokens: {
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
          reasoningTokens: 2,
          cachedInputTokens: 1,
        },
        executionTimeMs: 25,
        executionCount: 1,
      },
    });
    const serialized = JSON.stringify(accounting);
    expect(serialized).not.toContain("Semantic objective");
    expect(serialized).not.toContain("Semantic blocker");
    expect(accounting.objective).toBeUndefined();
    expect(accounting.status).toBeUndefined();
    expect(accounting.blockedReason).toBeUndefined();
    expect(accounting.instanceId).toBeUndefined();
    expect(accounting.generation).toBeUndefined();
  });

  test("creates the objective supplied by the Lead", async () => {
    const objective = "Keep working until every authentication test passes.";
    const ctx = context();
    await createGoal(ctx, objective);
    expect((await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    }))?.objective).toBe(objective);
  });

  test("Discussion Lead cannot create a Goal", async () => {
    const objective = "Keep working until every test passes.";
    const ctx = context({ discussion: true });
    const result = await createGoalTool.execute({ objective }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Discussion");
  });

  test("update_goal schema retains only complete and blocked Agent transitions", () => {
    expect(UpdateGoalInputSchema.safeParse({ status: "complete", reason: "Approved", review_session_id: "review" }).success).toBe(true);
    expect(UpdateGoalInputSchema.safeParse({ status: "blocked", reason: "Needs user input" }).success).toBe(true);
    expect(UpdateGoalInputSchema.safeParse({ status: "pause" }).success).toBe(false);
  });

  test("completes only with fresh direct deep Analyst goal-review provenance", async () => {
    const objective = "Keep working until every migration test passes.";
    const ctx = context();
    await createGoal(ctx, objective);
    const reviewSessionId = attachGoalReview(ctx);

    const result = await updateGoalTool.execute({
      status: "complete",
      reason: "Implementation and verification are complete.",
      review_session_id: reviewSessionId,
    }, ctx);

    expect(result.isError).toBe(false);
    expect((await ctx.sessionGoalService!.get({ workspaceRoot: tempRoot.path, sessionId: ctx.store.getState().sessionId }))?.status).toBe("complete");
  });

  test("rejects completion when the reviewed Goal is replaced before the durable completion mutation", async () => {
    const objective = "Keep working until the Goal completion race is verifiably closed.";
    const ctx = context();
    await createGoal(ctx, objective);
    const reviewedGoal = ctx.store.getState().goal!;
    const reviewSessionId = attachGoalReview(ctx);

    class ReplaceGoalBeforeCompleteService extends SessionGoalService {
      override async complete(input: Parameters<SessionGoalService["complete"]>[0]) {
        await this.clear({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.sessionId,
          authority: { kind: "user_control" },
        });
        await this.create({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.sessionId,
          authority: { kind: "user_control" },
          objective: "Replacement Goal created during the controlled race.",
        });
        return await super.complete(input);
      }
    }
    ctx.sessionGoalService = new ReplaceGoalBeforeCompleteService(storeManager);

    const result = await updateGoalTool.execute({
      status: "complete",
      reason: "The stale review must not complete a replacement Goal.",
      review_session_id: reviewSessionId,
    }, ctx);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Expected Goal");
    const current = await ctx.sessionGoalService.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    });
    expect(current).toMatchObject({ status: "active", generation: 1 });
    expect(current?.instanceId).not.toBe(reviewedGoal.instanceId);
  });

  test("rejects wrong profile, missing skill, stale generation, and non-approved verdict", async () => {
    const cases = [
      { name: "fast", review: { profile: "fast" as const } },
      { name: "missing skill", review: { skills: ["review-change"] } },
      { name: "wrong generation", review: { bindingGenerationDelta: 1 } },
      { name: "changes requested", review: { outputs: ["VERDICT: CHANGES_REQUESTED\nMissing evidence."] } },
      { name: "empty", review: { outputs: [""] } },
    ];
    for (const candidate of cases) {
      const objective = `Keep working until ${candidate.name} is verifiably complete.`;
      const ctx = context();
      await createGoal(ctx, objective);
      const reviewSessionId = attachGoalReview(ctx, candidate.review);
      const result = await updateGoalTool.execute({ status: "complete", reason: candidate.name, review_session_id: reviewSessionId }, ctx);
      expect(result.isError, candidate.name).toBe(true);
    }
  });

  test("a completed review attempt is terminal and cannot be rewritten by resume", async () => {
    const objective = "Keep working until the migration is verifiably complete.";
    const ctx = context();
    await createGoal(ctx, objective);
    const reviewSessionId = attachGoalReview(ctx, {
      outputs: ["VERDICT: CHANGES_REQUESTED", "VERDICT: APPROVED"],
    });
    const result = await updateGoalTool.execute({ status: "complete", reason: "rewritten", review_session_id: reviewSessionId }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("terminal");
  });

  test("known artifact writes after review creation make approval stale", async () => {
    const objective = "Keep working until the migration is verifiably complete.";
    const ctx = context();
    await createGoal(ctx, objective);
    const reviewSessionId = attachGoalReview(ctx);
    const binding = (storeManager.get(reviewSessionId, tempRoot.path)!.getState() as SessionStoreState & {
      goalReviewBinding: { createdAt: number };
    }).goalReviewBinding;
    appendCompletedTool(ctx, binding.createdAt + 2, "file_edit", { path: "src/app.ts", edits: [] });

    const result = await updateGoalTool.execute({ status: "complete", reason: "stale", review_session_id: reviewSessionId }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("stale");
  });

  test("only Bash writes inside the workspace invalidate a review", async () => {
    const objective = "Keep working until Bash freshness is verifiably complete.";
    const outside = context();
    await createGoal(outside, objective);
    const outsideReviewId = attachGoalReview(outside);
    const outsideBinding = (storeManager.get(outsideReviewId, tempRoot.path)!.getState() as SessionStoreState & {
      goalReviewBinding: { createdAt: number };
    }).goalReviewBinding;
    appendCompletedTool(outside, outsideBinding.createdAt + 2, "bash", {
      description: "Write disposable output",
      command: `printf x > /tmp/archcode-goal-review-${crypto.randomUUID()}`,
    });
    expect((await updateGoalTool.execute({
      status: "complete",
      reason: "Outside write does not change the artifact.",
      review_session_id: outsideReviewId,
    }, outside)).isError).toBe(false);

    const inside = context();
    await createGoal(inside, objective);
    const insideReviewId = attachGoalReview(inside);
    const insideBinding = (storeManager.get(insideReviewId, tempRoot.path)!.getState() as SessionStoreState & {
      goalReviewBinding: { createdAt: number };
    }).goalReviewBinding;
    appendCompletedTool(inside, insideBinding.createdAt + 2, "bash", {
      description: "Write workspace artifact",
      command: "printf x > generated.txt",
    });
    expect((await updateGoalTool.execute({
      status: "complete",
      reason: "Workspace changed.",
      review_session_id: insideReviewId,
    }, inside)).isError).toBe(true);
  });
});
