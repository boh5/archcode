import { join } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";
import type { StoreApi } from "zustand";

import { HitlBoundaryCodec, ProjectHitlQueue } from "../hitl";
import { MemoryFileManager } from "../memory/file-manager";
import { silentLogger } from "../logger";
import { ProjectTodoService } from "../todos";
import type { ProjectContextResolverOptions } from "../projects/context-resolver";
import type { ProjectContext } from "../projects/types";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import { ProjectApprovalManager } from "./permission";
import { SecretRedactionPolicy } from "../security";

const TEST_HITL_CODEC = new HitlBoundaryCodec(new SecretRedactionPolicy([]));

export function createTestHitlCodec(): HitlBoundaryCodec {
  return new HitlBoundaryCodec(new SecretRedactionPolicy([]));
}

export function createTestProjectContext(
  workspaceRoot: string,
  _sessions = new SessionStoreManager({ logger: silentLogger }),
): ProjectContext {
  const project = {
    slug: "test-project",
    name: "Test Project",
    workspaceRoot,
    addedAt: new Date().toISOString(),
  };
  const hitl = new ProjectHitlQueue({ workspaceRoot, codec: TEST_HITL_CODEC });
  const todos = createTestProjectTodoService(workspaceRoot, project.slug);
  return {
    project,
    createAutomation: async () => { throw new Error("Automation creation is not configured for this test context"); },
    todos,
    hitl,
    memory: new MemoryFileManager({
      project: join(workspaceRoot, PROJECT_STATE_DIR_NAME, "memory"),
      user: join(workspaceRoot, PROJECT_STATE_DIR_NAME, "user-memory"),
    }),
    approvals: new ProjectApprovalManager(silentLogger),
  };
}

export function createTestProjectContextResolverOptions(
  _sessionStoreManager: SessionStoreManager,
): ProjectContextResolverOptions {
  return {
    hitlCodec: TEST_HITL_CODEC,
    projectInfoFactory: (workspaceRoot) => ({
      slug: "test-project",
      name: "Test Project",
      workspaceRoot,
      addedAt: new Date().toISOString(),
    }),
    projectTodoFactory: ({ workspaceRoot, project }) => createTestProjectTodoService(workspaceRoot, project.slug),
    createAutomation: async () => { throw new Error("Automation creation is not configured for this test resolver"); },
  };
}

export function createTestProjectTodoService(workspaceRoot: string, projectSlug: string): ProjectTodoService {
  return new ProjectTodoService({
    workspaceRoot,
    projectSlug,
    sessions: {
      ensureRootSession: async () => {},
      ensureExecution: async () => {},
      acquireIdleFamily: async () => ({ release: () => {} }),
    },
    provenance: { listResources: async () => [] },
  });
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
  const store = storeManager.create(sessionId, workspaceRoot, { cwd, agentName: "lead" });
  await storeManager.flushSession(sessionId, workspaceRoot);

  const projectContext = createTestProjectContext(workspaceRoot, storeManager);

  return { projectContext, store, storeManager };
}
