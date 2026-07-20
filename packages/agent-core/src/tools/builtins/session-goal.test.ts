import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";

import { SessionGoalService } from "../../session-goal";
import { storeManager } from "../../store/store";
import { createTestTempRoot } from "../../testing/test-temp-root";
import { testExecutionRecord } from "../../testing/test-execution-fixtures";
import type { ToolExecutionContext } from "../types";
import { CreateGoalInputSchema, UpdateGoalInputSchema, createGoalTool, updateGoalTool } from "./session-goal";

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

function attachReviewer(
  ctx: ToolExecutionContext,
  runs: readonly { status: Parameters<typeof testExecutionRecord>[1]; output?: string }[],
): string {
  const rootState = ctx.store.getState();
  const reviewerSessionId = crypto.randomUUID();
  const reviewerStore = storeManager.create(reviewerSessionId, tempRoot.path, {
    agentName: "reviewer",
    rootSessionId: rootState.sessionId,
    parentSessionId: rootState.sessionId,
  });
  const executions = runs.map((run) => testExecutionRecord(crypto.randomUUID(), run.status));
  reviewerStore.setState({
    executions,
    messages: runs.flatMap((run, index) => {
      if (run.output === undefined) return [];
      const executionId = executions[index]!.id;
      const messageId = crypto.randomUUID();
      return [{
        id: messageId,
        role: "assistant" as const,
        parts: [{
          type: "text" as const,
          id: `${messageId}:text`,
          text: run.output,
          createdAt: index + 1,
          completedAt: index + 1,
        }],
        createdAt: index + 1,
        completedAt: index + 1,
        executionId,
      }];
    }),
  });
  ctx.store.setState({
    childSessionLinks: [{
      parentSessionId: rootState.sessionId,
      parentToolCallId: crypto.randomUUID(),
      toolName: "delegate",
      childSessionId: reviewerSessionId,
      childAgentName: "reviewer",
      title: "Independent Goal review",
      depth: 1,
      background: true,
      status: runs.at(-1)?.status === "completed" ? "completed" : "running",
      createdAt: 1,
    }],
  });
  return reviewerSessionId;
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

  test("update_goal accepts only Agent-owned terminal statuses", () => {
    expect(UpdateGoalInputSchema.safeParse({
      status: "complete",
      reason: "Approved.",
      review_session_id: "reviewer-session",
    }).success).toBe(true);
    expect(UpdateGoalInputSchema.safeParse({
      status: "blocked",
      reason: "Waiting for an external decision.",
    }).success).toBe(true);

    for (const input of [
      { action: "edit", expected_generation: 1, mode: "amend" },
      { action: "pause" },
      { action: "resume" },
      { action: "clear" },
      { action: "set_budget" },
      { action: "complete", status: "complete", reason: "Approved.", review_session_id: "reviewer-session" },
    ]) {
      expect(UpdateGoalInputSchema.safeParse(input).success).toBe(false);
    }
  });

  test("complete requires a direct Reviewer whose latest completed Execution approves", async () => {
    const ctx = context({ consumeFreshUserInput: () => ({ text: "Finish migration and pass tests." }) });
    await createGoalTool.execute({}, ctx);
    const reviewSessionId = attachReviewer(ctx, [{
      status: "completed",
      output: "\nVERDICT: APPROVED\n\nAll acceptance criteria pass.",
    }]);

    const result = await updateGoalTool.execute({
      status: "complete",
      reason: "Implementation and tests are ready.",
      review_session_id: reviewSessionId,
    }, ctx);

    expect(result.isError).toBe(false);
    const goal = await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    });
    expect(goal?.status).toBe("complete");
    expect(goal?.completedAt).toBeNumber();
    expect(goal).not.toHaveProperty("review");
  });

  test("complete rejects missing review id, non-approved output, and stale approved output", async () => {
    expect(UpdateGoalInputSchema.safeParse({ status: "complete", reason: "done" }).success).toBe(false);

    const changed = context({ consumeFreshUserInput: () => ({ text: "Finish migration." }) });
    await createGoalTool.execute({}, changed);
    const changedId = attachReviewer(changed, [{ status: "completed", output: "VERDICT: CHANGES_REQUESTED\nMissing evidence." }]);
    const changedResult = await updateGoalTool.execute({
      status: "complete",
      reason: "done",
      review_session_id: changedId,
    }, changed);
    expect(changedResult.isError).toBe(true);
    expect(text(changedResult)).toContain("VERDICT: APPROVED");

    const stale = context({ consumeFreshUserInput: () => ({ text: "Finish migration." }) });
    await createGoalTool.execute({}, stale);
    const staleId = attachReviewer(stale, [
      { status: "completed", output: "VERDICT: APPROVED" },
      { status: "completed", output: "VERDICT: CHANGES_REQUESTED" },
    ]);
    const staleResult = await updateGoalTool.execute({
      status: "complete",
      reason: "done",
      review_session_id: staleId,
    }, stale);
    expect(staleResult.isError).toBe(true);
    expect((await stale.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: stale.store.getState().sessionId,
    }))?.status).toBe("active");
  });

  test("complete deterministically rejects every non-qualifying Reviewer identity and latest outcome", async () => {
    const cases = [
      { name: "completed empty output", runs: [{ status: "completed" as const }] },
      { name: "malformed verdict", runs: [{ status: "completed" as const, output: "APPROVED" }] },
      { name: "latest running after approval", runs: [
        { status: "completed" as const, output: "VERDICT: APPROVED" },
        { status: "running" as const, output: "VERDICT: APPROVED" },
      ] },
      { name: "latest empty after approval", runs: [
        { status: "completed" as const, output: "VERDICT: APPROVED" },
        { status: "completed" as const },
      ] },
      { name: "latest malformed after approval", runs: [
        { status: "completed" as const, output: "VERDICT: APPROVED" },
        { status: "completed" as const, output: "Result: approved" },
      ] },
    ];

    for (const candidate of cases) {
      const ctx = context({ consumeFreshUserInput: () => ({ text: `Finish migration: ${candidate.name}.` }) });
      await createGoalTool.execute({}, ctx);
      const reviewSessionId = attachReviewer(ctx, candidate.runs);
      const result = await updateGoalTool.execute({
        status: "complete",
        reason: candidate.name,
        review_session_id: reviewSessionId,
      }, ctx);
      expect(result.isError, candidate.name).toBe(true);
      expect((await ctx.sessionGoalService!.get({
        workspaceRoot: tempRoot.path,
        sessionId: ctx.store.getState().sessionId,
      }))?.status, candidate.name).toBe("active");
    }

    const missing = context({ consumeFreshUserInput: () => ({ text: "Finish migration." }) });
    await createGoalTool.execute({}, missing);
    const missingResult = await updateGoalTool.execute({
      status: "complete",
      reason: "done",
      review_session_id: crypto.randomUUID(),
    }, missing);
    expect(missingResult.isError).toBe(true);

    const wrongIdentity = context({ consumeFreshUserInput: () => ({ text: "Finish migration." }) });
    await createGoalTool.execute({}, wrongIdentity);
    const wrongIdentityId = attachReviewer(wrongIdentity, [{ status: "completed", output: "VERDICT: APPROVED" }]);
    wrongIdentity.storeManager.get(wrongIdentityId, tempRoot.path)!.setState({ agentName: "explore" });
    const wrongIdentityResult = await updateGoalTool.execute({
      status: "complete",
      reason: "done",
      review_session_id: wrongIdentityId,
    }, wrongIdentity);
    expect(wrongIdentityResult.isError).toBe(true);

    const wrongRoot = context({ consumeFreshUserInput: () => ({ text: "Finish migration." }) });
    await createGoalTool.execute({}, wrongRoot);
    const wrongRootId = attachReviewer(wrongRoot, [{ status: "completed", output: "VERDICT: APPROVED" }]);
    const unrelatedRootId = crypto.randomUUID();
    wrongRoot.storeManager.get(wrongRootId, tempRoot.path)!.setState({
      rootSessionId: unrelatedRootId,
      parentSessionId: unrelatedRootId,
    });
    const wrongRootResult = await updateGoalTool.execute({
      status: "complete",
      reason: "done",
      review_session_id: wrongRootId,
    }, wrongRoot);
    expect(wrongRootResult.isError).toBe(true);
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
    expect(goal?.objective).toContain("do not use any");
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

});
