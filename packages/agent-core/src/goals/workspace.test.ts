import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { GoalStateManager } from "./state";
import { GoalWorkspaceService } from "./workspace";
import {
  managedWorktreeNames,
  WorktreeService,
  WorktreeServiceError,
  type WorktreeCreateResult,
} from "../worktrees";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-workspace");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

async function commitGoal(
  manager: GoalStateManager,
  input: { projectId: string; objective: string; acceptanceCriteria: string; useWorktree?: boolean },
) {
  return await manager.commit({
    id: crypto.randomUUID(),
    createdFromSessionId: crypto.randomUUID(),
    mainSessionId: crypto.randomUUID(),
    ...input,
  });
}

describe("GoalWorkspaceService", () => {
  test("creates one Goal-owned worktree and reuses it across retry preparation", async () => {
    const projectRoot = await createGitRepo("reuse");
    const manager = new GoalStateManager(projectRoot);
    const goal = await commitGoal(manager, {
      projectId: "project-a",
      objective: "Implement in isolation.",
      acceptanceCriteria: "All attempts use the same worktree.",
      useWorktree: true,
    });
    const service = new GoalWorkspaceService({ canonicalRoot: projectRoot, goalStateManager: manager });

    const first = await service.prepare(goal.id);
    const second = await service.prepare(goal.id);

    expect(first.cwd).not.toBe(projectRoot);
    expect(second.cwd).toBe(first.cwd);
    expect(second.goal.worktree).toEqual(first.goal.worktree);
    expect(second.goal.worktree?.branchName).toStartWith("archcode/goal/");
  });

  test("uses the canonical project root when worktree isolation is disabled", async () => {
    const projectRoot = resolve(TMP_DIR, "plain-project");
    await mkdir(projectRoot, { recursive: true });
    const manager = new GoalStateManager(projectRoot);
    const goal = await commitGoal(manager, {
      projectId: "project-a",
      objective: "Run normally.",
      acceptanceCriteria: "No Git repository is required.",
    });

    await expect(new GoalWorkspaceService({ canonicalRoot: projectRoot, goalStateManager: manager }).prepare(goal.id))
      .resolves.toMatchObject({ cwd: projectRoot, goal: { useWorktree: false } });
  });

  test("reports an incomplete Git rollback when Goal claim persistence fails after detach", async () => {
    const projectRoot = resolve(TMP_DIR, "rollback-warning");
    await mkdir(projectRoot, { recursive: true });
    const persisted = new GoalStateManager(projectRoot);
    const goal = await commitGoal(persisted, {
      projectId: "project-a",
      objective: "Fail the durable claim.",
      acceptanceCriteria: "An orphan branch is reported instead of hidden.",
      useWorktree: true,
    });
    const branchName = managedWorktreeNames({ owner: { type: "goal", id: goal.id } }).branchName;
    const baseSha = "a".repeat(40);
    const worktreePath = resolve(TMP_DIR, "rollback-warning-worktree");
    const persistError = new Error("state write failed");
    const remove = mock(async () => ({
      detached: true as const,
      branchDeleted: false,
      warning: {
        code: "BRANCH_DELETE_FAILED" as const,
        branchName,
        message: "branch remains",
      },
    }));
    const service = new GoalWorkspaceService({
      canonicalRoot: projectRoot,
      goalStateManager: {
        read: (goalId) => persisted.read(goalId),
        setWorktree: async () => { throw persistError; },
      },
      worktreeService: {
        findManaged: mock(async () => undefined),
        validateManagedClaim: mock(async () => { throw new Error("unused"); }),
        create: mock(async () => ({
          canonicalRoot: projectRoot,
          managedRoot: resolve(TMP_DIR, "managed"),
          worktreePath,
          worktreeName: "goal-rollback-warning",
          branchName,
          baseSha,
          resolvedHeadSha: baseSha,
          canonicalStatus: { dirty: false, entries: [] },
        })),
        remove,
      },
    });

    let failure: unknown;
    try {
      await service.prepare(goal.id);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "GoalWorkspaceError",
      message: "Failed to persist the Goal worktree and fully roll back its Git resources",
      cause: { name: "AggregateError" },
    });
    expect((failure as { cause: AggregateError }).cause.errors[0]).toBe(persistError);
    expect((failure as { cause: AggregateError }).cause.errors[1]).toMatchObject({
      name: "WorktreeServiceError",
      code: "GIT_COMMAND_FAILED",
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("adopts a deterministic Goal worktree left behind before state persistence", async () => {
    const projectRoot = await createGitRepo("adopt-after-crash");
    const manager = new GoalStateManager(projectRoot);
    const goal = await commitGoal(manager, {
      projectId: "project-a",
      objective: "Recover an interrupted worktree claim.",
      acceptanceCriteria: "Preparation adopts the already-created managed worktree.",
      useWorktree: true,
    });
    const orphan = await new WorktreeService({ canonicalRoot: projectRoot }).create({
      owner: { type: "goal", id: goal.id },
    });

    const prepared = await new GoalWorkspaceService({ canonicalRoot: projectRoot, goalStateManager: manager }).prepare(goal.id);

    expect(prepared.cwd).toBe(orphan.worktreePath);
    expect(prepared.goal.worktree).toMatchObject({
      path: orphan.worktreePath,
      branchName: orphan.branchName,
      baseSha: orphan.resolvedHeadSha,
    });
  });

  test("refuses to launder a clean committed orphan into the Goal creation base", async () => {
    const projectRoot = await createGitRepo("reject-changed-orphan");
    const manager = new GoalStateManager(projectRoot);
    const goal = await commitGoal(manager, {
      projectId: "project-a",
      objective: "Preserve ambiguous orphan changes.",
      acceptanceCriteria: "A changed pre-claim worktree is never adopted as a fresh base.",
      useWorktree: true,
    });
    const orphan = await new WorktreeService({ canonicalRoot: projectRoot }).create({
      owner: { type: "goal", id: goal.id },
    });
    await writeFile(join(orphan.worktreePath, "unexpected.txt"), "unexpected commit\n");
    await git(orphan.worktreePath, ["add", "unexpected.txt"]);
    await git(orphan.worktreePath, ["commit", "-m", "unexpected orphan commit"]);

    await expect(new GoalWorkspaceService({ canonicalRoot: projectRoot, goalStateManager: manager }).prepare(goal.id))
      .rejects.toMatchObject({ code: "WORKTREE_CHANGED" });
    expect((await manager.read(goal.id)).worktree).toBeUndefined();
  });

  test("refuses orphan adoption after canonical HEAD advances without write-ahead base metadata", async () => {
    const projectRoot = await createGitRepo("reject-orphan-after-canonical-advance");
    const manager = new GoalStateManager(projectRoot);
    const goal = await commitGoal(manager, {
      projectId: "project-a",
      objective: "Fail closed when the orphan base is ambiguous.",
      acceptanceCriteria: "Canonical advancement cannot be guessed as the orphan creation base.",
      useWorktree: true,
    });
    await new WorktreeService({ canonicalRoot: projectRoot }).create({ owner: { type: "goal", id: goal.id } });
    await writeFile(join(projectRoot, "advanced.txt"), "canonical advanced\n");
    await git(projectRoot, ["add", "advanced.txt"]);
    await git(projectRoot, ["commit", "-m", "advance canonical"]);

    await expect(new GoalWorkspaceService({ canonicalRoot: projectRoot, goalStateManager: manager }).prepare(goal.id))
      .rejects.toMatchObject({ code: "WORKTREE_CHANGED" });
    expect((await manager.read(goal.id)).worktree).toBeUndefined();
  });

  test("reuses dirty descendant Goal work while rejecting a branch reset behind its recorded base", async () => {
    const projectRoot = await createGitRepo("validate-persisted-base");
    const firstSha = await git(projectRoot, ["rev-parse", "HEAD"]);
    await writeFile(join(projectRoot, "base.txt"), "creation base\n");
    await git(projectRoot, ["add", "base.txt"]);
    await git(projectRoot, ["commit", "-m", "creation base"]);
    const manager = new GoalStateManager(projectRoot);
    const goal = await commitGoal(manager, {
      projectId: "project-a",
      objective: "Keep retries on the owned branch lineage.",
      acceptanceCriteria: "Descendant work is reused and branch rewinds are rejected.",
      useWorktree: true,
    });
    const service = new GoalWorkspaceService({ canonicalRoot: projectRoot, goalStateManager: manager });
    const prepared = await service.prepare(goal.id);
    await writeFile(join(prepared.cwd, "descendant.txt"), "descendant\n");
    await git(prepared.cwd, ["add", "descendant.txt"]);
    await git(prepared.cwd, ["commit", "-m", "Goal descendant"]);
    await writeFile(join(prepared.cwd, "dirty.txt"), "retry in progress\n");

    await expect(service.prepare(goal.id)).resolves.toMatchObject({ cwd: prepared.cwd });

    await git(prepared.cwd, ["reset", "--hard", firstSha]);
    await expect(service.prepare(goal.id)).rejects.toMatchObject({ code: "WORKTREE_CHANGED" });
  });

  test("keeps a concurrently persisted claim for the same worktree identity", async () => {
    const projectRoot = resolve(TMP_DIR, "concurrent-claim");
    await mkdir(projectRoot, { recursive: true });
    const manager = new GoalStateManager(projectRoot);
    const goal = await commitGoal(manager, {
      projectId: "project-a",
      objective: "Converge concurrent worktree claims.",
      acceptanceCriteria: "The same path, branch, and base are one write-once resource even if timestamps differ.",
      useWorktree: true,
    });
    const branchName = managedWorktreeNames({ owner: { type: "goal", id: goal.id } }).branchName;
    const worktreePath = resolve(TMP_DIR, "concurrent-goal-worktree");
    const baseSha = "a".repeat(40);
    const remove = mock(async () => ({ detached: true as const, branchDeleted: true }));
    const worktreeService = {
      findManaged: mock(async () => undefined),
      validateManagedClaim: mock(async () => ({
        worktree: {
          path: worktreePath,
          headSha: baseSha,
          branchName,
          isCanonical: false,
          isManaged: true,
          isBare: false,
          isDetached: false,
          isPrunable: false,
        },
        status: { dirty: false, entries: [] },
        headSha: baseSha,
        branchHeadSha: baseSha,
        canonicalHeadSha: baseSha,
        baseSha,
      })),
      create: mock(async () => {
        await manager.setWorktree(goal.id, {
          path: worktreePath,
          branchName,
          baseSha,
          createdAt: "2026-07-10T00:00:00.000Z",
        });
        return {
          canonicalRoot: projectRoot,
          managedRoot: resolve(TMP_DIR, "managed"),
          worktreePath,
          worktreeName: "goal-concurrent",
          branchName,
          baseSha,
          resolvedHeadSha: baseSha,
          canonicalStatus: { dirty: false, entries: [] },
        };
      }),
      remove,
    };

    const prepared = await new GoalWorkspaceService({
      canonicalRoot: projectRoot,
      goalStateManager: manager,
      worktreeService,
    }).prepare(goal.id);

    expect(prepared.cwd).toBe(worktreePath);
    expect(prepared.goal.worktree).toMatchObject({
      path: worktreePath,
      branchName,
      baseSha,
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  test("serializes real Git preparation across GoalWorkspaceService instances until state is claimed", async () => {
    const projectRoot = await createGitRepo("concurrent-service-instances");
    const manager = new GoalStateManager(projectRoot);
    const goal = await commitGoal(manager, {
      projectId: "project-a",
      objective: "Coordinate worktree preparation across service instances.",
      acceptanceCriteria: "Only one prepare path runs before the durable Goal claim is visible.",
      useWorktree: true,
    });
    const realWorktrees = new WorktreeService({ canonicalRoot: projectRoot });
    const created = createDeferred<WorktreeCreateResult>();
    const releaseCreate = createDeferred<void>();
    const secondFindManaged = mock((input: Parameters<WorktreeService["findManaged"]>[0]) => realWorktrees.findManaged(input));
    const firstWorktrees = {
      findManaged: (input: Parameters<WorktreeService["findManaged"]>[0]) => realWorktrees.findManaged(input),
      validateManagedClaim: (input: Parameters<WorktreeService["validateManagedClaim"]>[0]) => realWorktrees.validateManagedClaim(input),
      remove: (input: Parameters<WorktreeService["remove"]>[0]) => realWorktrees.remove(input),
      create: async (input: Parameters<WorktreeService["create"]>[0]) => {
        const result = await realWorktrees.create(input);
        created.resolve(result);
        await releaseCreate.promise;
        return result;
      },
    };
    const secondWorktrees = {
      findManaged: secondFindManaged,
      validateManagedClaim: (input: Parameters<WorktreeService["validateManagedClaim"]>[0]) => realWorktrees.validateManagedClaim(input),
      remove: (input: Parameters<WorktreeService["remove"]>[0]) => realWorktrees.remove(input),
      create: (input: Parameters<WorktreeService["create"]>[0]) => realWorktrees.create(input),
    };
    const firstService = new GoalWorkspaceService({ canonicalRoot: projectRoot, goalStateManager: manager, worktreeService: firstWorktrees });
    const secondService = new GoalWorkspaceService({
      canonicalRoot: projectRoot,
      goalStateManager: new GoalStateManager(projectRoot),
      worktreeService: secondWorktrees,
    });

    const firstPromise = firstService.prepare(goal.id);
    await created.promise;
    let secondSettled = false;
    const secondPromise = secondService.prepare(goal.id).then((result) => {
      secondSettled = true;
      return result;
    });
    await Bun.sleep(10);
    const secondSettledBeforeClaim = secondSettled;
    const secondLookupBeforeClaim = secondFindManaged.mock.calls.length;
    releaseCreate.resolve(undefined);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(secondSettledBeforeClaim).toBe(false);
    expect(secondLookupBeforeClaim).toBe(0);
    expect(second.cwd).toBe(first.cwd);
    expect(second.goal.worktree).toEqual(first.goal.worktree);
  });

  test("adopts a real worktree when a stale create loses to another creator before state persistence", async () => {
    const projectRoot = await createGitRepo("stale-create-adoption");
    const manager = new GoalStateManager(projectRoot);
    const goal = await commitGoal(manager, {
      projectId: "project-a",
      objective: "Recover a stale get-or-create race.",
      acceptanceCriteria: "A concurrently created registered worktree is adopted instead of surfacing WORKTREE_PATH_EXISTS.",
      useWorktree: true,
    });
    const realWorktrees = new WorktreeService({ canonicalRoot: projectRoot });
    let lookupCount = 0;
    const racingWorktrees = {
      findManaged: async (input: Parameters<WorktreeService["findManaged"]>[0]) => {
        lookupCount += 1;
        return lookupCount === 1 ? undefined : await realWorktrees.findManaged(input);
      },
      validateManagedClaim: (input: Parameters<WorktreeService["validateManagedClaim"]>[0]) => realWorktrees.validateManagedClaim(input),
      remove: (input: Parameters<WorktreeService["remove"]>[0]) => realWorktrees.remove(input),
      create: async (input: Parameters<WorktreeService["create"]>[0]) => {
        const wonByOtherCreator = await realWorktrees.create(input);
        throw new WorktreeServiceError("WORKTREE_PATH_EXISTS", "Concurrent creator already registered the Goal worktree", {
          worktreePath: wonByOtherCreator.worktreePath,
        });
      },
    };

    const prepared = await new GoalWorkspaceService({
      canonicalRoot: projectRoot,
      goalStateManager: manager,
      worktreeService: racingWorktrees,
    }).prepare(goal.id);

    expect(lookupCount).toBe(2);
    expect(prepared.goal.worktree).toMatchObject({ path: prepared.cwd, branchName: expect.stringContaining("archcode/goal/") });
    expect((await manager.read(goal.id)).worktree).toEqual(prepared.goal.worktree);
  });

  test("rejects persisted metadata that points at another Goal worktree", async () => {
    const projectRoot = await createGitRepo("reject-other-goal");
    const manager = new GoalStateManager(projectRoot);
    const goal = await commitGoal(manager, {
      projectId: "project-a",
      objective: "Keep ownership isolated.",
      acceptanceCriteria: "A Goal cannot reuse another Goal worktree.",
      useWorktree: true,
    });
    const other = await new WorktreeService({ canonicalRoot: projectRoot }).create({
      owner: { type: "goal", id: crypto.randomUUID() },
    });
    await manager.setWorktree(goal.id, {
      path: other.worktreePath,
      branchName: other.branchName,
      baseSha: other.baseSha,
      createdAt: new Date().toISOString(),
    });

    await expect(new GoalWorkspaceService({ canonicalRoot: projectRoot, goalStateManager: manager }).prepare(goal.id))
      .rejects.toMatchObject({ name: "WorktreeServiceError", code: "WORKTREE_BRANCH_MISMATCH" });
  });
});

async function createGitRepo(name: string): Promise<string> {
  const repo = resolve(TMP_DIR, name);
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "goal-worktree@example.com"]);
  await git(repo, ["config", "user.name", "Goal Worktree"]);
  await writeFile(join(repo, "README.md"), `# ${name}\n`);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial commit"]);
  return repo;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

function createDeferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
