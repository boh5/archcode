import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import { emitWorkflowStateChange } from "../../../agents/workflow/events";
import { createWorkflowWithOrchestrator } from "../../../agents/workflow/linking";
import { WorkflowPathError, WorkflowTypeSchema } from "../../../agents/workflow/state";

const WorkflowCreateInputSchema = z.strictObject({
  id: z.string().min(1),
  type: WorkflowTypeSchema,
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
      try {
        const { workflow: state } = await createWorkflowWithOrchestrator(
          { id: input.id, type: input.type, orchestratorSessionId },
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
