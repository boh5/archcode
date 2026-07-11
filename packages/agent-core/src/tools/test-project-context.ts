import { join } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";
import type { StoreApi } from "zustand";

import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { createPreparedHitlResume, ResumeCoordinator } from "../hitl/resume-coordinator";
import { LoopStateManager } from "../loops/state";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import type { ProjectContextResolverOptions } from "../projects/context-resolver";
import type { ProjectContext } from "../projects/types";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import { ProjectApprovalManager } from "./permission";

export function createTestProjectContext(
  workspaceRoot: string,
  sessions = new SessionStoreManager({ logger: silentLogger }),
): ProjectContext {
  const project = {
    slug: "test-project",
    name: "Test Project",
    workspaceRoot,
    addedAt: new Date().toISOString(),
  };
  const goalState = new GoalStateManager(workspaceRoot);
  const loopState = new LoopStateManager(workspaceRoot);
  const hitl = new HitlService({ workspaceRoot, project, sessions, goalState, loopState });
  return {
    project,
    goalState,
    goalCancellation: createTestGoalCancellation(goalState),
    loopState,
    hitl,
    hitlResumeCoordinator: createTestResumeCoordinator(hitl),
    memory: new MemoryFileManager({
      project: join(workspaceRoot, PROJECT_STATE_DIR_NAME, "memory"),
      user: join(workspaceRoot, PROJECT_STATE_DIR_NAME, "user-memory"),
    }),
    approvals: new ProjectApprovalManager(silentLogger),
  };
}

export function createTestProjectContextResolverOptions(
  sessionStoreManager: SessionStoreManager,
): ProjectContextResolverOptions {
  return {
    projectInfoFactory: (workspaceRoot) => ({
      slug: "test-project",
      name: "Test Project",
      workspaceRoot,
      addedAt: new Date().toISOString(),
    }),
    goalCancellationFactory: ({ goalState }) => createTestGoalCancellation(goalState),
    sessionStoreManager,
    resumeCoordinatorFactory: ({ hitl }) => createTestResumeCoordinator(hitl),
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
  const store = storeManager.create(sessionId, workspaceRoot, { cwd, agentName: "engineer" });
  await storeManager.flushSession(sessionId, workspaceRoot);

  const projectContext = createTestProjectContext(workspaceRoot, storeManager);

  return { projectContext, store, storeManager };
}

function createTestGoalCancellation(goalState: GoalStateManager): ProjectContext["goalCancellation"] {
  return {
    cancel: async (goalId, request) => await goalState.cancel(goalId, request.reason),
  };
}

function createTestResumeCoordinator(hitl: HitlService): ResumeCoordinator {
  return new ResumeCoordinator({
    hitl,
    adapters: {
      session: { prepare: async () => createPreparedHitlResume(async () => undefined) },
      goal: { prepare: async () => createPreparedHitlResume(async () => undefined) },
      loop: { prepare: async () => createPreparedHitlResume(async () => undefined) },
    },
    logger: silentLogger,
  });
}
