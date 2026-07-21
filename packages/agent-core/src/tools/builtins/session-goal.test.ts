import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";

import { SessionGoalService } from "../../session-goal";
import { storeManager } from "../../store/store";
import type { SessionStoreState, SessionToolBatch } from "../../store/types";
import { createTestTempRoot } from "../../testing/test-temp-root";
import { testExecutionRecord } from "../../testing/test-execution-fixtures";
import { createTestProjectContext } from "../test-project-context";
import type { ToolExecutionContext } from "../types";
import { GOAL_AUTHORIZATION_OPTIONS } from "./ask-user";
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
  readonly consumeFreshUserInput?: ToolExecutionContext["consumeFreshUserInput"];
  readonly discussion?: boolean;
} = {}): ToolExecutionContext {
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

async function createGoal(ctx: ToolExecutionContext, objective = "Keep working until every migration test passes."): Promise<void> {
  const result = await createGoalTool.execute({ objective }, ctx);
  expect(result.isError).toBe(false);
}

function authorizeThroughAskUser(
  ctx: ToolExecutionContext,
  objective: string,
  answer: string,
  options?: readonly { readonly label: string; readonly description: string }[],
  preset: "goal_authorization" | undefined = options === undefined ? "goal_authorization" : undefined,
): void {
  const sourceExecutionId = ctx.store.getState().currentExecutionId ?? crypto.randomUUID();
  const executionId = crypto.randomUUID();
  const toolCallId = crypto.randomUUID();
  const startedAt = Date.now();
  const continuationStartedAt = new Date(startedAt + 1).toISOString();
  const continuationCompletedAt = new Date(startedAt + 2).toISOString();
  ctx.store.setState({
    currentExecutionId: executionId,
    executions: [
      ...ctx.store.getState().executions.map((execution) => execution.status === "running"
        ? { ...execution, status: "waiting_for_human" as const, endedAt: startedAt }
        : execution),
      {
        ...testExecutionRecord(executionId, "running"),
        startedAt,
        origin: "tool_batch" as const,
      },
    ],
    toolBatches: [...ctx.store.getState().toolBatches, {
      batchId: crypto.randomUUID(),
      executionId: sourceExecutionId,
      step: 1,
      agentName: "lead",
      allowedTools: ["ask_user"],
      agentSkills: [],
      partitions: [{ type: "serial", callIds: [toolCallId] }],
      calls: [{
        ordinal: 0,
        partitionIndex: 0,
        toolCallId,
        toolName: "ask_user",
        input: {
          questions: [{
            question: objective,
            header: "Goal",
            ...(options === undefined ? {} : { options: [...options] }),
            custom: false,
            ...(preset === undefined ? {} : { preset }),
          }],
        },
        traits: { readOnly: true, destructive: false, concurrencySafe: false },
        state: "completed",
        attempt: 1,
        result: {
          isError: false,
          output: {
            preview: "answered",
            completeness: "complete",
            observed: { bytes: 8, lines: 1 },
            canonical: { bytes: 8, lines: 1 },
            stored: { bytes: 8, lines: 1 },
            omitted: { bytes: 0, lines: 0 },
            recovery: { kind: "none" },
          },
        },
        blocker: {
          requestKey: `question:${toolCallId}`,
          source: { type: "ask_user", toolCallId },
          displayPayload: { title: "Goal", summary: objective, redacted: true },
          hitlId: crypto.randomUUID(),
          responseAppliedAt: new Date().toISOString(),
          response: { type: "question_answer", answers: [answer] },
        },
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      continuationStartedAt,
      continuationCompletedAt,
      archivedAt: continuationCompletedAt,
    } as SessionToolBatch],
  });
}

function recordSuccessfulCreateGoal(ctx: ToolExecutionContext, objective: string): void {
  const toolCallId = crypto.randomUUID();
  const now = new Date().toISOString();
  ctx.store.setState({
    toolBatches: [...ctx.store.getState().toolBatches, {
      batchId: crypto.randomUUID(),
      executionId: ctx.store.getState().currentExecutionId!,
      step: 2,
      agentName: "lead",
      allowedTools: ["create_goal"],
      agentSkills: [],
      partitions: [{ type: "serial", callIds: [toolCallId] }],
      calls: [{
        ordinal: 0,
        partitionIndex: 0,
        toolCallId,
        toolName: "create_goal",
        input: { objective },
        traits: { readOnly: false, destructive: false, concurrencySafe: false },
        state: "completed",
        attempt: 1,
        result: {
          isError: false,
          output: {
            preview: "created",
            completeness: "complete",
            observed: { bytes: 7, lines: 1 },
            canonical: { bytes: 7, lines: 1 },
            stored: { bytes: 7, lines: 1 },
            omitted: { bytes: 0, lines: 0 },
            recovery: { kind: "none" },
          },
        },
      }],
      createdAt: now,
      updatedAt: now,
      continuationStartedAt: now,
      continuationCompletedAt: now,
      archivedAt: now,
    } as SessionToolBatch],
  });
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

  test("creates only from an exact fresh explicit persistent user objective", async () => {
    const objective = "Keep working until every authentication test passes.";
    const ctx = context({ consumeFreshUserInput: () => ({ text: objective }) });
    await createGoal(ctx, objective);
    expect((await ctx.sessionGoalService!.get({
      workspaceRoot: tempRoot.path,
      sessionId: ctx.store.getState().sessionId,
    }))?.objective).toBe(objective);

    const ordinary = context({ consumeFreshUserInput: () => ({ text: "Fix the authentication test." }) });
    expect((await createGoalTool.execute({ objective: "Fix the authentication test." }, ordinary)).isError).toBe(true);

    const rewritten = context({ consumeFreshUserInput: () => ({ text: objective }) });
    expect((await createGoalTool.execute({ objective: "Keep working until all tests pass." }, rewritten)).isError).toBe(true);

    for (const deniedObjective of [
      "Don't keep working until every authentication test passes.",
      "I don't want ArchCode to keep working until every authentication test passes.",
      "Keep working until every authentication test passes, but do not start a Goal.",
      "Maybe keep working until every authentication test passes.",
      "Should we keep working until every authentication test passes?",
      "Can you continue until complete?",
      "Would you continue until complete?",
      "不要继续执行直到所有认证测试通过。",
      "继续工作直到所有认证测试通过，但不要开启 Goal。",
      "你能继续直到完成吗？",
    ]) {
      const denied = context({ consumeFreshUserInput: () => ({ text: deniedObjective }) });
      expect((await createGoalTool.execute({ objective: deniedObjective }, denied)).isError, deniedObjective).toBe(true);
    }

    const explicitNegativeStop = "Don't stop until every authentication test passes.";
    const acceptedNegativeStop = context({ consumeFreshUserInput: () => ({ text: explicitNegativeStop }) });
    expect((await createGoalTool.execute({ objective: explicitNegativeStop }, acceptedNegativeStop)).isError).toBe(false);
  });

  test("accepts only the stable start action of the latest current resumed ask_user authorization", async () => {
    const objective = "Complete the migration and keep working until the suite is green.";
    const accepted = context();
    authorizeThroughAskUser(accepted, objective, GOAL_AUTHORIZATION_OPTIONS[0].label);
    expect((await createGoalTool.execute({ objective }, accepted)).isError).toBe(false);

    for (const answer of [GOAL_AUTHORIZATION_OPTIONS[1].label, GOAL_AUTHORIZATION_OPTIONS[2].label]) {
      const denied = context();
      authorizeThroughAskUser(denied, objective, answer);
      expect((await createGoalTool.execute({ objective }, denied)).isError, answer).toBe(true);
    }

    const reversed = context();
    authorizeThroughAskUser(reversed, objective, GOAL_AUTHORIZATION_OPTIONS[1].label, [
      GOAL_AUTHORIZATION_OPTIONS[1],
      GOAL_AUTHORIZATION_OPTIONS[0],
      GOAL_AUTHORIZATION_OPTIONS[2],
    ]);
    expect((await createGoalTool.execute({ objective }, reversed)).isError).toBe(true);

    const forgedPreset = context();
    authorizeThroughAskUser(forgedPreset, objective, GOAL_AUTHORIZATION_OPTIONS[1].label, [
      GOAL_AUTHORIZATION_OPTIONS[1],
      GOAL_AUTHORIZATION_OPTIONS[0],
      GOAL_AUTHORIZATION_OPTIONS[2],
    ], "goal_authorization");
    expect((await createGoalTool.execute({ objective }, forgedPreset)).isError).toBe(true);

    const staleWithinExecution = context();
    authorizeThroughAskUser(staleWithinExecution, objective, GOAL_AUTHORIZATION_OPTIONS[0].label);
    authorizeThroughAskUser(staleWithinExecution, objective, GOAL_AUTHORIZATION_OPTIONS[1].label);
    expect((await createGoalTool.execute({ objective }, staleWithinExecution)).isError).toBe(true);

    const stale = context();
    authorizeThroughAskUser(stale, objective, GOAL_AUTHORIZATION_OPTIONS[0].label);
    stale.store.setState({ currentExecutionId: crypto.randomUUID() });
    expect((await createGoalTool.execute({ objective }, stale)).isError).toBe(true);

    const replayed = context();
    authorizeThroughAskUser(replayed, objective, GOAL_AUTHORIZATION_OPTIONS[0].label);
    expect((await createGoalTool.execute({ objective }, replayed)).isError).toBe(false);
    recordSuccessfulCreateGoal(replayed, objective);
    await replayed.sessionGoalService!.clear({
      workspaceRoot: tempRoot.path,
      sessionId: replayed.store.getState().sessionId,
      authority: { kind: "user_control" },
    });
    expect((await createGoalTool.execute({ objective }, replayed)).isError).toBe(true);
  });

  test("Discussion Lead cannot create a Goal", async () => {
    const objective = "Keep working until every test passes.";
    const ctx = context({ discussion: true, consumeFreshUserInput: () => ({ text: objective }) });
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
    const ctx = context({ consumeFreshUserInput: () => ({ text: objective }) });
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
    const ctx = context({ consumeFreshUserInput: () => ({ text: objective }) });
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
      const ctx = context({ consumeFreshUserInput: () => ({ text: objective }) });
      await createGoal(ctx, objective);
      const reviewSessionId = attachGoalReview(ctx, candidate.review);
      const result = await updateGoalTool.execute({ status: "complete", reason: candidate.name, review_session_id: reviewSessionId }, ctx);
      expect(result.isError, candidate.name).toBe(true);
    }
  });

  test("a completed review attempt is terminal and cannot be rewritten by resume", async () => {
    const objective = "Keep working until the migration is verifiably complete.";
    const ctx = context({ consumeFreshUserInput: () => ({ text: objective }) });
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
    const ctx = context({ consumeFreshUserInput: () => ({ text: objective }) });
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
    const outside = context({ consumeFreshUserInput: () => ({ text: objective }) });
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

    const inside = context({ consumeFreshUserInput: () => ({ text: objective }) });
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
