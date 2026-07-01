import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { MemoryFileManager } from "../memory/file-manager";
import type { PermissionApprovalScope } from "../tools/permission/policy-types";
import { silentLogger } from "../logger";
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
    expect(second.goalState).not.toBe(first.goalState);
    expect(second.hitl).not.toBe(first.hitl);
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
      approvalsFactory: () => new CountingProjectApprovalManager(silentLogger),
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

    expect(context.goalState).toBeInstanceOf(GoalStateManager);
    expect(context.hitl).toBeInstanceOf(HitlService);
    expect(context.memory).toBeInstanceOf(MemoryFileManager);
    expect(context.memory.projectRoot).toBe(join(workspace, ".archcode", "memory"));
    expect(context.project.slug).toBe(basename(workspace));
    expect(context.project.name).toBe(context.project.slug);
    expect(context.project.workspaceRoot).toBe(workspace);
    expect(context.project.lastOpenedAt).toBeUndefined();
    expect(new Date(context.project.addedAt).toString()).not.toBe("Invalid Date");
  });

  test("project contexts expose Goal/HITL services and no active Workflow managers", async () => {
    const workspace = await makeWorkspace("goal-hitl-shape");
    const resolver = new ProjectContextResolver();

    const context = await resolver.resolve(workspace);
    const contextRecord = context as unknown as Record<string, unknown>;

    expect(context.goalState).toBeInstanceOf(GoalStateManager);
    expect(context.hitl).toBeInstanceOf(HitlService);
    expect(contextRecord.workflowState).toBeUndefined();
    expect(contextRecord.artifacts).toBeUndefined();
  });

  test("goals are isolated under each workspace .archcode/goals directory", async () => {
    const workspaceA = await makeWorkspace("goals-a");
    const workspaceB = await makeWorkspace("goals-b");
    const resolver = new ProjectContextResolver();

    const contextA = await resolver.resolve(workspaceA);
    const contextB = await resolver.resolve(workspaceB);

    const goalA = await contextA.goalState.create(contextA.project.slug, "Goal A", "architect");
    const goalB = await contextB.goalState.create(contextB.project.slug, "Goal B", "architect");

    expect((await contextA.goalState.listGoals()).map((goal) => goal.id)).toEqual([goalA.id]);
    expect((await contextB.goalState.listGoals()).map((goal) => goal.id)).toEqual([goalB.id]);
    expect(await Bun.file(join(workspaceA, ".archcode", "goals", goalA.id, "goal.json")).exists()).toBe(true);
    expect(await Bun.file(join(workspaceB, ".archcode", "goals", goalB.id, "goal.json")).exists()).toBe(true);
    expect(await Bun.file(join(workspaceB, ".archcode", "goals", goalA.id, "goal.json")).exists()).toBe(false);
  });

  test("custom Goal/HITL factories are used per resolved context", async () => {
    const workspace = await makeWorkspace("custom-factories");
    const goalState = new GoalStateManager(workspace);
    const hitl = new HitlService({ submitHitlEvent: () => {} });
    const resolver = new ProjectContextResolver({
      goalStateFactory: mock((workspaceRoot: string) => {
        expect(workspaceRoot).toBe(workspace);
        return goalState;
      }),
      hitlFactory: mock(() => hitl),
    });

    const context = await resolver.resolve(workspace);

    expect(context.goalState).toBe(goalState);
    expect(context.hitl).toBe(hitl);
  });
});
