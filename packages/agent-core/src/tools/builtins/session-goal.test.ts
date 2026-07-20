import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";

import { SessionGoalService } from "../../session-goal";
import { storeManager } from "../../store/store";
import { createTestTempRoot } from "../../testing/test-temp-root";
import type { ToolExecutionContext } from "../types";
import { CreateGoalInputSchema, UpdateGoalInputSchema, createGoalTool, getGoalTool, updateGoalTool } from "./session-goal";

const tempRoot = createTestTempRoot("session-goal-tools");

beforeAll(async () => {
  await mkdir(tempRoot.path, { recursive: true });
});

afterAll(async () => {
  storeManager.clearAll();
  await tempRoot.cleanup();
});

function context(options: {
  sessionId?: string;
  parentSessionId?: string;
  agentName?: "engineer" | "reviewer";
  consumeFreshUserInput?: ToolExecutionContext["consumeFreshUserInput"];
} = {}): ToolExecutionContext {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const parentSessionId = options.parentSessionId;
  const rootSessionId = parentSessionId ?? sessionId;
  if (parentSessionId !== undefined && storeManager.get(parentSessionId, tempRoot.path) === undefined) {
    storeManager.create(parentSessionId, tempRoot.path, { agentName: "engineer" });
  }
  const store = storeManager.create(sessionId, tempRoot.path, {
    agentName: options.agentName ?? "engineer",
    rootSessionId,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
  });
  return {
    store,
    storeManager,
    toolName: "test",
    toolCallId: crypto.randomUUID(),
    input: {},
    step: 1,
    abort: new AbortController().signal,
    agentName: options.agentName ?? "engineer",
    startedAt: Date.now(),
    allowedTools: new Set(["create_goal", "get_goal", "update_goal"]),
    projectContext: {
      project: {
        slug: "test",
        name: "test",
        workspaceRoot: tempRoot.path,
        addedAt: new Date().toISOString(),
      },
    } as ToolExecutionContext["projectContext"],
    sessionGoalService: new SessionGoalService(storeManager),
    cwd: tempRoot.path,
    ...(options.consumeFreshUserInput === undefined ? {} : {
      consumeFreshUserInput: async (input) => {
        const grant = await options.consumeFreshUserInput!(input);
        input.validate?.(grant);
        return grant;
      },
    }),
  };
}

function text(result: Awaited<ReturnType<typeof createGoalTool.execute>>): string {
  if (result.draft.kind !== "text") throw new Error(`Expected text result, got ${result.draft.kind}`);
  return result.draft.text;
}

