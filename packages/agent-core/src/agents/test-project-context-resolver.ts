import { createPreparedHitlResume, ResumeCoordinator } from "../hitl/resume-coordinator";
import { silentLogger } from "../logger";
import { ProjectContextResolver } from "../projects/context-resolver";
import type { SessionStoreManager } from "../store/session-store-manager";

/** Builds the complete project-context composition required by Agent tests. */
export function createTestProjectContextResolver(
  sessionStoreManager: SessionStoreManager,
): ProjectContextResolver {
  return new ProjectContextResolver({
    projectInfoFactory: (workspaceRoot) => ({
      slug: "test-project",
      name: "Test Project",
      workspaceRoot,
      addedAt: new Date().toISOString(),
    }),
    goalCancellationFactory: ({ goalState }) => ({
      cancel: async (goalId, request) => await goalState.cancel(goalId, request.reason),
    }),
    sessionStoreManager,
    resumeCoordinatorFactory: ({ hitl }) => new ResumeCoordinator({
      hitl,
      adapters: {
        session: { prepare: async () => createPreparedHitlResume(async () => undefined) },
        goal: { prepare: async () => createPreparedHitlResume(async () => undefined) },
        loop: { prepare: async () => createPreparedHitlResume(async () => undefined) },
      },
      logger: silentLogger,
    }),
    logger: silentLogger,
  });
}
