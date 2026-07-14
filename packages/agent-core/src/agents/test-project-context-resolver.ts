import { silentLogger } from "../logger";
import { ProjectContextResolver } from "../projects/context-resolver";
import type { SessionStoreManager } from "../store/session-store-manager";
import { createTestGoalLifecycle } from "../tools/test-project-context";

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
    goalLifecycleFactory: ({ workspaceRoot, goalState }) => (
      createTestGoalLifecycle(workspaceRoot, goalState, sessionStoreManager)
    ),
    createAutomation: async () => { throw new Error("Automation creation is not configured for this test resolver"); },
    logger: silentLogger,
  });
}
