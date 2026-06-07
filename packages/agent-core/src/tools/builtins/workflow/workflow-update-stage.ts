import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import type { WorkflowArtifactManager } from "../../../agents/workflow/artifacts";
import {
  processCriticDecision,
  type CriticDecision,
} from "../../../agents/workflow/critic-protocol";
import { emitWorkflowStateChange } from "../../../agents/workflow/events";
import { canTransitionTo, type ArtifactKind } from "../../../agents/workflow/guards";
import {
  WorkflowPathError,
  WorkflowArtifactKindSchema,
  WorkflowStageSchema,
  WorkflowUuidSchema,
  type WorkflowStage,
} from "../../../agents/workflow/state";
import { validateTasksMarkdown } from "../../../agents/workflow/tasks-format";
import { guardCurrentWorkflow } from "./guard-current-workflow";

const WorkflowUpdateStageInputSchema = z.strictObject({
  workflowId: WorkflowUuidSchema,
  stage: WorkflowStageSchema,
  hasUserApproval: z.boolean().default(false),
  criticDecision: z.enum(["approved", "changes_requested", "rejected"]).optional(),
  criticReportPath: z.string().min(1).optional(),
  incrementRetry: z.boolean().default(false),
});

type WorkflowUpdateStageInput = z.infer<typeof WorkflowUpdateStageInputSchema>;

export function createWorkflowUpdateStageTool(): AnyToolDescriptor {
  return defineTool({
    name: "workflow_update_stage",
    description: "Update workflow stage. You MUST record completion of the current stage with workflow_record_completion before advancing forward. For all critic outcomes (approved, changes_requested, rejected), use the criticDecision parameter — the stage field is required but ignored when criticDecision is provided.",
    inputSchema: WorkflowUpdateStageInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: WorkflowUpdateStageInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const stateManager = ctx.projectContext.workflowState;
      const artifactManager = ctx.projectContext.artifacts;
      const guardResult = guardCurrentWorkflow(input.workflowId, ctx, "workflow_update_stage");
      if (guardResult) return guardResult;

      try {
        const currentState = await stateManager.read(input.workflowId);
        if (input.criticDecision) {
          const result = await processCriticDecision({
            workflowId: input.workflowId,
            decision: input.criticDecision as CriticDecision,
            criticReportPath: input.criticReportPath,
            currentStage: currentState.stage,
          }, stateManager);
          emitWorkflowStateChange(ctx.store, result.newState.id, ["stage", "status", "artifacts", "stageCompletions"]);
          return JSON.stringify(result, null, 2);
        }

        const availableArtifacts = await collectAvailableArtifacts(input.workflowId, currentState.artifacts, artifactManager);
        const transition = canTransitionTo({
          id: currentState.id,
          type: currentState.type,
          status: currentState.status,
          stage: currentState.stage,
          retryCount: input.incrementRetry ? currentState.retryCount + 1 : currentState.retryCount,
          maxRetries: currentState.maxRetries,
        }, input.stage as WorkflowStage, {
          hasArtifact: (kind: string) => availableArtifacts.has(kind as ArtifactKind),
          hasStageCompletion: (stage: WorkflowStage) => Boolean(currentState.stageCompletions[stage]),
          hasUserApproval: input.hasUserApproval,
        });
        if (!transition.allowed) {
          return createToolErrorResult({
            kind: "execution",
            code: "TOOL_WORKFLOW_TRANSITION_DENIED",
            name: transition.errorName,
            message: transition.error ?? "Workflow transition denied",
          });
        }

        if (input.incrementRetry) await stateManager.incrementRetryCount(input.workflowId);
        const state = await stateManager.updateStage(input.workflowId, input.stage as WorkflowStage);
        emitWorkflowStateChange(ctx.store, state.id, ["stage"]);
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

async function collectAvailableArtifacts(
  workflowId: string,
  artifacts: Partial<Record<z.infer<typeof WorkflowArtifactKindSchema>, string | string[]>>,
  artifactManager: WorkflowArtifactManager,
): Promise<Set<ArtifactKind>> {
  const available = new Set<ArtifactKind>();
  for (const kind of WorkflowArtifactKindSchema.options) {
    const artifactPath = artifacts[kind];
    if (typeof artifactPath !== "string") continue;
    try {
      const artifact = await artifactManager.read(workflowId, artifactPath);
      if (kind === "TASKS") {
        const validation = validateTasksMarkdown(artifact.body);
        if (validation.valid && validation.tasks.length > 0) available.add(kind);
      } else {
        available.add(kind);
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  return available;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export { WorkflowUpdateStageInputSchema };
