import type { WorkflowArtifactManager } from "../../../agents/workflow/artifacts";
import type { WorkflowStateManager } from "../../../agents/workflow/state";
import type { ProjectContext } from "../../../projects/types";

export interface LegacyWorkflowProjectContext extends ProjectContext {
  workflowState: WorkflowStateManager;
  artifacts: WorkflowArtifactManager;
}

export function legacyWorkflowProjectContext(ctx: ProjectContext): LegacyWorkflowProjectContext {
  return ctx as LegacyWorkflowProjectContext;
}
