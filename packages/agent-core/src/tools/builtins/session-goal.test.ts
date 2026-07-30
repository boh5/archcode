import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH } from "@archcode/protocol";
import { mkdir } from "node:fs/promises";

import { SessionGoalService } from "../../session-goal";
import { storeManager } from "../../store/store";
import { createTestTempRoot } from "../../testing/test-temp-root";
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
  const store = storeManager.create(sessionId, tempRoot.path, {
    agentName: options.discussion === true ? "discussion" : "lead",
    ...(options.discussion === true
      ? { projectTodo: { todoId: crypto.randomUUID(), entry: "discussion" as const } }
      : {}),
  });
  const projectContext = createTestProjectContext(tempRoot.path);
  return {
    store,
    storeManager,
    toolName: "create_goal",
    toolCallId: crypto.randomUUID(),
    input: {},
    step: 1,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
    abort: new AbortController().signal,
    agentName: store.getState().agentName,
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

function attachChild(
  ctx: ToolExecutionContext,
  status: "completed" | "running",
): string {
  const rootState = ctx.store.getState();
  const sessionId = crypto.randomUUID();
  const createdAt = Date.now();
  storeManager.create(sessionId, tempRoot.path, {
    agentName: "build",
    rootSessionId: rootState.sessionId,
    parentSessionId: rootState.sessionId,
    activeSkillNames: [],
    delegationRequest: {
      agent_type: "build",
      profile: "deep",
      title: "Implementation child",
      objective: "Implement a bounded part of the Goal.",
      skills: [],
      background: true,
    },
  });
  ctx.store.setState({
    childSessionLinks: [{
      parentSessionId: rootState.sessionId,
      parentToolCallId: crypto.randomUUID(),
      toolName: "delegate",
      childSessionId: sessionId,
      childExecutionId: crypto.randomUUID(),
      childAgentName: "build",
      childProfile: "deep",
      childSkillNames: [],
      title: "Implementation child",
      depth: 1,
      background: true,
      status,
      createdAt,
    }],
  });
  return sessionId;
}

describe("Session Goal model tools", () => {
  test("create_goal has the strict objective-only contract", () => {
    expect(CreateGoalInputSchema.safeParse({ objective: "Keep working until done." }).success).toBe(true);
    expect(CreateGoalInputSchema.safeParse({}).success).toBe(false);
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
    const goal = await ctx.sessionGoalService!.create({
      ...target,
      authority: { kind: "user_control" },
      objective: "Semantic objective must stay in GoalNotice.",
    });
    await ctx.sessionGoalService!.setTokenBudget({
      ...target,
      authority: { kind: "user_control" },
      tokenBudget: 100,
    });
    await ctx.sessionGoalService!.recordSettlement({
      ...target,
      authority: { kind: "runtime" },
      settlementKey: `terminal:${target.sessionId}:test`,
      goalInstanceId: goal.instanceId,
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        reasoningTokens: 2,
        cachedInputTokens: 1,
      },
      executionTimeMs: 25,
      terminal: true,
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
    const objective = "Keep working until every authentication test passes with a token budget of 5k / 预算 1 万.";
    const ctx = context();
    await createGoal(ctx, objective);
    const goal = await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    });
    expect(goal?.objective).toBe(objective);
    expect(goal?.tokenBudget).toBeUndefined();
  });

  test("Discussion cannot create a Goal", async () => {
    const objective = "Keep working until every test passes.";
    const ctx = context({ discussion: true });
    const result = await createGoalTool.execute({ objective }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("requires the current root Lead Session");
  });

  test("update_goal schema retains only complete and blocked Agent transitions", () => {
    expect(UpdateGoalInputSchema.safeParse({ status: "complete", reason: "Verified complete" }).success).toBe(true);
    expect(UpdateGoalInputSchema.safeParse({ status: "blocked", reason: "Needs user input" }).success).toBe(true);
    expect(UpdateGoalInputSchema.safeParse({ status: "pause" }).success).toBe(false);
  });

  test("completes the current Goal after all family children are terminal", async () => {
    const objective = "Keep working until every migration test passes.";
    const ctx = context();
    await createGoal(ctx, objective);
    attachChild(ctx, "completed");

    const result = await updateGoalTool.execute({
      status: "complete",
      reason: "Implementation and verification are complete.",
    }, ctx);

    expect(result.isError).toBe(false);
    expect((await ctx.sessionGoalService!.get({ workspaceRoot: tempRoot.path, sessionId: ctx.store.getState().sessionId }))?.status).toBe("complete");
  });

  test("rejects completion when the captured Goal is replaced before the durable completion mutation", async () => {
    const objective = "Keep working until the Goal completion race is verifiably closed.";
    const ctx = context();
    await createGoal(ctx, objective);
    const capturedGoal = ctx.store.getState().goal!;

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
      reason: "The stale request must not complete a replacement Goal.",
    }, ctx);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Expected Goal");
    const current = await ctx.sessionGoalService.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    });
    expect(current).toMatchObject({ status: "active", generation: 1 });
    expect(current?.instanceId).not.toBe(capturedGoal.instanceId);
  });

  test("rejects completion while any family child is active", async () => {
    const ctx = context();
    await createGoal(ctx);
    attachChild(ctx, "running");

    const result = await updateGoalTool.execute({
      status: "complete",
      reason: "Implementation is complete.",
    }, ctx);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("every child");
  });
});
