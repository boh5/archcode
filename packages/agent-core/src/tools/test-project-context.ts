import { join } from "node:path";

import { WorkflowArtifactManager } from "../agents/workflow/artifacts";
import { WorkflowStateManager } from "../agents/workflow/state";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import type { ProjectContext } from "../projects/types";
import { ProjectApprovalManager } from "./permission";

export function createTestProjectContext(workspaceRoot: string): ProjectContext {
  const workflowState = new WorkflowStateManager(workspaceRoot);
  return {
    project: {
      slug: "test-project",
      name: "Test Project",
      workspaceRoot,
      addedAt: new Date().toISOString(),
    },
    workflowState,
    memory: new MemoryFileManager({
      project: join(workspaceRoot, ".archcode", "memory"),
      user: join(workspaceRoot, ".archcode", "user-memory"),
    }),
    approvals: new ProjectApprovalManager(silentLogger),
    artifacts: new WorkflowArtifactManager(workspaceRoot, workflowState),
  };
}
