import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import { emitWorkflowStateChange } from "../../../agents/workflow/events";
import { WorkflowPathError, WorkflowStageSchema } from "../../../agents/workflow/state";

const WorkflowRecordCompletionInputSchema = z.strictObject({
  workflowId: z.string().min(1),
  stage: WorkflowStageSchema,
  criticPassed: z.boolean().optional(),
  evidence: z.array(z.string()).optional(),
});

type WorkflowRecordCompletionInput = z.infer<typeof WorkflowRecordCompletionInputSchema>;

export function createWorkflowRecordCompletionTool(): AnyToolDescriptor {
  return defineTool({
    name: "workflow_record_completion",
    description: "Record completion metadata for a workflow stage. You MUST call this before advancing forward with workflow_update_stage. The transition guard rejects forward moves from stages with no completion record.",
    inputSchema: WorkflowRecordCompletionInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: WorkflowRecordCompletionInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const stateManager = ctx.projectContext.workflowState;
      try {
        const state = await stateManager.recordStageCompletion(input.workflowId, {
          stage: input.stage,
          criticPassed: input.criticPassed,
          evidence: input.evidence,
        });
        emitWorkflowStateChange(ctx.store, state.id, ["stageCompletions"]);
        return JSON.stringify(state, null, 2);
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

export { WorkflowRecordCompletionInputSchema };
