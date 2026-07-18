import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChildResultReceipt, DelegationContract } from "@archcode/protocol";
import { hashDelegationContract } from "../../delegation/contract";
import { silentLogger } from "../../logger";
import { SessionStoreManager } from "../../store/session-store-manager";
import { __setSessionsDirForTest } from "../../store/sessions-dir";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { BackgroundOutputInputSchema, executeBackgroundOutput } from "./background-output";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "background-output-v2", crypto.randomUUID());
const WORKSPACE_ROOT = join(TMP_DIR, "workspace");

beforeEach(async () => {
  await mkdir(WORKSPACE_ROOT, { recursive: true });
  __setSessionsDirForTest(() => join(TMP_DIR, "sessions"));
});

afterEach(async () => {
  __setSessionsDirForTest(undefined);
  await rm(TMP_DIR, { recursive: true, force: true });
});

function contract(): DelegationContract {
  return {
    agent_type: "explore",
    title: "Inspect",
    objective: "Inspect one owner",
    owned_scope: [],
    non_goals: [],
    acceptance_criteria: [{ id: "ac-1", condition: "Owner found", requiredEvidence: "File ref" }],
    evidence: [],
    verification: [],
    depends_on: [],
    skills: [],
    background: true,
  };
}

function makeContext(): ToolExecutionContext {
  const storeManager = new SessionStoreManager({ logger: silentLogger });
  return {
    store: storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { agentName: "engineer" }),
    storeManager,
    toolName: "background_output",
    toolCallId: "background-output-call",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["background_output"]),
    cwd: WORKSPACE_ROOT,
    projectContext: createTestProjectContext(WORKSPACE_ROOT),
  };
}

function createChild(ctx: ToolExecutionContext) {
  const value = contract();
  return ctx.storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, {
    agentName: "explore",
    parentSessionId: ctx.store.getState().sessionId,
    rootSessionId: ctx.store.getState().rootSessionId,
    delegationContract: value,
    delegationContractHash: hashDelegationContract(value),
    title: value.title,
  });
}

function appendReceipt(child: ReturnType<typeof createChild>): ChildResultReceipt {
  const executionId = crypto.randomUUID();
  const receipt: ChildResultReceipt = {
    executionId,
    delegationContractHash: child.getState().delegationContractHash!,
    submittedAt: 10,
    result: {
      status: "completed",
      summary: "Owner found",
      deliverables: [],
      evidence: [{ claim: "Owner found", ref: "src/owner.ts:1" }],
      criteria: [{ id: "ac-1", status: "passed", evidenceRefs: ["src/owner.ts:1"] }],
      verification: [],
      unresolved: [],
    },
  };
  child.getState().append({ type: "execution-start", executionId });
  child.getState().append({ type: "text-start" });
  child.getState().append({ type: "text-delta", text: "This text is not the result" });
  child.getState().append({ type: "text-end" });
  child.getState().append({ type: "child-result", receipt });
  child.getState().append({ type: "execution-end", status: "completed" });
  return receipt;
}

