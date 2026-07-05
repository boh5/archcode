import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { ProcessRunner, ProcessRunnerInput, ProcessRunnerResult } from "../process/types";
import {
  LoopWorktreeManager,
  parsePorcelainStatus,
  worktreeNames,
} from "./worktree-manager";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "worktree-manager");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("LoopWorktreeManager", () => {
  test("creates sibling worktree from exact SHA on a clean canonical repository", async () => {
    const repo = await createGitRepo("clean-create");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const manager = new LoopWorktreeManager({ canonicalRoot: repo });

    const created = await manager.create({
      loopSlug: "Daily Loop",
      subjectSlug: "PR #42",
      jobId: "1234567890abcdef",
      baseSha,
    });

    expect(created.canonicalRoot).toBe(await realpath(repo));
    expect(created.managedRoot).toBe(resolve(dirname(repo), `${basename(repo)}.worktrees`));
    expect(created.worktreePath.startsWith(`${created.managedRoot}/`)).toBe(true);
    expect(created.branchName).toBe("archcode/loop/daily-loop/1234567890ab");
    expect(created.resolvedHeadSha).toBe(baseSha);
    expect(await git(created.worktreePath, ["rev-parse", "HEAD"])).toBe(baseSha);
  });

  test("blocks dirty local canonical checkout before a worktree path exists", async () => {
    const repo = await createGitRepo("dirty-canonical");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const names = worktreeNames({ loopSlug: "loop", subjectSlug: "subject", jobId: "dirty-job" });
    const expectedPath = resolve(dirname(repo), `${basename(repo)}.worktrees`, names.worktreeName);
    await writeFile(join(repo, "dirty.txt"), "not committed\n");

    const manager = new LoopWorktreeManager({ canonicalRoot: repo });
    await expect(manager.create({ loopSlug: "loop", subjectSlug: "subject", jobId: "dirty-job", baseSha })).rejects.toMatchObject({
      name: "LoopWorktreeManagerError",
      code: "CANONICAL_DIRTY",
    });
    expect(await Bun.file(expectedPath).exists()).toBe(false);
  });

  test("rejects missing, branch-like, and unknown base SHAs instead of inferring a ref", async () => {
    const repo = await createGitRepo("base-validation");
    const manager = new LoopWorktreeManager({ canonicalRoot: repo });

    await expect(manager.create({ loopSlug: "loop", subjectSlug: "subject", jobId: "missing-base", baseSha: "" })).rejects.toMatchObject({ code: "MISSING_BASE_SHA" });
    await expect(manager.create({ loopSlug: "loop", subjectSlug: "subject", jobId: "branch-base", baseSha: "main" })).rejects.toMatchObject({ code: "INVALID_BASE_SHA" });
    await expect(manager.create({ loopSlug: "loop", subjectSlug: "subject", jobId: "unknown-base", baseSha: "f".repeat(40) })).rejects.toMatchObject({ code: "BASE_SHA_NOT_FOUND" });
  });

  test("sanitizes malicious slugs without allowing managed-root escape", async () => {
    const repo = await createGitRepo("malicious-slug");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await new LoopWorktreeManager({ canonicalRoot: repo }).create({
      loopSlug: "../../evil//loop",
      subjectSlug: "../../../outside subject",
      jobId: "../job-escape-123456",
      baseSha,
    });

    expect(created.worktreeName).not.toContain("..");
    expect(created.worktreeName).not.toContain("/");
    expect(created.worktreePath.startsWith(`${created.managedRoot}/`)).toBe(true);
    expect(await Bun.file(join(created.worktreePath, "README.md")).exists()).toBe(true);
  });

  test("rejects managed-root symlink escape before creating a worktree", async () => {
    const repo = await createGitRepo("symlink-escape");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const outside = join(TMP_DIR, "outside-managed-root");
    await mkdir(outside, { recursive: true });
    await symlink(outside, resolve(dirname(repo), `${basename(repo)}.worktrees`), "dir");

    await expect(new LoopWorktreeManager({ canonicalRoot: repo }).create({
      loopSlug: "loop",
      subjectSlug: "subject",
      jobId: "symlink-job",
      baseSha,
    })).rejects.toMatchObject({ code: "WORKTREE_PATH_ESCAPE" });
  });

  test("writes inside worktree leave canonical checkout clean and inspection captures artifacts", async () => {
    const repo = await createGitRepo("isolated-write");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const manager = new LoopWorktreeManager({ canonicalRoot: repo });
    const created = await manager.create({ loopSlug: "loop", subjectSlug: "report", jobId: "artifact-job", baseSha });

    await writeFile(join(created.worktreePath, "evidence.txt"), "worktree-only\n");
    const inspection = await manager.inspect({
      worktreePath: created.worktreePath,
      branchName: created.branchName,
      baseSha,
      evidencePaths: ["evidence.txt"],
    });

    expect((await git(repo, ["status", "--porcelain=v1"])).trim()).toBe("");
    expect(inspection.hasChanges).toBe(true);
    expect(inspection.untrackedFiles).toEqual(["evidence.txt"]);
    expect(inspection.evidenceArtifacts[0]).toMatchObject({ path: "evidence.txt", status: "created" });
  });

  test("hashes dash-prefixed evidence paths as files, not git options", async () => {
    const repo = await createGitRepo("dash-evidence");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const manager = new LoopWorktreeManager({ canonicalRoot: repo });
    const created = await manager.create({ loopSlug: "loop", subjectSlug: "dash", jobId: "dash-job", baseSha });
    await writeFile(join(created.worktreePath, "--stdin"), "not empty\n");

    const inspection = await manager.inspect({
      worktreePath: created.worktreePath,
      branchName: created.branchName,
      baseSha,
      evidencePaths: ["--stdin"],
    });

    expect(inspection.evidenceArtifacts[0]).toMatchObject({
      path: "--stdin",
      status: "created",
      sha: await git(created.worktreePath, ["hash-object", "--", "--stdin"]),
    });
  });

  test("removes unchanged worktree and branch without review requirement", async () => {
    const repo = await createGitRepo("cleanup-unchanged");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const manager = new LoopWorktreeManager({ canonicalRoot: repo });
    const created = await manager.create({ loopSlug: "loop", subjectSlug: "clean", jobId: "cleanup-job", baseSha });
    const inspection = await manager.inspect({ worktreePath: created.worktreePath, branchName: created.branchName, baseSha });

    const cleanup = await manager.cleanup({ inspection, jobStatus: "succeeded" });

    expect(cleanup).toMatchObject({ cleanupState: "cleaned", removed: true, reviewRequired: false });
    expect(await pathExists(created.worktreePath)).toBe(false);
    expect(await git(repo, ["branch", "--list", created.branchName])).toBe("");
  });

  test("preserves changed and failed worktrees with review required", async () => {
    const repo = await createGitRepo("cleanup-preserve");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const manager = new LoopWorktreeManager({ canonicalRoot: repo });
    const changed = await manager.create({ loopSlug: "loop", subjectSlug: "changed", jobId: "changed-job", baseSha });
    await writeFile(join(changed.worktreePath, "changed.txt"), "review me\n");
    const changedInspection = await manager.inspect({ worktreePath: changed.worktreePath, branchName: changed.branchName, baseSha });

    expect(await manager.cleanup({ inspection: changedInspection, jobStatus: "succeeded" })).toMatchObject({
      cleanupState: "preserved",
      removed: false,
      reviewRequired: true,
    });
    expect(await pathExists(changed.worktreePath)).toBe(true);

    const failed = await manager.create({ loopSlug: "loop", subjectSlug: "failed", jobId: "failed-job", baseSha });
    const failedInspection = await manager.inspect({ worktreePath: failed.worktreePath, branchName: failed.branchName, baseSha });

    expect(await manager.cleanup({ inspection: failedInspection, jobStatus: "failed" })).toMatchObject({
      cleanupState: "preserved",
      removed: false,
      reviewRequired: true,
    });
    expect(await pathExists(failed.worktreePath)).toBe(true);
  });

  test("cleanup re-inspects stale clean inspections and preserves late changes", async () => {
    const repo = await createGitRepo("cleanup-stale-inspection");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const manager = new LoopWorktreeManager({ canonicalRoot: repo });
    const created = await manager.create({ loopSlug: "loop", subjectSlug: "stale", jobId: "stale-job", baseSha });
    const staleCleanInspection = await manager.inspect({ worktreePath: created.worktreePath, branchName: created.branchName, baseSha });
    await writeFile(join(created.worktreePath, "late-change.txt"), "do not delete\n");

    const cleanup = await manager.cleanup({ inspection: staleCleanInspection, jobStatus: "succeeded" });

    expect(cleanup).toMatchObject({ cleanupState: "preserved", removed: false, reviewRequired: true });
    expect(await pathExists(created.worktreePath)).toBe(true);
    expect(await Bun.file(join(created.worktreePath, "late-change.txt")).exists()).toBe(true);
  });

  test("cleanup rejects fabricated inspections outside the managed root", async () => {
    const repo = await createGitRepo("cleanup-outside");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const manager = new LoopWorktreeManager({ canonicalRoot: repo });
    const victim = resolve(TMP_DIR, "outside-victim-worktree");
    await git(repo, ["worktree", "add", "-b", "victim-branch", victim, baseSha]);

    await expect(manager.cleanup({
      inspection: {
        worktreePath: victim,
        branchName: "archcode/loop/loop/fakejob00",
        baseSha,
        headSha: baseSha,
        status: { dirty: false, entries: [] },
        untrackedFiles: [],
        localCommitsAhead: 0,
        changedRefs: [],
        diffStats: { committed: "", workingTree: "" },
        evidenceArtifacts: [],
        hasChanges: false,
      },
      jobStatus: "succeeded",
    })).rejects.toMatchObject({ code: "WORKTREE_PATH_ESCAPE" });
    expect(await pathExists(victim)).toBe(true);
  });

  test("cleanup rejects non-loop branch names before deleting branches", async () => {
    const repo = await createGitRepo("cleanup-branch-prefix");
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const manager = new LoopWorktreeManager({ canonicalRoot: repo });
    const created = await manager.create({ loopSlug: "loop", subjectSlug: "branch", jobId: "branch-job", baseSha });
    const inspection = await manager.inspect({ worktreePath: created.worktreePath, branchName: created.branchName, baseSha });

    await expect(manager.cleanup({
      inspection: { ...inspection, branchName: "main" },
      jobStatus: "succeeded",
    })).rejects.toMatchObject({ code: "WORKTREE_PATH_ESCAPE" });
    expect(await pathExists(created.worktreePath)).toBe(true);
  });

  test("locks git cwd and environment and uses exact SHA in worktree command", async () => {
    const calls: ProcessRunnerInput[] = [];
    const canonicalRoot = resolve(TMP_DIR, "fake-repo");
    await mkdir(canonicalRoot, { recursive: true });
    const fakeRunner: ProcessRunner = {
      run: mock(async (input: ProcessRunnerInput): Promise<ProcessRunnerResult> => {
        calls.push(input);
        const args = input.argv.slice(1).join(" ");
        if (args === "rev-parse --is-inside-work-tree") return success(input, "true\n");
        if (args === "rev-parse --is-bare-repository") return success(input, "false\n");
        if (args === "rev-parse --show-toplevel") return success(input, `${canonicalRoot}\n`);
        if (args === "status --porcelain=v1 -z") return success(input, "");
        if (args.startsWith("cat-file -e ")) return success(input, "");
        if (args.startsWith("rev-parse --verify ")) return success(input, `${"a".repeat(40)}\n`);
        if (args.startsWith("show-ref --verify --quiet ")) return nonzero(input, "");
        if (args.startsWith("worktree add -b ")) {
          await mkdir(input.argv[input.argv.length - 2]!, { recursive: true });
          return success(input, "");
        }
        return success(input, `${"a".repeat(40)}\n`);
      }),
    };

    await new LoopWorktreeManager({ canonicalRoot, git: fakeRunner }).create({
      loopSlug: "loop",
      subjectSlug: "subject",
      jobId: "abcdef123456",
      baseSha: "a".repeat(40),
    });

    expect(calls.every((call) => call.cwd === canonicalRoot || call.cwd?.startsWith(resolve(dirname(canonicalRoot), "fake-repo.worktrees")))).toBe(true);
    expect(calls.every((call) => call.env?.GIT_TERMINAL_PROMPT === "0" && call.env.PWD === call.cwd)).toBe(true);
    const addCall = calls.find((call) => call.argv[1] === "worktree" && call.argv[2] === "add");
    expect(addCall?.argv).toContain("a".repeat(40));
    expect(addCall?.argv).not.toContain("origin/HEAD");
  });
});

