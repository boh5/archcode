import { createToolErrorResult } from "../../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";

export function guardCurrentWorkflow(
  inputWorkflowId: string,
  ctx: ToolExecutionContext,
  toolName: string,
): ToolExecutionResult | undefined {
  const currentWorkflowId = ctx.store.getState().workflowId;
  if (currentWorkflowId === inputWorkflowId) {
    return undefined;
  }

  if (currentWorkflowId) {
    return createToolErrorResult({
      kind: "workspace",
      code: "TOOL_WORKFLOW_WRONG_WORKFLOW",
      message: `${toolName} can only write to current workflow ${currentWorkflowId}, got ${inputWorkflowId}`,
      details: { requestedWorkflowId: inputWorkflowId, currentWorkflowId },
    });
  }

  return createToolErrorResult({
    kind: "workspace",
    code: "TOOL_WORKFLOW_WRONG_WORKFLOW",
    message: `${toolName} requires the current session to be linked to a workflow, got workflow ${inputWorkflowId}`,
    details: { requestedWorkflowId: inputWorkflowId },
  });
}