describe("background_output V2", () => {
  it("accepts only canonical status/wait parameters", () => {
    expect(BackgroundOutputInputSchema.parse({ session_id: "child" })).toEqual({
      session_id: "child",
      block: false,
      timeout_ms: 1_800_000,
    });
    for (const field of ["full_session", "message_limit", "since_message_id", "include_tool_results", "include_reasoning"]) {
      expect(BackgroundOutputInputSchema.safeParse({ session_id: "child", [field]: true }).success).toBe(false);
    }
  });

  it("returns the matching persisted receipt and never assistant text", async () => {
    const ctx = makeContext();
    const child = createChild(ctx);
    const receipt = appendReceipt(child);
    const output = await executeBackgroundOutput({
      session_id: child.getState().sessionId,
      block: false,
      timeout_ms: 1_000,
    }, ctx) as string;
    expect(JSON.parse(output)).toEqual({
      session_id: child.getState().sessionId,
      execution_status: "completed",
      wait_status: "not_waited",
      result_receipt: receipt,
    });
    expect(output).not.toContain("This text is not the result");
  });

  it("reports running without fabricating a receipt", async () => {
    const ctx = makeContext();
    const child = createChild(ctx);
    child.getState().append({ type: "execution-start", executionId: "running" });
    const output = await executeBackgroundOutput({
      session_id: child.getState().sessionId,
      block: false,
      timeout_ms: 1_000,
    }, ctx) as string;
    expect(JSON.parse(output)).toEqual({
      session_id: child.getState().sessionId,
      execution_status: "running",
      wait_status: "not_waited",
    });
  });

  it("recovers a missing Session projection from the canonical Goal review receipt", async () => {
    const ctx = makeContext();
    const goalId = crypto.randomUUID();
    ctx.store.setState({
      agentName: "goal_lead",
      goalId,
      sessionRole: "main",
    });
    const reviewContract: DelegationContract = {
      ...contract(),
      agent_type: "reviewer",
      title: "Review Goal",
      objective: "Verify the Goal acceptance criteria",
      acceptance_criteria: [{
        id: "goal-ac",
        condition: "Goal acceptance criteria are satisfied",
        requiredEvidence: "Review evidence",
      }],
    };
    const child = ctx.storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, {
      agentName: "reviewer",
      parentSessionId: ctx.store.getState().sessionId,
      rootSessionId: ctx.store.getState().rootSessionId,
      delegationContract: reviewContract,
      delegationContractHash: hashDelegationContract(reviewContract),
      title: reviewContract.title,
      goalId,
      sessionRole: "review",
    });
    const executionId = crypto.randomUUID();
    child.getState().append({ type: "execution-start", executionId });
    child.getState().append({ type: "execution-end", status: "completed" });

    const goal = await ctx.projectContext.goalState.commit({
      id: goalId,
      projectSlug: ctx.projectContext.project.slug,
      createdFromSessionId: crypto.randomUUID(),
      objective: "Recover the canonical review result",
      acceptanceCriteria: "The parent can collect the result after a projection crash",
      mainSessionId: ctx.store.getState().sessionId,
    });
    const reviewing = await ctx.projectContext.goalState.beginReview(goal.id);
    const result = {
      status: "completed" as const,
      summary: "Goal verified",
      criteria: [{ id: "goal-ac", status: "passed" as const, evidenceRefs: ["goal-test"] }],
      deliverables: [],
      evidence: [{ claim: "Goal verified", ref: "goal-test" }],
      verification: [],
      unresolved: [],
    };
    const finalized = await ctx.projectContext.goalState.finalizeReview(goal.id, {
      expectedReviewGeneration: reviewing.reviewGeneration,
      verdict: "DONE",
      summary: result.summary,
      evidenceRefs: [{ kind: "test_output", ref: "goal-test", summary: "Goal review passed" }],
      executionId,
      delegationContractHash: hashDelegationContract(reviewContract),
      result,
      authorization: {
        agentName: "reviewer",
        sessionRole: "review",
        sessionGoalId: goalId,
        reviewerSessionId: child.getState().sessionId,
      },
    });
    expect(child.getState().childResultReceipts).toEqual([]);

    const output = await executeBackgroundOutput({
      session_id: child.getState().sessionId,
      block: false,
      timeout_ms: 1_000,
    }, ctx) as string;
    const recovered = JSON.parse(output);

    expect(recovered.result_receipt).toMatchObject({
      executionId,
      delegationContractHash: hashDelegationContract(reviewContract),
      result,
    });
    expect(recovered.result_receipt.submittedAt).toBe(Date.parse(finalized.review!.decidedAt));
    expect(child.getState().childResultReceipts).toEqual([recovered.result_receipt]);
  });

  it("rejects non-direct Sessions", async () => {
    const ctx = makeContext();
    const unrelated = ctx.storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { agentName: "engineer" });
    const result = await executeBackgroundOutput({
      session_id: unrelated.getState().sessionId,
      block: false,
      timeout_ms: 1_000,
    }, ctx) as ToolExecutionResult;
    expect(JSON.parse(result.output).code).toBe("TOOL_CHILD_SESSION_NOT_DIRECT");
  });
});
