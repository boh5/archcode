import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { createProcessRunner } from "../process/runner";
import type { ProcessRunner, ProcessRunnerInput } from "../process/types";
import { createTestTempRoot, type TestTempRoot } from "../testing/test-temp-root";
import { managedWorktreeNames, WorktreeService } from "./service";

const gitRunner = createProcessRunner();
let testTempRoot: TestTempRoot;
let TMP_DIR: string;

beforeEach(async () => {
  testTempRoot = createTestTempRoot("worktree-service");
  await mkdir(testTempRoot.path, { recursive: true });
  TMP_DIR = await realpath(testTempRoot.path);
});

afterEach(async () => {
  await testTempRoot.cleanup();
});

describe("WorktreeService", () => {
  test("creates and lists a managed Session worktree from an exact commit", async () => {
    const repo = await createGitRepo("session-create");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const service = new WorktreeService({ canonicalRoot: repo });

    const created = await service.create({
      owner: { type: "session", id: "session-1234567890" },
      baseSha,
      label: "auth fix",
    });

    expect(created.branchName).toBe("archcode/session/session-1234");
    expect(created.worktreePath.startsWith(`${resolve(dirname(repo), "session-create.worktrees")}/`)).toBe(true);
    expect(await git(created.worktreePath, ["rev-parse", "HEAD"])).toBe(baseSha);
    expect(await service.list()).toContainEqual(expect.objectContaining({
      path: created.worktreePath,
      branchName: created.branchName,
      isManaged: true,
      isCanonical: false,
    }));
  });

  test("self-heals an unregistered deterministic branch left at the requested base", async () => {
    const repo = await createGitRepo("branch-only-self-heal");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const input = { owner: { type: "session" as const, id: "session-self-heal" }, uniqueId: "job-123456789", baseSha };
    const names = managedWorktreeNames(input);
    await git(repo, ["branch", names.branchName, baseSha]);

    const created = await new WorktreeService({ canonicalRoot: repo }).create(input);

    expect(created.branchName).toBe(names.branchName);
    expect(await git(created.worktreePath, ["rev-parse", "HEAD"])).toBe(baseSha);
  });

  test("preserves an unregistered deterministic branch that advanced beyond the requested base", async () => {
    const repo = await createGitRepo("branch-only-preserve");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const input = { owner: { type: "session" as const, id: "session-preserve" }, uniqueId: "job-123456789", baseSha };
    const names = managedWorktreeNames(input);
    await git(repo, ["branch", names.branchName, baseSha]);
    await git(repo, ["commit", "--allow-empty", "-m", "advance orphan"]);
    const advancedSha = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["update-ref", `refs/heads/${names.branchName}`, advancedSha, baseSha]);

    await expect(new WorktreeService({ canonicalRoot: repo }).create(input)).rejects.toMatchObject({
      code: "WORKTREE_PATH_EXISTS",
      details: { branchName: names.branchName, branchHeadSha: advancedSha, baseSha },
    });
    expect(await git(repo, ["rev-parse", `refs/heads/${names.branchName}`])).toBe(advancedSha);
  });

  test("validates existing worktrees by git common directory and rejects another repository", async () => {
    const repo = await createGitRepo("validate-existing");
    const otherRepo = await createGitRepo("other-repo");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const externalPath = resolve(TMP_DIR, "external-worktree");
    await git(repo, ["worktree", "add", "-b", "external-branch", externalPath, baseSha]);
    const service = new WorktreeService({ canonicalRoot: repo });

    await expect(service.validate(existingPath(externalPath))).resolves.toMatchObject({
      path: externalPath,
      branchName: "external-branch",
      isManaged: false,
    });
    await expect(service.validate(existingPath(otherRepo))).rejects.toMatchObject({
      name: "WorktreeServiceError",
      code: "DIFFERENT_REPOSITORY",
    });
  });

  test("rejects persisted managed claims reset behind or away from their recorded base", async () => {
    const repo = await createGitRepo("reject-reset-managed-claim");
    const firstSha = await git(repo, ["rev-parse", "HEAD"]);
    await writeFile(join(repo, "second.txt"), "second\n");
    await git(repo, ["add", "second.txt"]);
    await git(repo, ["commit", "-m", "second commit"]);
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const service = new WorktreeService({ canonicalRoot: repo });
    const created = await service.create({ owner: { type: "goal", id: "goal-claim-reset" }, baseSha });

    await git(created.worktreePath, ["reset", "--hard", firstSha]);
    await expect(service.validateManagedClaim({
      path: created.worktreePath,
      branchName: created.branchName,
      mode: "persisted",
      baseSha,
    })).rejects.toMatchObject({ code: "WORKTREE_CHANGED" });

    const treeSha = await git(repo, ["rev-parse", "HEAD^{tree}"]);
    const unrelatedSha = await git(repo, ["commit-tree", treeSha, "-m", "unrelated root"]);
    await git(created.worktreePath, ["reset", "--hard", unrelatedSha]);
    await expect(service.validateManagedClaim({
      path: created.worktreePath,
      branchName: created.branchName,
      mode: "persisted",
      baseSha,
    })).rejects.toMatchObject({ code: "WORKTREE_CHANGED" });
  });

  test("validates crash-orphan claims only at a clean canonical HEAD", async () => {
    const repo = await createGitRepo("validate-orphan-claim");
    const service = new WorktreeService({ canonicalRoot: repo });
    const created = await service.create({ owner: { type: "goal", id: "goal-orphan-claim" } });

    await expect(service.validateManagedClaim({
      path: created.worktreePath,
      branchName: created.branchName,
      mode: "orphan",
    })).resolves.toMatchObject({ headSha: created.baseSha, baseSha: created.baseSha, status: { dirty: false } });

    const dirtyPath = join(created.worktreePath, "dirty.txt");
    await writeFile(dirtyPath, "unclaimed change\n");
    await expect(service.validateManagedClaim({
      path: created.worktreePath,
      branchName: created.branchName,
      mode: "orphan",
    })).rejects.toMatchObject({ code: "WORKTREE_CHANGED" });
    await rm(dirtyPath);

    await writeFile(join(repo, "canonical-advance.txt"), "advance\n");
    await git(repo, ["add", "canonical-advance.txt"]);
    await git(repo, ["commit", "-m", "advance canonical"]);
    await expect(service.validateManagedClaim({
      path: created.worktreePath,
      branchName: created.branchName,
      mode: "orphan",
    })).rejects.toMatchObject({ code: "WORKTREE_CHANGED" });
  });

  test("safe removal deletes only unchanged managed worktrees", async () => {
    const repo = await createGitRepo("safe-remove");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const service = new WorktreeService({ canonicalRoot: repo });
    const clean = await service.create({ owner: { type: "goal", id: "goal-clean-123456" }, baseSha });

    await expect(service.remove({ path: clean.worktreePath, branchName: clean.branchName, baseSha }))
      .resolves.toEqual({ detached: true, branchDeleted: true });
    expect(await pathExists(clean.worktreePath)).toBe(false);

    const changed = await service.create({ owner: { type: "goal", id: "goal-dirty-123456" }, baseSha });
    await writeFile(join(changed.worktreePath, "dirty.txt"), "keep me\n");
    await expect(service.remove({ path: changed.worktreePath, branchName: changed.branchName, baseSha })).rejects.toMatchObject({
      code: "WORKTREE_CHANGED",
    });
    expect(await pathExists(changed.worktreePath)).toBe(true);
  });

  test("preserves an otherwise clean worktree when it contains only ignored files", async () => {
    const repo = await createGitRepo("ignored-remove");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore dependencies"]);
    const service = new WorktreeService({ canonicalRoot: repo });
    const created = await service.create({ owner: { type: "session", id: "ignored-remove-session" } });
    const ignoredFile = join(created.worktreePath, "node_modules", "cache.bin");
    await mkdir(dirname(ignoredFile), { recursive: true });
    await writeFile(ignoredFile, "must survive cleanup\n");
    const beforeRemove = mock(async () => undefined);

    await expect(service.remove({
      path: created.worktreePath,
      branchName: created.branchName,
      baseSha: created.baseSha,
      beforeRemove,
    })).rejects.toMatchObject({ code: "WORKTREE_CHANGED" });

    expect(beforeRemove).not.toHaveBeenCalled();
    expect(await Bun.file(ignoredFile).text()).toBe("must survive cleanup\n");
    expect(await pathExists(created.worktreePath)).toBe(true);
  });

  test("ignored files in the canonical checkout do not block clean worktree creation", async () => {
    const repo = await createGitRepo("canonical-ignored-create");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore dependencies"]);
    await mkdir(join(repo, "node_modules"), { recursive: true });
    await writeFile(join(repo, "node_modules", "cache.bin"), "canonical cache\n");
    const service = new WorktreeService({ canonicalRoot: repo });

    await expect(service.create({
      owner: { type: "session", id: "canonical-ignored-session" },
      requireCleanCanonical: true,
    })).resolves.toMatchObject({ canonicalStatus: { dirty: false } });
  });

  test("admin removal without owner metadata deletes only branches with no unique commits", async () => {
    const repo = await createGitRepo("admin-remove");
    const service = new WorktreeService({ canonicalRoot: repo });
    const unchanged = await service.create({ owner: { type: "session", id: "session-admin-clean" } });
    await writeFile(join(repo, "later.txt"), "canonical advanced\n");
    await git(repo, ["add", "later.txt"]);
    await git(repo, ["commit", "-m", "advance canonical"]);

    await expect(service.remove({ path: unchanged.worktreePath, branchName: unchanged.branchName }))
      .resolves.toEqual({ detached: true, branchDeleted: true });
    expect(await pathExists(unchanged.worktreePath)).toBe(false);

    const changed = await service.create({ owner: { type: "session", id: "session-admin-changed" } });
    await writeFile(join(changed.worktreePath, "commit.txt"), "unique commit\n");
    await git(changed.worktreePath, ["add", "commit.txt"]);
    await git(changed.worktreePath, ["commit", "-m", "unique worktree commit"]);
    await expect(service.remove({ path: changed.worktreePath, branchName: changed.branchName })).rejects.toMatchObject({ code: "WORKTREE_CHANGED" });
    expect(await pathExists(changed.worktreePath)).toBe(true);
  });

  test("runs beforeRemove after final validation and before lifecycle deletion", async () => {
    const repo = await createGitRepo("before-remove");
    const service = new WorktreeService({ canonicalRoot: repo });
    const created = await service.create({ owner: { type: "session", id: "session-before-remove" } });
    const beforeRemove = mock(async () => {
      expect(await pathExists(created.worktreePath)).toBe(true);
      expect(await git(repo, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(created.baseSha);
    });

    await expect(service.remove({
      path: created.worktreePath,
      branchName: created.branchName,
      baseSha: created.baseSha,
      beforeRemove,
    })).resolves.toEqual({ detached: true, branchDeleted: true });

    expect(beforeRemove).toHaveBeenCalledTimes(1);
    expect(await pathExists(created.worktreePath)).toBe(false);
  });

  test("preserves the worktree and branch when beforeRemove fails", async () => {
    const repo = await createGitRepo("before-remove-failure");
    const service = new WorktreeService({ canonicalRoot: repo });
    const created = await service.create({ owner: { type: "session", id: "session-before-remove-failure" } });

    await expect(service.remove({
      path: created.worktreePath,
      branchName: created.branchName,
      baseSha: created.baseSha,
      beforeRemove: async () => { throw new Error("Session cwd changed concurrently"); },
    })).rejects.toThrow("Session cwd changed concurrently");

    expect(await pathExists(created.worktreePath)).toBe(true);
    expect(await git(repo, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(created.baseSha);
  });

  test("revalidates after beforeRemove and rolls the lifecycle back when ignored state appears", async () => {
    const repo = await createGitRepo("before-remove-revalidation");
    await writeFile(join(repo, ".gitignore"), "generated/\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore generated state"]);
    const service = new WorktreeService({ canonicalRoot: repo });
    const created = await service.create({ owner: { type: "session", id: "session-revalidation" } });
    const events: string[] = [];
    const generated = join(created.worktreePath, "generated", "late.bin");

    await expect(service.remove({
      path: created.worktreePath,
      branchName: created.branchName,
      baseSha: created.baseSha,
      beforeRemove: async () => {
        events.push("before");
        await mkdir(dirname(generated), { recursive: true });
        await writeFile(generated, "late state\n");
      },
      onRemoveFailureBeforeDetach: async () => {
        events.push("failure-before-detach");
        expect(await pathExists(created.worktreePath)).toBe(true);
      },
      onRemoveDetached: async () => { events.push("detached"); },
    })).rejects.toMatchObject({ code: "WORKTREE_CHANGED" });

    expect(events).toEqual(["before", "failure-before-detach"]);
    expect(await Bun.file(generated).text()).toBe("late state\n");
    expect(await git(repo, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(created.baseSha);
  });

  test("invokes the pre-detach failure callback exactly once when git worktree remove fails", async () => {
    const repo = await createGitRepo("remove-command-failure");
    const created = await new WorktreeService({ canonicalRoot: repo }).create({
      owner: { type: "session", id: "remove-command-failure-session" },
    });
    const delegate = createProcessRunner();
    const runner: ProcessRunner = {
      async run(input) {
        if (isGitInvocation(input, "worktree", "remove")) {
          return await delegate.run({
            ...input,
            argv: ["git", "worktree", "remove", join(TMP_DIR, "not-a-registered-worktree")],
          });
        }
        return await delegate.run(input);
      },
    };
    const events: string[] = [];
    const service = new WorktreeService({ canonicalRoot: repo, git: runner });

    await expect(service.remove({
      path: created.worktreePath,
      branchName: created.branchName,
      baseSha: created.baseSha,
      beforeRemove: async () => { events.push("before"); },
      onRemoveFailureBeforeDetach: async () => {
        events.push("failure-before-detach");
        expect(await pathExists(created.worktreePath)).toBe(true);
      },
      onRemoveDetached: async () => { events.push("detached"); },
    })).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });

    expect(events).toEqual(["before", "failure-before-detach"]);
    expect(await pathExists(created.worktreePath)).toBe(true);
    expect(await git(repo, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(created.baseSha);
  });

  test("serializes lifecycle mutations for services using the same Git common directory", async () => {
    const repo = await createGitRepo("serialized-lifecycle");
    const alternateCanonical = resolve(TMP_DIR, "serialized-alternate");
    await git(repo, ["worktree", "add", "-b", "serialized-alternate", alternateCanonical, "HEAD"]);
    const delegate = createProcessRunner();
    let activeAdds = 0;
    let maxActiveAdds = 0;
    const runner: ProcessRunner = {
      async run(input) {
        if (isGitInvocation(input, "worktree", "add")) {
          activeAdds += 1;
          maxActiveAdds = Math.max(maxActiveAdds, activeAdds);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
          try {
            return await delegate.run(input);
          } finally {
            activeAdds -= 1;
          }
        }
        return await delegate.run(input);
      },
    };
    const left = new WorktreeService({ canonicalRoot: repo, git: runner });
    const right = new WorktreeService({ canonicalRoot: alternateCanonical, git: runner });

    await Promise.all([
      left.create({ owner: { type: "session", id: "left-session-lock" } }),
      right.create({ owner: { type: "session", id: "right-session-lock" } }),
    ]);

    expect(maxActiveAdds).toBe(1);
  });

  test("rolls back a clean registered worktree when post-add verification fails", async () => {
    const repo = await createGitRepo("create-rollback");
    const delegate = createProcessRunner();
    let injected = false;
    const runner: ProcessRunner = {
      async run(input) {
        if (
          !injected
          && isGitInvocation(input, "rev-parse", "--verify", "HEAD")
          && input.cwd?.includes(".worktrees/")
        ) {
          injected = true;
          return await delegate.run({
            ...input,
            argv: ["git", "rev-parse", "--verify", "refs/heads/__archcode_missing_post_add__"],
          });
        }
        return await delegate.run(input);
      },
    };
    const owner = { type: "session" as const, id: "session-rollback-1234" };
    const names = managedWorktreeNames({ owner });
    const service = new WorktreeService({ canonicalRoot: repo, git: runner });

    await expect(service.create({ owner })).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });

    expect((await service.list()).some((entry) => entry.branchName === names.branchName)).toBe(false);
    expect(await gitExitCode(repo, ["show-ref", "--verify", `refs/heads/${names.branchName}`])).not.toBe(0);
  });

  test("creation rollback preserves ignored files that appeared after git worktree add", async () => {
    const repo = await createGitRepo("create-rollback-ignored");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore dependencies"]);
    const delegate = createProcessRunner();
    let injected = false;
    let ignoredFile: string | undefined;
    const runner: ProcessRunner = {
      async run(input) {
        if (isGitInvocation(input, "worktree", "add")) {
          const result = await delegate.run(input);
          const worktreePath = input.argv[5];
          if (result.kind === "success" && worktreePath !== undefined) {
            ignoredFile = join(worktreePath, "node_modules", "cache.bin");
            await mkdir(dirname(ignoredFile), { recursive: true });
            await writeFile(ignoredFile, "preserve rollback cache\n");
          }
          return result;
        }
        if (
          !injected
          && isGitInvocation(input, "rev-parse", "--verify", "HEAD")
          && input.cwd?.includes(".worktrees/")
        ) {
          injected = true;
          return await delegate.run({
            ...input,
            argv: ["git", "rev-parse", "--verify", "refs/heads/__archcode_missing_post_add__"],
          });
        }
        return await delegate.run(input);
      },
    };
    const owner = { type: "session" as const, id: "session-rollback-ignored" };
    const service = new WorktreeService({ canonicalRoot: repo, git: runner });

    await expect(service.create({ owner })).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });

    if (ignoredFile === undefined) throw new Error("Expected ignored rollback fixture");
    expect(await Bun.file(ignoredFile).text()).toBe("preserve rollback cache\n");
    expect((await service.list()).some((entry) => entry.branchName === managedWorktreeNames({ owner }).branchName)).toBe(true);
  });

  test("uses expected-HEAD ref deletion and preserves a concurrently advanced branch", async () => {
    const repo = await createGitRepo("remove-cas");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await new WorktreeService({ canonicalRoot: repo }).create({
      owner: { type: "session", id: "session-remove-cas" },
      baseSha,
    });
    await git(repo, ["commit", "--allow-empty", "-m", "advance with identical tree"]);
    const advancedSha = await git(repo, ["rev-parse", "HEAD"]);
    const delegate = createProcessRunner();
    const invocations: string[][] = [];
    const lifecycleEvents: string[] = [];
    let advanced = false;
    const runner: ProcessRunner = {
      async run(input) {
        invocations.push([...input.argv]);
        if (!advanced && isGitInvocation(input, "worktree", "remove")) {
          advanced = true;
          await git(repo, ["update-ref", `refs/heads/${created.branchName}`, advancedSha, baseSha]);
        }
        return await delegate.run(input);
      },
    };
    const service = new WorktreeService({ canonicalRoot: repo, git: runner });

    const result = await service.remove({
      path: created.worktreePath,
      branchName: created.branchName,
      baseSha,
      beforeRemove: async () => { lifecycleEvents.push("before"); },
      onRemoveFailureBeforeDetach: async () => { lifecycleEvents.push("failure-before-detach"); },
      onRemoveDetached: async () => { lifecycleEvents.push("detached"); },
    });

    expect(result).toMatchObject({
      detached: true,
      branchDeleted: false,
      warning: { code: "BRANCH_DELETE_FAILED", branchName: created.branchName },
    });
    expect(lifecycleEvents).toEqual(["before", "detached"]);
    expect(await git(repo, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(advancedSha);
    expect(invocations.some((argv) => argv[1] === "branch" && argv.includes("-D"))).toBe(false);
    expect(invocations.some((argv) => (
      argv[1] === "update-ref"
      && argv[2] === "--no-deref"
      && argv[3] === "-d"
      && argv.at(-1) === baseSha
    ))).toBe(true);
  });

  test("reconciles only safe prunable managed worktrees without an Agent tool", async () => {
    const repo = await createGitRepo("reconcile-prunable");
    const service = new WorktreeService({ canonicalRoot: repo });
    const created = await service.create({ owner: { type: "session", id: "session-prunable" } });
    await rm(created.worktreePath, { recursive: true, force: true });

    expect(await service.list()).toContainEqual(expect.objectContaining({
      path: created.worktreePath,
      branchName: created.branchName,
      isManaged: true,
      isPrunable: true,
    }));

    const result = await service.reconcilePrunable();

    expect(result.removed).toEqual([expect.objectContaining({ path: created.worktreePath, branchName: created.branchName })]);
    expect(result.preserved).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect((await service.list()).some((entry) => entry.path === created.worktreePath)).toBe(false);
    expect(await gitExitCode(repo, ["show-ref", "--verify", `refs/heads/${created.branchName}`])).not.toBe(0);
  });

  test("reports a detached prunable registration when its branch deletion fails", async () => {
    const repo = await createGitRepo("reconcile-prunable-branch-warning");
    const created = await new WorktreeService({ canonicalRoot: repo }).create({
      owner: { type: "session", id: "session-prunable-branch-warning" },
    });
    await rm(created.worktreePath, { recursive: true, force: true });
    const delegate = createProcessRunner();
    const runner: ProcessRunner = {
      async run(input) {
        if (isGitInvocation(input, "update-ref", "--no-deref", "-d")) {
          return await delegate.run({
            ...input,
            argv: [
              "git",
              "update-ref",
              "--no-deref",
              "-d",
              input.argv[4]!,
              "ffffffffffffffffffffffffffffffffffffffff",
            ],
          });
        }
        return await delegate.run(input);
      },
    };
    const service = new WorktreeService({ canonicalRoot: repo, git: runner });

    const result = await service.reconcilePrunable();

    expect(result.removed).toEqual([
      expect.objectContaining({ path: created.worktreePath, branchName: created.branchName }),
    ]);
    expect(result.preserved).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        worktree: expect.objectContaining({ path: created.worktreePath, branchName: created.branchName }),
        warning: expect.objectContaining({
          code: "BRANCH_DELETE_FAILED",
          branchName: created.branchName,
        }),
      }),
    ]);
    expect((await service.list()).some((entry) => entry.path === created.worktreePath)).toBe(false);
    expect(await git(repo, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(created.baseSha);
  });

  test("preserves prunable managed worktrees whose branches contain unique commits", async () => {
    const repo = await createGitRepo("reconcile-prunable-changed");
    const service = new WorktreeService({ canonicalRoot: repo });
    const created = await service.create({ owner: { type: "session", id: "session-prunable-changed" } });
    await writeFile(join(created.worktreePath, "unique.txt"), "preserve\n");
    await git(created.worktreePath, ["add", "unique.txt"]);
    await git(created.worktreePath, ["commit", "-m", "unique worktree commit"]);
    const uniqueHead = await git(created.worktreePath, ["rev-parse", "HEAD"]);
    await rm(created.worktreePath, { recursive: true, force: true });

    const result = await service.reconcilePrunable();

    expect(result.removed).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.preserved).toEqual([
      expect.objectContaining({
        worktree: expect.objectContaining({ path: created.worktreePath, branchName: created.branchName }),
        reason: expect.stringContaining("not reachable"),
      }),
    ]);
    expect(await git(repo, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(uniqueHead);
  });
});

function existingPath(path: string): string {
  return path;
}

async function createGitRepo(name: string): Promise<string> {
  const repo = resolve(TMP_DIR, name);
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "worktree-test@example.com"]);
  await git(repo, ["config", "user.name", "Worktree Test"]);
  await writeFile(join(repo, "README.md"), `# ${name}\n`);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial commit"]);
  return repo;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await gitRunner.run({
    argv: ["git", ...args],
    cwd,
    env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.kind !== "success") {
    throw new Error(`git ${args.join(" ")} failed (${result.kind}): ${"output" in result ? result.output.stderr : result.error.message}`);
  }
  return result.output.stdout.trim();
}

async function gitExitCode(cwd: string, args: readonly string[]): Promise<number> {
  const result = await gitRunner.run({
    argv: ["git", ...args],
    cwd,
    env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return "exitCode" in result && typeof result.exitCode === "number" ? result.exitCode : -1;
}

function isGitInvocation(input: ProcessRunnerInput, ...args: string[]): boolean {
  return input.argv[0] === "git" && args.every((arg, index) => input.argv[index + 1] === arg);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
