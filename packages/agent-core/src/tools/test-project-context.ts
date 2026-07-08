import { join } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { LoopStateManager } from "../loops/state";
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
    loopState: new LoopStateManager(workspaceRoot),
    hitl: new HitlService(),
    memory: new MemoryFileManager({
      project: join(workspaceRoot, PROJECT_STATE_DIR_NAME, "memory"),
      user: join(workspaceRoot, PROJECT_STATE_DIR_NAME, "user-memory"),
    }),
    approvals: new ProjectApprovalManager(silentLogger),
  };
}
