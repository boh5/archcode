import { z } from "zod/v4";
import type { StoreApi } from "zustand";
import type { ChildResultReceipt } from "@archcode/protocol";
import type { SessionStoreState } from "../../store/types";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { projectGoalReviewReceipt } from "../../goals/review-schema";

const DEFAULT_TIMEOUT_MS = 1_800_000;
const MAX_TIMEOUT_MS = 1_800_000;

export const BackgroundOutputInputSchema = z.strictObject({
  session_id: z.string().trim().min(1),
  block: z.boolean().default(false),
  timeout_ms: z.number().int().min(0).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
});

export type BackgroundOutputInput = z.output<typeof BackgroundOutputInputSchema>;

export async function executeBackgroundOutput(
  input: BackgroundOutputInput,
  ctx: ToolExecutionContext,
): Promise<string | ToolExecutionResult> {
  const parentSessionId = ctx.store.getState().sessionId;
  if (input.session_id === parentSessionId) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_INVALID_BACKGROUND_SESSION",
      message: "background_output cannot read the current Session",
    });
  }

  let childStore: StoreApi<SessionStoreState> | undefined;
  try {
    childStore = await getChildStore(input.session_id, ctx);
  } catch (error) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CHILD_SESSION_LOAD_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (childStore === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CHILD_SESSION_NOT_FOUND",
      message: `Child Session store not found: ${input.session_id}`,
    });
  }
  if (childStore.getState().parentSessionId !== parentSessionId) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CHILD_SESSION_NOT_DIRECT",
      message: `Session ${input.session_id} is not a direct child of ${parentSessionId}`,
    });
  }

  await recoverGoalReviewResultProjection(childStore, ctx);

  const waitResult = input.block && childStore.getState().isRunning
    ? await waitForChildToStop(childStore, input.timeout_ms, ctx.abort)
    : "not_waited";
  const state = childStore.getState();
  const execution = state.executions.at(-1);
  const receipt = receiptForExecution(state.childResultReceipts, execution?.id);

  return JSON.stringify({
    session_id: state.sessionId,
    execution_status: state.isRunning ? "running" : (execution?.status ?? "idle"),
    wait_status: waitResult,
    ...(receipt === undefined ? {} : { result_receipt: receipt }),
    ...(execution?.error === undefined ? {} : { error: execution.error }),
  });
}

async function recoverGoalReviewResultProjection(
  childStore: StoreApi<SessionStoreState>,
  ctx: ToolExecutionContext,
): Promise<void> {
  const state = childStore.getState();
  const execution = state.executions.at(-1);
  if (
    state.agentName !== "reviewer"
    || state.sessionRole !== "review"
    || state.goalId === undefined
    || execution === undefined
    || state.childResultReceipts.some((receipt) => receipt.executionId === execution.id)
  ) return;

  const goal = await ctx.projectContext.goalState.read(state.goalId);
  const review = goal.review;
  if (
    review === undefined
    || review.reviewerSessionId !== state.sessionId
    || review.executionId !== execution.id
    || review.delegationContractHash !== state.delegationContractHash
  ) return;

  const projection = projectGoalReviewReceipt(review);
  await ctx.storeManager.commitDurableSessionMutation(
    state.sessionId,
    ctx.projectContext.project.workspaceRoot,
    (current) => current.childResultReceipts.some((receipt) => receipt.executionId === projection.executionId)
      ? { result: undefined }
      : { result: undefined, events: [{ type: "child-result", receipt: projection }] },
  );
}

async function getChildStore(
  sessionId: string,
  ctx: ToolExecutionContext,
): Promise<StoreApi<SessionStoreState> | undefined> {
  const workspaceRoot = ctx.projectContext.project.workspaceRoot;
  const liveStore = ctx.storeManager.get(sessionId, workspaceRoot);
  if (liveStore !== undefined) return liveStore;
  return await ctx.storeManager.getOrLoad(sessionId, workspaceRoot);
}

type WaitResult = "not_waited" | "stopped" | "timed_out" | "aborted";

function waitForChildToStop(
  childStore: StoreApi<SessionStoreState>,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<WaitResult> {
  if (!childStore.getState().isRunning) return Promise.resolve("stopped");
  if (abortSignal.aborted) return Promise.resolve("aborted");

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe();
      abortSignal.removeEventListener("abort", onAbort);
    };
    const settle = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => settle("aborted");
    const unsubscribe = childStore.subscribe((state) => {
      if (!state.isRunning) settle("stopped");
    });
    abortSignal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => settle("timed_out"), timeoutMs);
    if (!childStore.getState().isRunning) settle("stopped");
  });
}

function receiptForExecution(
  receipts: readonly ChildResultReceipt[],
  executionId: string | undefined,
): ChildResultReceipt | undefined {
  if (executionId === undefined) return undefined;
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index];
    if (receipt?.executionId === executionId) return receipt;
  }
  return undefined;
}

export const backgroundOutputTool = defineTool({
  name: "background_output",
  description: [
    "Read the execution status and canonical result receipt of one direct child Session.",
    "It never treats assistant text as a child result. A terminal execution without result_receipt did not satisfy the child result protocol.",
    "Use block=true after a terminal reminder when the persisted receipt is required; do not poll.",
  ].join("\n"),
  inputSchema: BackgroundOutputInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  execute: executeBackgroundOutput,
});
