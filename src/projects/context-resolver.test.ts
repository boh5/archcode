import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { WorkflowArtifactManager } from "../agents/workflow/artifacts";
import { WorkflowStateManager } from "../agents/workflow/state";
import { MemoryFileManager } from "../memory/file-manager";
import type { PermissionApprovalScope } from "../tools/permission/policy-types";
import { ProjectApprovalManager } from "../tools/permission/project-approvals";
import { ProjectContextResolver } from "./context-resolver";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "context-resolver");

const TEST_SCOPE: PermissionApprovalScope = {
  kind: "tool-operation",
  toolName: "file_write",
  operation: "write",
};

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

describe("ProjectContextResolver", () => {
  test("resolve returns the same context object for the same workspace", async () => {
    const workspace = await makeWorkspace("identity");
    const resolver = new ProjectContextResolver();

    const first = await resolver.resolve(workspace);
    const second = await resolver.resolve(workspace);

    expect(first).toBe(second);
  });

  test("different workspaces produce different contexts and approval managers", async () => {
    const workspaceA = await makeWorkspace("workspace-a");
    const workspaceB = await makeWorkspace("workspace-b");
    const resolver = new ProjectContextResolver();

    const contextA = await resolver.resolve(workspaceA);
    const contextB = await resolver.resolve(workspaceB);

    expect(contextA).not.toBe(contextB);
    expect(contextA.approvals).not.toBe(contextB.approvals);
  });

  test("dispose removes the cached context so the next resolve creates a fresh context", async () => {
    const workspace = await makeWorkspace("dispose");
    const resolver = new ProjectContextResolver();

    const first = await resolver.resolve(workspace);
    resolver.dispose(workspace);
    const second = await resolver.resolve(workspace);

    expect(second).not.toBe(first);
    expect(second.workflowState).not.toBe(first.workflowState);
    expect(second.memory).not.toBe(first.memory);
    expect(second.approvals).not.toBe(first.approvals);
  });

  test("concurrent resolve calls load approvals once per unique workspace", async () => {
    const workspaceA = await makeWorkspace("concurrent-a");
    const workspaceB = await makeWorkspace("concurrent-b");
    const loadCalls: string[] = [];
    const loadMock = mock(async (manager: ProjectApprovalManager, workspaceRoot: string) => {
      loadCalls.push(workspaceRoot);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await ProjectApprovalManager.prototype.load.call(manager, workspaceRoot);
    });

    class CountingProjectApprovalManager extends ProjectApprovalManager {
      override async load(workspaceRoot: string): Promise<void> {
        await loadMock(this, workspaceRoot);
      }
    }

    const resolver = new ProjectContextResolver({
      approvalsFactory: () => new CountingProjectApprovalManager(),
    });

    const [firstA, secondA, firstB] = await Promise.all([
      resolver.resolve(workspaceA),
      resolver.resolve(workspaceA),
      resolver.resolve(workspaceB),
    ]);

    expect(firstA).toBe(secondA);
    expect(firstA).not.toBe(firstB);
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(loadCalls.filter((workspace) => workspace === workspaceA)).toHaveLength(1);
    expect(loadCalls.filter((workspace) => workspace === workspaceB)).toHaveLength(1);
  });

  test("isolation scenario keeps approvals scoped to their workspace", async () => {
    const workspaceA = await makeWorkspace("isolation-a");
    const workspaceB = await makeWorkspace("isolation-b");
    const resolver = new ProjectContextResolver();

    const contextA = await resolver.resolve(workspaceA);
    const contextB = await resolver.resolve(workspaceB);

    await contextA.approvals.addApproval(TEST_SCOPE, {
      display: "Test approval",
      reason: "Verify project isolation",
    });

    expect(contextA.approvals.hasApproval(TEST_SCOPE)).toBe(true);
    expect(contextB.approvals.hasApproval(TEST_SCOPE)).toBe(false);
    expect((await resolver.resolve(workspaceB)).approvals.hasApproval(TEST_SCOPE)).toBe(false);
  });

  test("default factories create the expected manager roots and placeholder project info", async () => {
    const workspace = await makeWorkspace("defaults");
    const resolver = new ProjectContextResolver();

    const context = await resolver.resolve(workspace);

    expect(context.workflowState).toBeInstanceOf(WorkflowStateManager);
    expect(context.artifacts).toBeInstanceOf(WorkflowArtifactManager);
    expect(context.memory).toBeInstanceOf(MemoryFileManager);
    expect(context.memory.projectRoot).toBe(join(workspace, ".specra", "memory"));
    expect(context.project.slug).toBe(basename(workspace));
    expect(context.project.name).toBe(context.project.slug);
    expect(context.project.workspaceRoot).toBe(workspace);
    expect(context.project.lastOpenedAt).toBeUndefined();
    expect(new Date(context.project.addedAt).toString()).not.toBe("Invalid Date");
  });
});
