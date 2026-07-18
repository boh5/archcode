import { z } from "zod/v4";
import type { ChildResultReceipt, SessionExecutionRecord } from "@archcode/protocol";
import { DelegationContractSchema } from "../../delegation/schema";
import type { ChildExecutionHandle, ChildExecutionOutcome } from "../../delegation/types";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { RawToolResult, ToolExecutionContext } from "../types";

export const DelegateInputSchema = DelegationContractSchema.superRefine((contract, ctx) => {
  if (contract.agent_type === "build" && contract.owned_scope.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["owned_scope"],
      message: "Build delegation requires at least one owned_scope entry",
    });
  }
});

export type DelegateInput = z.output<typeof DelegateInputSchema>;

export interface DelegateErrorOutput {
  ok: false;
  session_id: string;
  error: { name: string; message: string };
  target_agent?: string;
  rejected_skill?: string;
  allowed_skills?: readonly string[];
}

export async function executeDelegate(input: DelegateInput, ctx: ToolExecutionContext): Promise<RawToolResult> {
  if (ctx.startChildExecution === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_DELEGATE_EXECUTOR_UNAVAILABLE",
      name: "SubAgentError",
      message: "Child execution is not available in this execution context",
    });
  }

  let handle: ChildExecutionHandle;
  try {
    handle = await ctx.startChildExecution({
      parentStore: ctx.store,
      parentSessionId: ctx.store.getState().sessionId,
      parentToolCallId: ctx.toolCallId,
      toolName: "delegate",
      contract: input,
      parentAbort: ctx.abort,
    });
  } catch (error) {
    const safeError = error instanceof Error ? error : new Error(String(error));
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_DELEGATE_FAILED",
      message: safeError.message,
      name: safeError.name,
      error: safeError,
    });
  }

  if (input.background ?? false) {
    return createTextToolResult(formatAsyncChildOutput(handle));
  }

  const outcome = await waitForChildOutcome(handle);
  return createTextToolResult(formatSyncChildOutput(handle, outcome));
}

export function formatAsyncChildOutput(handle: ChildExecutionHandle): string {
  return JSON.stringify({
    session_id: handle.sessionId,
    agent_type: handle.store.getState().agentName,
    execution_status: "running",
  });
}

export function formatSyncChildOutput(
  handle: ChildExecutionHandle,
  outcome: ChildExecutionOutcome,
): string {
  return JSON.stringify({
    session_id: handle.sessionId,
    agent_type: handle.store.getState().agentName,
    execution_status: outcome.executionStatus,
    ...(outcome.resultReceipt === undefined ? {} : { result_receipt: outcome.resultReceipt }),
    ...(errorMessage(outcome.terminalError) === undefined ? {} : { error: errorMessage(outcome.terminalError) }),
  });
}

export async function waitForChildOutcome(handle: ChildExecutionHandle): Promise<ChildExecutionOutcome> {
  try {
    return await handle.result;
  } catch (error) {
    const state = handle.store.getState();
    const run = state.executions.at(-1);
    return {
      executionStatus: terminalStatus(run, error),
      resultReceipt: receiptForExecution(state.childResultReceipts, run?.id),
      terminalError: error,
    };
  }
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

function terminalStatus(
  run: SessionExecutionRecord | undefined,
  terminalError: unknown,
): SessionExecutionRecord["status"] {
  if (run !== undefined && run.status !== "running") return run.status;
  const message = terminalError instanceof Error ? terminalError.message : String(terminalError);
  if (/timed out/i.test(message)) return "timed_out";
  if (/aborted/i.test(message)) return "aborted";
  if (/cancelled|canceled/i.test(message)) return "cancelled";
  if (/max steps/i.test(message)) return "max_steps";
  return "failed";
}

function errorMessage(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  return error instanceof Error ? error.message : String(error);
}

export const delegateTool = defineTool({
  name: "delegate",
  description: [
    "Create one direct child Session from a complete DelegationContract.",
    "Delegate only independently owned, independently verifiable work. Parallel children must have no dependency and no overlapping owned scope.",
    "The child receives only this durable contract as its handoff. Use resume_session for corrections or follow-up on the same responsibility.",
    "background=false waits and returns the canonical result receipt. background=true returns the Session ID; wait for its terminal reminder, then use background_output for the receipt.",
  ].join("\n"),
  inputSchema: DelegateInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  execute: executeDelegate,
});
