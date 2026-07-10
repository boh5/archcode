import { join } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";
import type { StoreApi } from "zustand";

import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { LoopStateManager } from "../loops/state";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import type { ProjectContext } from "../projects/types";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
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

export interface DurableTestSessionContext {
  readonly projectContext: ProjectContext;
  readonly store: StoreApi<SessionStoreState>;
  readonly storeManager: SessionStoreManager;
}

/** Creates a persisted Session and loaded project context for durable HITL tests. */
export async function createDurableTestSessionContext(
  workspaceRoot: string,
  sessionId = crypto.randomUUID(),
  cwd = workspaceRoot,
): Promise<DurableTestSessionContext> {
  const storeManager = new SessionStoreManager({ logger: silentLogger });
  const store = storeManager.create(sessionId, workspaceRoot, { cwd });
  await storeManager.flushSession(sessionId, workspaceRoot);

  const projectContext = createTestProjectContext(workspaceRoot);
  await projectContext.hitl.load(workspaceRoot);

  return { projectContext, store, storeManager };
}
