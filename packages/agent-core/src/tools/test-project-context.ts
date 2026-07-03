import { join } from "node:path";

import { GoalArtifactManager } from "../goals/artifacts";
import { GoalMemoryManager } from "../goals/goal-memory";
import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import type { ProjectContext } from "../projects/types";
import { ProjectApprovalManager } from "./permission";

export function createTestProjectContext(workspaceRoot: string): ProjectContext {
  return {
    project: {
      slug: "test-project",
      name: "Test Project",
      workspaceRoot,
      addedAt: new Date().toISOString(),
    },
    goalState: new GoalStateManager(workspaceRoot),
    goalArtifacts: new GoalArtifactManager(workspaceRoot),
    goalMemory: new GoalMemoryManager(workspaceRoot),
    hitl: new HitlService(),
    memory: new MemoryFileManager({
      project: join(workspaceRoot, ".archcode", "memory"),
      user: join(workspaceRoot, ".archcode", "user-memory"),
    }),
    approvals: new ProjectApprovalManager(silentLogger),
  };
}
