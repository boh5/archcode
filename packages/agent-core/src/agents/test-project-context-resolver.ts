import { silentLogger } from "../logger";
import { ProjectContextResolver } from "../projects/context-resolver";
import type { SessionStoreManager } from "../store/session-store-manager";
import { createTestHitlCodec, createTestProjectTodoService } from "../tools/test-project-context";

/** Builds the complete project-context composition required by Agent tests. */
export function createTestProjectContextResolver(
  _sessionStoreManager: SessionStoreManager,
): ProjectContextResolver {
  return new ProjectContextResolver({
    hitlCodec: createTestHitlCodec(),
    projectInfoFactory: (workspaceRoot) => ({
      slug: "test-project",
      name: "Test Project",
      workspaceRoot,
      addedAt: new Date().toISOString(),
    }),
    projectTodoFactory: ({ workspaceRoot, project }) => (
      createTestProjectTodoService(workspaceRoot, project.slug)
    ),
    createAutomation: async () => { throw new Error("Automation creation is not configured for this test resolver"); },
    logger: silentLogger,
  });
}