describe("Session Goal model tools", () => {
  test("create_goal exposes the conversational activation boundary without a Skill ceremony", () => {
    expect(createGoalTool.description).toContain("keep working through multiple rounds or delegated work until a verifiable outcome");
    expect(createGoalTool.description).toContain("one-step change, question, status request, diagnosis, or one-time research report");
    expect(createGoalTool.description).toContain("Runtime uses the fresh user input itself as the entire objective");
    expect(createGoalTool.description).toContain("cannot rewrite it");
    expect(createGoalTool.description).toContain("no budget means no hard cap");
  });

  test("create_goal consumes opaque fresh-user authority and persists on the root Session", async () => {
    const consumed: unknown[] = [];
    const rawUserRequest = "Finish the migration without using any and make every authentication test pass, with a token budget of 50,000.";
    const ctx = context({ consumeFreshUserInput: (input) => {
      consumed.push(input);
      return { text: rawUserRequest };
    } });

    const result = await createGoalTool.execute({}, ctx);

    expect(result.isError).toBe(false);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
      rootSessionId: ctx.store.getState().rootSessionId,
      toolCallId: ctx.toolCallId,
      action: "create",
    });
    expect((consumed[0] as { validate?: unknown }).validate).toBeInstanceOf(Function);
    const goal = await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    });
    expect(goal).toMatchObject({ status: "active", generation: 1, tokenBudget: 50_000 });
    expect(goal?.objective).toBe(rawUserRequest);
    expect(text(result)).toContain("authentication test pass");
  });

  test("create_goal schema rejects a model-invented budget and a budgetless request has no hard cap", async () => {
    const rawUserRequest = "Keep working until the migration passes every authentication test.";
    expect(CreateGoalInputSchema.safeParse({ token_budget: 20_000 }).success).toBe(false);
    const ctx = context({
      consumeFreshUserInput: () => ({ text: rawUserRequest }),
    });

    const result = await createGoalTool.execute({}, ctx);

    expect(result.isError).toBe(false);
    const goal = await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    });
    expect(goal).not.toHaveProperty("tokenBudget");
    expect(goal?.objective).toBe(rawUserRequest);
  });

  test("create_goal derives the exact token budget explicitly stated by the user", async () => {
    const allowed = context({
      consumeFreshUserInput: () => ({ text: "Continue until complete with a 20k token budget." }),
    });
    const accepted = await createGoalTool.execute({}, allowed);
    expect(accepted.isError).toBe(false);
    expect(await allowed.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: allowed.store.getState().sessionId,
    })).toMatchObject({ tokenBudget: 20_000 });

  });

  test("create_goal does not mistake unrelated nearby numbers for the token budget", async () => {
    const ctx = context({
      consumeFreshUserInput: () => ({ text: "Fix all 20 failing tests and keep working with a token budget of 50,000." }),
    });

    const result = await createGoalTool.execute({}, ctx);

    expect(result.isError).toBe(false);
    expect(await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    })).toMatchObject({ tokenBudget: 50_000 });
  });

  test("create_goal rejects missing capability and all non-root Agents", async () => {
    const noCapability = context();
    const missing = await createGoalTool.execute({}, noCapability);
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("fresh direct, queue, or steer");

    let consumed = false;
    const child = context({
      parentSessionId: crypto.randomUUID(),
      agentName: "reviewer",
      consumeFreshUserInput: () => { consumed = true; return { text: "keep working" }; },
    });
    const denied = await createGoalTool.execute({}, child);
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("root Engineer Session");
    expect(consumed).toBe(false);
  });

  test("update_goal edits through fresh authority and increments generation", async () => {
    const actions: string[] = [];
    const ctx = context({ consumeFreshUserInput: ({ action }) => {
      actions.push(action);
      return { text: action === "create" ? "Finish migration and pass tests." : "Also preserve behavior." };
    } });
    await createGoalTool.execute({}, ctx);

    const edited = await updateGoalTool.execute({
      action: "edit",
      expected_generation: 1,
      mode: "amend",
    }, ctx);

    expect(edited.isError).toBe(false);
    expect(actions).toEqual(["create", "edit"]);
    const read = await getGoalTool.execute({}, ctx);
    expect(JSON.parse(text(read))).toMatchObject({
      generation: 2,
      objective: expect.stringContaining("Also preserve behavior."),
    });
  });

  test("complete is only a Runtime review request and never writes complete", async () => {
    const ctx = context({ consumeFreshUserInput: () => ({ text: "Finish migration and pass tests." }) });
    await createGoalTool.execute({}, ctx);

    const claim = await updateGoalTool.execute({ status: "complete", reason: "Implementation and tests are ready." }, ctx);

    expect(claim.isError).toBe(false);
    expect(claim.sidecar?.executionControl).toEqual({
      action: "request_goal_review",
      reason: "Implementation and tests are ready.",
    });
    const goal = await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    });
    expect(goal?.status).toBe("active");
    expect(goal?.review).toBeUndefined();
  });

  test("create_goal retains an omitted user constraint in the persisted and Reviewer objective", async () => {
    const rawUserRequest = "Migrate authentication, do not use any, and keep working until every authentication test passes.";
    const ctx = context({ consumeFreshUserInput: () => ({ text: rawUserRequest }) });

    const result = await createGoalTool.execute({}, ctx);

    expect(result.isError).toBe(false);
    const goal = await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    });
    expect(goal?.objective).toBe(rawUserRequest);
    const { buildGoalReviewContract } = await import("../../session-goal/review-gate");
    expect(buildGoalReviewContract(goal!.objective).objective).toContain("do not use any");
  });

  test("fresh user objectives at 3900 and 4000 characters remain valid", async () => {
    const ctx = context({ consumeFreshUserInput: () => ({ text: "u".repeat(4_000) }) });
    const result = await createGoalTool.execute({}, ctx);

    expect(result.isError).toBe(false);
    expect((await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    }))?.objective).toHaveLength(4_000);

    const second = context({ consumeFreshUserInput: () => ({ text: "m".repeat(3_900) }) });
    const nearLimit = await createGoalTool.execute({}, second);
    expect(nearLimit.isError).toBe(false);
  });

  test("a verbatim amendment preserves prior requirements and states its later conflict", async () => {
    const sourceByAction = ["Do not use any and pass tests.", "Allow any in generated fixtures while preserving all other requirements."];
    let index = 0;
    const ctx = context({ consumeFreshUserInput: () => ({ text: sourceByAction[index++]! }) });
    await createGoalTool.execute({}, ctx);
    const edited = await updateGoalTool.execute({
      action: "edit",
      expected_generation: 1,
      mode: "amend",
    }, ctx);
    expect(edited.isError).toBe(false);
    const goal = await ctx.sessionGoalService!.get({ workspaceRoot: tempRoot.path, sessionId: ctx.store.getState().sessionId });
    expect(goal?.objective).toContain("Do not use any");
    expect(goal?.objective).toContain("Allow any in generated fixtures");
    const { buildGoalReviewContract } = await import("../../session-goal/review-gate");
    const contract = buildGoalReviewContract(goal!.objective);
    expect(contract.objective).toContain("Allow any in generated fixtures");
  });

  test("replace uses only the fresh user objective and removes prior constraints", async () => {
    const requests = ["Do not use any; pass every test.", "Replace the legacy module and permit any in generated fixtures."];
    let index = 0;
    const ctx = context({ consumeFreshUserInput: () => ({ text: requests[index++]! }) });
    await createGoalTool.execute({}, ctx);
    const replaced = await updateGoalTool.execute({ action: "edit", mode: "replace", expected_generation: 1 }, ctx);

    expect(replaced.isError).toBe(false);
    const goal = await ctx.sessionGoalService!.get({ workspaceRoot: tempRoot.path, sessionId: ctx.store.getState().sessionId });
    expect(goal?.objective).toBe(requests[1]);
    expect(goal?.objective).not.toContain("Do not use any");
  });

  test("repeated amendments fail rather than exceed the one-objective limit", async () => {
    const requests = ["a".repeat(3_900), "b".repeat(80)];
    let index = 0;
    const ctx = context({ consumeFreshUserInput: () => ({ text: requests[index++]! }) });
    await createGoalTool.execute({}, ctx);
    const result = await updateGoalTool.execute({ action: "edit", mode: "amend", expected_generation: 1 }, ctx);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("would exceed 4000");
  });

  test("set_budget immediately limits an active Goal when usage already reaches the new cap", async () => {
    expect(UpdateGoalInputSchema.safeParse({ action: "set_budget", token_budget: 10 }).success).toBe(false);
    const requests = ["Keep working until every test passes.", "Set the Goal token budget to 10 tokens."];
    let index = 0;
    const ctx = context({ consumeFreshUserInput: () => ({ text: requests[index++]! }) });
    await createGoalTool.execute({}, ctx);
    await ctx.sessionGoalService!.recordUsage({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
      authority: { kind: "runtime" },
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10, reasoningTokens: 0, cachedInputTokens: 0 },
      executionTimeMs: 1,
    });

    const result = await updateGoalTool.execute({ action: "set_budget" }, ctx);

    expect(result.isError).toBe(false);
    expect(await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    })).toMatchObject({ status: "budget_limited", tokenBudget: 10 });
  });

  test("set_budget rejects a budget that was not explicitly authorized by fresh user input", async () => {
    const requests = ["Keep working until every test passes.", "Please keep going with the same Goal."];
    let index = 0;
    const ctx = context({ consumeFreshUserInput: () => ({ text: requests[index++]! }) });
    await createGoalTool.execute({}, ctx);

    const result = await updateGoalTool.execute({ action: "set_budget" }, ctx);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("requires an explicit token budget request");
    expect(await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    })).not.toHaveProperty("tokenBudget");
  });
});
