import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import type { WorkflowArtifactManager } from "../../../agents/workflow/artifacts";
import { emitWorkflowStateChange } from "../../../agents/workflow/events";
import {
  canTransitionTo,
  hasUnresolvedInteractions,
  type ArtifactKind,
} from "../../../agents/workflow/guards";
import {
  WorkflowPathError,
  WorkflowArtifactKindSchema,
  WorkflowStageSchema,
  WorkflowUuidSchema,
  type WorkflowStage,
} from "../../../agents/workflow/state";
import { getStagePrerequisitesForType } from "../../../agents/workflow/workflow-types";
import { validateTasksMarkdown } from "../../../agents/workflow/tasks-format";
import { guardCurrentWorkflow } from "./guard-current-workflow";
import { formatCompactWorkflowOutput } from "./compact-output";

const WorkflowUpdateStageInputSchema = z.strictObject({
  workflowId: WorkflowUuidSchema.describe("The workflow id (uuid) to update"),
  stage: WorkflowStageSchema.describe("Target stage to advance to. Ignored when status is provided (but still required by schema)."),
  hasUserApproval: z.boolean().default(false).describe("Whether the user has explicitly approved this stage transition. Default false."),
  status: z.enum(["failed", "paused"]).optional().describe("When set, records a terminal lifecycle update (failed or paused) instead of a plain stage advance. Use this for Critic rejection, user withholding approval, or retry exhaustion."),
  lastError: z.string().optional().describe("Error/reason message to persist when status is failed or paused."),
  incrementRetry: z.boolean().default(false).describe("Increment the workflow's retry counter for the current stage. Default false."),
});

type WorkflowUpdateStageInput = z.infer<typeof WorkflowUpdateStageInputSchema>;