test("parsePorcelainStatus handles tracked and untracked entries", () => {
  expect(parsePorcelainStatus(" M file.txt\0?? new.txt\0")).toEqual([
    { path: "file.txt", index: " ", worktree: "M", raw: " M file.txt" },
    { path: "new.txt", index: "?", worktree: "?", raw: "?? new.txt" },
  ]);
});

async function createGitRepo(name: string): Promise<string> {
  const repo = resolve(TMP_DIR, name);
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "loop-test@example.com"]);
  await git(repo, ["config", "user.name", "Loop Test"]);
  await writeFile(join(repo, "README.md"), `# ${name}\n`);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial commit"]);
  return repo;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

function success(input: ProcessRunnerInput, stdout: string): ProcessRunnerResult {
  return {
    kind: "success",
    exitCode: 0,
    argv: input.argv,
    cwd: input.cwd,
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    output: { stdout, stderr: "", combined: stdout, stdoutTruncated: false, stderrTruncated: false, combinedTruncated: false },
  };
}

function nonzero(input: ProcessRunnerInput, stderr: string): ProcessRunnerResult {
  return {
    kind: "nonzero",
    exitCode: 1,
    argv: input.argv,
    cwd: input.cwd,
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    output: { stdout: "", stderr, combined: stderr, stdoutTruncated: false, stderrTruncated: false, combinedTruncated: false },
  };
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
