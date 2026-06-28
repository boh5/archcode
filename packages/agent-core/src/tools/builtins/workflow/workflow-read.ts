import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import { WorkflowPathError, WorkflowUuidSchema } from "../../../agents/workflow/state";
import { formatCompactWorkflowOutput } from "./compact-output";

const WorkflowReadInputSchema = z.strictObject({
  workflowId: WorkflowUuidSchema.describe("The workflow id (uuid) to read"),
});

type WorkflowReadInput = z.infer<typeof WorkflowReadInputSchema>;

export function createWorkflowReadTool(): AnyToolDescriptor {
  return defineTool({
    name: "workflow_read",
    description: "Read workflow state by workflow id.",
    inputSchema: WorkflowReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (input: WorkflowReadInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const stateManager = ctx.projectContext.workflowState;
      try {
        const state = await stateManager.read(input.workflowId);
        return JSON.stringify(formatCompactWorkflowOutput(state), null, 2);
      } catch (error) {
        if (error instanceof WorkflowPathError) {
          return createToolErrorResult({
            kind: "workspace",
            code: "TOOL_WORKFLOW_INVALID_ID",
            message: error.message,
          });
        }
        if (isNotFoundError(error)) {
          return createToolErrorResult({
            kind: "file-not-found",
            code: "TOOL_FILE_NOT_FOUND",
            message: `Workflow not found: ${input.workflowId}`,
          });
        }
        return createToolErrorResult({
          kind: "execution",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
  });
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export { WorkflowReadInputSchema };
