import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProcessRunner } from "../process/types";
import { createTestTempRoot } from "../testing/test-temp-root";
import { WorktreeService } from "./service";

const testTempRoot = createTestTempRoot("worktree-managed-claim");
const gitRunner = createSynchronousGitRunner();
const repo = join(testTempRoot.path, "validate-managed-claim");

beforeAll(async () => {
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "worktree-test@example.com"]);
  await git(repo, ["config", "user.name", "Worktree Test"]);
  await writeFile(join(repo, "README.md"), "# validate-managed-claim\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial commit"]);
});

afterAll(() => testTempRoot.cleanup());

test("validates a persisted managed claim when HEAD descends from its recorded base", async () => {
  const service = new WorktreeService({ canonicalRoot: repo, git: gitRunner });
  const created = await service.create({ owner: { id: "session-claim-descendant" } });
  await writeFile(join(created.worktreePath, "committed.txt"), "descendant\n");
  await git(created.worktreePath, ["add", "committed.txt"]);
  await git(created.worktreePath, ["commit", "-m", "descendant commit"]);
  await writeFile(join(created.worktreePath, "dirty.txt"), "dirty retry state\n");
  const expectedHeadSha = await git(created.worktreePath, ["rev-parse", "HEAD"]);

  await expect(service.validateManagedClaim({
    path: created.worktreePath,
    branchName: created.branchName,
    mode: "persisted",
    baseSha: created.baseSha,
  })).resolves.toMatchObject({
    worktree: { path: created.worktreePath, branchName: created.branchName, isManaged: true },
    status: { dirty: true },
    headSha: expectedHeadSha,
    baseSha: created.baseSha,
  });
});

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

/**
 * This scenario exercises WorktreeService against real Git without also
 * exercising Bun's flaky bun:test + asynchronous piped-spawn path.
 * https://github.com/oven-sh/bun/issues/24690
 */
function createSynchronousGitRunner(): ProcessRunner {
  return {
    async run(input) {
      const startedAt = Date.now();
      const result = Bun.spawnSync([...input.argv], {
        cwd: input.cwd,
        env: input.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: input.signal,
        timeout: input.timeoutMs,
      });
      const finishedAt = Date.now();
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      const base = {
        argv: input.argv,
        cwd: input.cwd,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        output: {
          stdout,
          stderr,
          combined: `${stdout}${stderr}`,
          stdoutTruncated: false,
          stderrTruncated: false,
          combinedTruncated: false,
          maxOutputBytes: input.maxOutputBytes,
          stdoutBytes: result.stdout.byteLength,
          stderrBytes: result.stderr.byteLength,
          sinkStatus: "unused" as const,
        },
      };

      if (result.exitCode === 0) return { ...base, kind: "success", exitCode: 0 };
      return { ...base, kind: "nonzero", exitCode: result.exitCode };
    },
  };
}
