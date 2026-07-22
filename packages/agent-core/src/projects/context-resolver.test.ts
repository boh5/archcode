import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { USER_DATA_DIR_NAME } from "@archcode/protocol";

import { HitlBoundaryCodec, ProjectHitlQueue } from "../hitl";
import { MemoryFileManager } from "../memory/file-manager";
import { SessionStoreManager } from "../store/session-store-manager";
import type { PermissionApprovalScope } from "../tools/permission/policy-types";
import { silentLogger } from "../logger";
import { ProjectTodoService } from "../todos";
import { ProjectApprovalManager } from "../tools/permission/project-approvals";
import { ProjectContextResolver, type ProjectContextResolverOptions } from "./context-resolver";
import { SecretRedactionPolicy } from "../security";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "context-resolver", crypto.randomUUID());

const TEST_SCOPE: PermissionApprovalScope = {
  kind: "tool-operation",
  toolName: "file_write",
  operation: "write",
};
const TEST_HITL_CODEC = new HitlBoundaryCodec(new SecretRedactionPolicy([]));

async function makeWorkspace(name: string): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true });
  return await mkdtemp(join(TMP_ROOT, `${name}-`));
}

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

function createResolver(overrides: Partial<ProjectContextResolverOptions> = {}): ProjectContextResolver {
  const sessions = new SessionStoreManager({ logger: silentLogger });
  return new ProjectContextResolver({
    ...overrides,
    hitlCodec: overrides.hitlCodec ?? TEST_HITL_CODEC,
    projectInfoFactory: overrides.projectInfoFactory ?? ((workspaceRoot) => {
      const name = basename(workspaceRoot);
      return { slug: name, name, workspaceRoot, addedAt: new Date().toISOString() };
    }),
    projectTodoFactory: overrides.projectTodoFactory ?? (({ workspaceRoot, project }) => new ProjectTodoService({
      workspaceRoot,
      projectSlug: project.slug,
      sessions: {
        ensureRootSession: async () => {},
        ensureExecution: async () => {},
        acquireIdleFamily: async () => ({ release: () => {} }),
      },
      provenance: { listResources: async () => [] },
    })),
    createAutomation: overrides.createAutomation ?? (async () => {
      throw new Error("Automation creation is not configured for this test resolver");
    }),
  });
}

describe("ProjectContextResolver", () => {
  test("resolve returns the same context object for the same workspace", async () => {
    const workspace = await makeWorkspace("identity");
    const resolver = createResolver();
    expect(await resolver.resolve(workspace)).toBe(await resolver.resolve(workspace));
  });

  test("different workspaces produce isolated contexts and approval managers", async () => {
    const workspaceA = await makeWorkspace("workspace-a");
    const workspaceB = await makeWorkspace("workspace-b");
    const resolver = createResolver();
    const contextA = await resolver.resolve(workspaceA);
    const contextB = await resolver.resolve(workspaceB);

    await contextA.approvals.addApproval(TEST_SCOPE, { display: "Test approval", reason: "Verify project isolation" });
    expect(contextA).not.toBe(contextB);
    expect(contextA.approvals).not.toBe(contextB.approvals);
    expect(contextA.approvals.hasApproval(TEST_SCOPE)).toBe(true);
    expect(contextB.approvals.hasApproval(TEST_SCOPE)).toBe(false);
  });

  test("dispose removes the cached context so the next resolve creates fresh managers", async () => {
    const workspace = await makeWorkspace("dispose");
    const resolver = createResolver();
    const first = await resolver.resolve(workspace);
    await resolver.dispose(workspace);
    const second = await resolver.resolve(workspace);

    expect(second).not.toBe(first);
    expect(second.hitl).not.toBe(first.hitl);
    expect(second.memory).not.toBe(first.memory);
    expect(second.todos).not.toBe(first.todos);
    expect(second.approvals).not.toBe(first.approvals);
  });

  test("concurrent resolve calls build one context per workspace", async () => {
    const workspaceA = await makeWorkspace("concurrent-a");
    const workspaceB = await makeWorkspace("concurrent-b");
    const loadMock = mock(async (manager: ProjectApprovalManager, workspaceRoot: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await ProjectApprovalManager.prototype.load.call(manager, workspaceRoot);
    });
    class CountingProjectApprovalManager extends ProjectApprovalManager {
      override async load(workspaceRoot: string): Promise<void> { await loadMock(this, workspaceRoot); }
    }
    const resolver = createResolver({ approvalsFactory: () => new CountingProjectApprovalManager(silentLogger) });
    const [firstA, secondA, firstB] = await Promise.all([
      resolver.resolve(workspaceA), resolver.resolve(workspaceA), resolver.resolve(workspaceB),
    ]);
    expect(firstA).toBe(secondA);
    expect(firstA).not.toBe(firstB);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  test("default factories expose the hard-cut project services", async () => {
    const workspace = await makeWorkspace("defaults");
    const context = await createResolver().resolve(workspace);
    const record = context as unknown as Record<string, unknown>;
    expect(context.hitl).toBeInstanceOf(ProjectHitlQueue);
    expect(context.memory).toBeInstanceOf(MemoryFileManager);
    expect(context.todos).toBeInstanceOf(ProjectTodoService);
    expect(context.memory.projectRoot).toBe(join(workspace, ".archcode", "runtime", "memory"));
    expect(context.memory.userRoot).toBe(join(homedir(), USER_DATA_DIR_NAME, "memory"));
    expect(record.goalArtifacts).toBeUndefined();
    expect(record.workflowState).toBeUndefined();
  });

  test("projectInfoFactory supplies registry-backed contexts", async () => {
    const workspace = await makeWorkspace("registry-info");
    const projectInfo = { slug: "registry-slug", name: "Registry Project", workspaceRoot: workspace, addedAt: new Date().toISOString() };
    const resolver = createResolver({ projectInfoFactory: mock(() => projectInfo) });
    expect((await resolver.resolve(workspace)).project).toEqual(projectInfo);
  });

  test("custom queue factory is used per resolved context", async () => {
    const workspace = await makeWorkspace("custom-factories");
    const queues: ProjectHitlQueue[] = [];
    const resolver = createResolver({
      hitlFactory: mock((input) => {
        const queue = new ProjectHitlQueue(input);
        queues.push(queue);
        return queue;
      }),
    });
    const context = await resolver.resolve(workspace);
    expect(context.hitl).toBe(queues[0]);
  });
});
