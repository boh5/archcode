import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import { emitWorkflowStateChange } from "../../../agents/workflow/events";
import { canCompleteWorkflow } from "../../../agents/workflow/guards";
import { WorkflowArtifactKindSchema, WorkflowPathError, WorkflowUuidSchema } from "../../../agents/workflow/state";
import { guardCurrentWorkflow } from "./guard-current-workflow";

const WorkflowCompleteInputSchema = z.strictObject({
  workflowId: WorkflowUuidSchema.describe("The workflow id (uuid) to complete"),
});

type WorkflowCompleteInput = z.infer<typeof WorkflowCompleteInputSchema>;

export function createWorkflowCompleteTool(): AnyToolDescriptor {
  return defineTool({
    name: "workflow_complete",
    description: "Complete a workflow after its type-specific completion policy is satisfied.",
    inputSchema: WorkflowCompleteInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: WorkflowCompleteInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const stateManager = ctx.projectContext.workflowState;
      const artifactManager = ctx.projectContext.artifacts;
      const guardResult = guardCurrentWorkflow(input.workflowId, ctx, "workflow_complete");
      if (guardResult) return guardResult;

      try {
        const currentState = await stateManager.read(input.workflowId);
        const availableArtifacts = new Set<string>();
        for (const kind of WorkflowArtifactKindSchema.options) {
          const artifactPath = currentState.artifacts[kind];
          if (typeof artifactPath !== "string") continue;
          try {
            await artifactManager.read(input.workflowId, artifactPath);
            availableArtifacts.add(kind);
          } catch (error) {
            if (!isNotFoundError(error)) throw error;
          }
        }

        const completion = canCompleteWorkflow(currentState, (kind) => availableArtifacts.has(kind));
        if (!completion.allowed) {
          return createToolErrorResult({
            kind: "execution",
            code: "TOOL_WORKFLOW_COMPLETION_DENIED",
            name: completion.errorName,
            message: completion.error ?? "Workflow completion denied",
          });
        }

        const state = await stateManager.complete(input.workflowId);
        emitWorkflowStateChange(ctx.store, state.id, ["status"]);
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

export { WorkflowCompleteInputSchema };
