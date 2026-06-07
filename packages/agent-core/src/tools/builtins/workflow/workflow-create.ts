import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import { emitWorkflowStateChange } from "../../../agents/workflow/events";
import { createWorkflowWithOrchestrator } from "../../../agents/workflow/linking";
import { WorkflowInvalidIdError, WorkflowPathError, WorkflowStateError, WorkflowTitleSchema, WorkflowTypeSchema } from "../../../agents/workflow/state";

const WorkflowCreateInputSchema = z.strictObject({
  type: WorkflowTypeSchema,
  title: WorkflowTitleSchema,
});

type WorkflowCreateInput = z.infer<typeof WorkflowCreateInputSchema>;

export function createWorkflowCreateTool(): AnyToolDescriptor {
  return defineTool({
    name: "workflow_create",
    description: "Create a new workflow state with idle stage and active status.",
    inputSchema: WorkflowCreateInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: WorkflowCreateInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const stateManager = ctx.projectContext.workflowState;
      const orchestratorSessionId = ctx.store.getState().sessionId;

      // Block creation if the current workflow is still active or paused
      const currentWorkflowId = ctx.store.getState().workflowId;
      if (currentWorkflowId) {
        try {
          const currentWorkflow = await stateManager.read(currentWorkflowId);
          if (currentWorkflow.status === "active" || currentWorkflow.status === "paused") {
            return createToolErrorResult({
              kind: "workspace",
              code: "TOOL_WORKFLOW_ALREADY_ACTIVE",
              message:
                `A workflow is already ${currentWorkflow.status}. ` +
                `Current workflow: id=${currentWorkflow.id}, ` +
                `title="${currentWorkflow.title}", ` +
                `type=${currentWorkflow.type}, ` +
                `status=${currentWorkflow.status}. ` +
                `Continue the existing workflow instead of creating a new one.`,
            });
          }
        } catch (error) {
          // Stale workflowId: workflow may have been deleted or its files cleaned up.
          // Proceed with creating a new workflow.
          if (!(error instanceof WorkflowInvalidIdError || error instanceof WorkflowPathError || error instanceof WorkflowStateError)) {
            throw error;
          }
        }
      }

      try {
        const { workflow: state } = await createWorkflowWithOrchestrator(
          { title: input.title, type: input.type, orchestratorSessionId },
          stateManager,
          ctx.storeManager,
        );
        emitWorkflowStateChange(ctx.store, state.id, ["stage", "status", "sessionIds"]);
        return JSON.stringify(state, null, 2);
      } catch (error) {
        if (error instanceof WorkflowPathError) {
          return createToolErrorResult({
            kind: "workspace",
            code: "TOOL_WORKFLOW_INVALID_ID",
            message: error.message,
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

export { WorkflowCreateInputSchema };
