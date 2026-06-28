export { createArtifactReadTool, ArtifactReadInputSchema } from "./artifact-read";
export { createArtifactWriteTool, WorkflowArtifactWriteInputSchema } from "./artifact-write";
export { createWorkflowCompleteTool, WorkflowCompleteInputSchema } from "./workflow-complete";
export { createWorkflowCreateTool, WorkflowCreateInputSchema } from "./workflow-create";
export { createWorkflowProposeInteractionsTool, WorkflowProposeInteractionsInputSchema, WorkflowInteractionProposalSchema } from "./workflow-propose-interactions";
export { createWorkflowReadTool, WorkflowReadInputSchema } from "./workflow-read";
export { createWorkflowRecordCompletionTool, WorkflowRecordCompletionInputSchema } from "./workflow-record-completion";
export { createWorkflowRequestInteractionsTool, WorkflowRequestInteractionsInputSchema } from "./workflow-request-interactions";
export { createWorkflowTaskCheckTool, WorkflowTaskCheckInputSchema } from "./workflow-task-check";
import type { AnyToolDescriptor, ToolExecutionResult } from "../../types";
import { formatCompactWorkflowJsonOutput } from "./compact-output";
import { createWorkflowUpdateStageTool as createWorkflowUpdateStageToolBase, WorkflowUpdateStageInputSchema } from "./workflow-update-stage";

export { WorkflowUpdateStageInputSchema };

export function createWorkflowUpdateStageTool(): AnyToolDescriptor {
  const descriptor = createWorkflowUpdateStageToolBase();
  return {
    ...descriptor,
    hooks: {
      before: descriptor.hooks?.before,
      after: [
        ...(descriptor.hooks?.after ?? []),
        (result: ToolExecutionResult): ToolExecutionResult | void => {
          if (result.isError) return undefined;
          const compactOutput = formatCompactWorkflowJsonOutput(result.output, {
            message: "Updated workflow stage.",
          });
          if (!compactOutput) return undefined;
          return { ...result, output: compactOutput };
        },
      ],
    },
  };
}
