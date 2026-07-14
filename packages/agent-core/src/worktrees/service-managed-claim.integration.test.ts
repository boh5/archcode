import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createProcessRunner } from "../process/runner";
import { createTestTempRoot } from "../testing/test-temp-root";
import { WorktreeService } from "./service";

const testTempRoot = createTestTempRoot("worktree-managed-claim");
const gitRunner = createProcessRunner();
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
  const service = new WorktreeService({ canonicalRoot: repo });
  const created = await service.create({ owner: { type: "goal", id: "goal-claim-descendant" } });
  await writeFile(join(created.worktreePath, "committed.txt"), "descendant\n");
  await git(created.worktreePath, ["add", "committed.txt"]);
  await git(created.worktreePath, ["commit", "-m", "descendant commit"]);
  await writeFile(join(created.worktreePath, "dirty.txt"), "dirty retry state\n");

  await expect(service.validateManagedClaim({
    path: created.worktreePath,
    branchName: created.branchName,
    mode: "persisted",
    baseSha: created.baseSha,
  })).resolves.toMatchObject({
    worktree: { path: created.worktreePath, branchName: created.branchName, isManaged: true },
    status: { dirty: true },
    headSha: await git(created.worktreePath, ["rev-parse", "HEAD"]),
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