export function createWorkflowUpdateStageTool(): AnyToolDescriptor {
  return defineTool({
    name: "workflow_update_stage",
    description: "Update workflow stage or record a terminal lifecycle status. You MUST record completion of the current stage with workflow_record_completion before advancing forward. For terminal lifecycle updates (Critic rejection, user withholding approval, retry exhaustion), use the status parameter with 'failed' or 'paused' and a lastError reason.",
    inputSchema: WorkflowUpdateStageInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: WorkflowUpdateStageInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const stateManager = ctx.projectContext.workflowState;
      const artifactManager = ctx.projectContext.artifacts;
      const guardResult = guardCurrentWorkflow(input.workflowId, ctx, "workflow_update_stage");
      if (guardResult) return guardResult;

      try {
        const currentState = await stateManager.read(input.workflowId);
        if (input.status) {
          if (input.status === "failed") {
            const state = await stateManager.fail(input.workflowId, input.lastError ?? "Workflow failed");
            emitWorkflowStateChange(ctx.store, state.id, ["status", "lastError"]);
            return JSON.stringify(formatCompactWorkflowOutput(state, { message: `Workflow ${input.status}: ${input.lastError ?? "Workflow failed"}` }), null, 2);
          }
          if (input.status === "paused") {
            let state = await stateManager.updateStatus(input.workflowId, "paused");
            if (input.lastError) {
              state = await stateManager.updateLastError(input.workflowId, input.lastError);
            }
            emitWorkflowStateChange(ctx.store, state.id, ["status", "lastError"]);
            return JSON.stringify(formatCompactWorkflowOutput(state, { message: `Workflow paused: ${input.lastError ?? "Workflow paused"}` }), null, 2);
          }
        }

        const artifactAvailability = await collectAvailableArtifacts(input.workflowId, currentState.artifacts, artifactManager);
        const transition = canTransitionTo({
          id: currentState.id,
          type: currentState.type,
          status: currentState.status,
          stage: currentState.stage,
          retryCount: input.incrementRetry ? currentState.retryCount + 1 : currentState.retryCount,
          maxRetries: currentState.maxRetries,
        }, input.stage as WorkflowStage, {
          hasArtifact: (kind: string) => artifactAvailability.available.has(kind as ArtifactKind),
          hasStageCompletion: (stage: WorkflowStage) => Boolean(currentState.stageCompletions[stage]),
          hasUnresolvedInteractions: (stage: WorkflowStage) => hasUnresolvedInteractions(currentState, stage),
          hasUserApproval: input.hasUserApproval,
        });
        if (!transition.allowed) {
          const invalidArtifactResult = createInvalidArtifactTransitionResult({
            workflowId: input.workflowId,
            targetStage: input.stage as WorkflowStage,
            currentType: currentState.type,
            transitionError: transition.error,
            invalidArtifacts: artifactAvailability.invalid,
          });
          if (invalidArtifactResult) return invalidArtifactResult;

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
): Promise<ArtifactAvailability> {
  const available = new Set<ArtifactKind>();
  const invalid = new Map<ArtifactKind, InvalidArtifactReason>();
  for (const kind of WorkflowArtifactKindSchema.options) {
    const artifactPath = artifacts[kind];
    if (typeof artifactPath !== "string") continue;
    try {
      const artifact = await artifactManager.read(workflowId, artifactPath);
      if (kind === "TASKS") {
        const validation = validateTasksMarkdown(artifact.body);
        if (validation.valid && validation.tasks.length > 0) {
          available.add(kind);
        } else {
          invalid.set(kind, {
            path: artifactPath,
            taskCount: validation.tasks.length,
            errors: validation.errors,
          });
        }
      } else {
        available.add(kind);
      }
    } catch (error) {
      if (isNotFoundError(error)) continue;
      if (kind === "TASKS") {
        invalid.set(kind, {
          path: artifactPath,
          taskCount: 0,
          errors: [{ code: "INVALID_ARTIFACT_CONTENT", message: error instanceof Error ? error.message : String(error) }],
        });
        continue;
      }
      throw error;
    }
  }
  return { available, invalid };
}

interface ArtifactAvailability {
  available: Set<ArtifactKind>;
  invalid: Map<ArtifactKind, InvalidArtifactReason>;
}

interface InvalidArtifactReason {
  path: string;
  taskCount: number;
  errors: ArtifactValidationIssue[];
}

interface ArtifactValidationIssue {
  code?: string;
  message: string;
  line?: number;
  taskId?: string;
  field?: string;
  dependencyId?: string;
  taskIds?: string[];
}

function createInvalidArtifactTransitionResult({
  workflowId,
  targetStage,
  currentType,
  transitionError,
  invalidArtifacts,
}: {
  workflowId: string;
  targetStage: WorkflowStage;
  currentType: Parameters<typeof getStagePrerequisitesForType>[0];
  transitionError?: string;
  invalidArtifacts: ReadonlyMap<ArtifactKind, InvalidArtifactReason>;
}): ToolExecutionResult | undefined {
  if (!transitionError?.includes("missing required artifact(s)")) return undefined;

  const invalidPrerequisites = getStagePrerequisitesForType(currentType, targetStage)
    .filter((kind) => invalidArtifacts.has(kind as ArtifactKind)) as ArtifactKind[];
  if (invalidPrerequisites.length === 0) return undefined;

  const details = invalidPrerequisites.map((kind) => {
    const invalid = invalidArtifacts.get(kind)!;
    return {
      kind,
      path: invalid.path,
      taskCount: invalid.taskCount,
      errors: invalid.errors,
    };
  });

  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_WORKFLOW_INVALID_ARTIFACT",
    name: "WorkflowArtifactValidationError",
    message: `Workflow ${workflowId} cannot enter ${targetStage}: ${details.map(formatInvalidArtifactReason).join("; ")}`,
    details,
  });
}

function formatInvalidArtifactReason(detail: { kind: ArtifactKind; path: string; taskCount: number; errors: readonly ArtifactValidationIssue[] }): string {
  if (detail.taskCount === 0 && detail.errors.length === 0) {
    return `${detail.path} exists but is invalid: ${detail.kind} must contain at least one top-level task`;
  }
  if (detail.errors.length === 0) {
    return `${detail.path} exists but is invalid: ${detail.kind} must contain at least one top-level task`;
  }
  return `${detail.path} exists but is invalid: ${detail.errors.slice(0, 5).map(formatTasksValidationError).join("; ")}`;
}

function formatTasksValidationError(error: ArtifactValidationIssue): string {
  const location = error.line ? `line ${error.line}: ` : "";
  return `${location}${error.message}`;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export { WorkflowUpdateStageInputSchema };
