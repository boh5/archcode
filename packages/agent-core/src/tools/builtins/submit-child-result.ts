import type { ChildResult, ChildResultReceipt } from "@archcode/protocol";
import { ChildResultSchema } from "../../delegation/schema";
import { validateChildResultAgainstContract } from "../../delegation/contract";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";

export const SubmitChildResultInputSchema = ChildResultSchema;

export async function executeSubmitChildResult(
  input: ChildResult,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const workspaceRoot = ctx.projectContext.project.workspaceRoot;
  const sessionId = ctx.store.getState().sessionId;

  try {
    const receipt = await ctx.storeManager.commitDurableSessionMutation(
      sessionId,
      workspaceRoot,
      (state) => {
        if (state.parentSessionId === undefined) {
          throw new Error("submit_child_result is only valid in a delegated child Session");
        }
        if (state.delegationContract === undefined || state.delegationContractHash === undefined) {
          throw new Error("Child Session is missing its V2 delegation identity");
        }
        if (state.currentExecutionId === undefined || !state.isRunning) {
          throw new Error("submit_child_result requires a running child Execution");
        }
        if (state.childResultReceipts.some((item) => item.executionId === state.currentExecutionId)) {
          throw new Error(`Execution ${state.currentExecutionId} already submitted a child result`);
        }

        validateChildResultAgainstContract(input, state.delegationContract);
        const receipt: ChildResultReceipt = {
          executionId: state.currentExecutionId,
          delegationContractHash: state.delegationContractHash,
          submittedAt: Date.now(),
          result: input,
        };
        return {
          result: receipt,
          events: [{ type: "child-result", receipt }],
        };
      },
    );

    return {
      output: JSON.stringify(receipt),
      isError: false,
      meta: {
        childResultReceipt: receipt,
        executionControl: {
          action: "complete_execution",
          reason: "child_result_submitted",
        },
      },
    };
  } catch (error) {
    const safeError = error instanceof Error ? error : new Error(String(error));
    if (ctx.structuredResultCorrection !== undefined) {
      return ctx.structuredResultCorrection.recordFailure(safeError);
    }
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_SUBMIT_CHILD_RESULT_FAILED",
      name: safeError.name,
      message: safeError.message,
      error: safeError,
    });
  }
}

export const submitChildResultTool = defineTool({
  name: "submit_child_result",
  description: [
    "Submit the canonical result for the current delegated child Execution.",
    "This is a terminal action: after a successful submission the Execution completes immediately, so emit no more text or tool calls.",
    "Report every original acceptance criterion exactly once in criteria. completed requires every criterion to pass and no blocking unresolved item.",
  ].join("\n"),
  inputSchema: SubmitChildResultInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  execute: executeSubmitChildResult,
});
