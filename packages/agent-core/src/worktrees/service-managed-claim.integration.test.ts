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

test("synchronous Git runner retains bounded output with truthful metadata", async () => {
  const result = await gitRunner.run({
    argv: [process.execPath, "-e", 'process.stdout.write("abcdefghijkl")'],
    maxOutputBytes: 6,
  });

  expect(result.kind).toBe("success");
  if (result.kind !== "success") return;
  expect(result.output).toMatchObject({
    stdout: "abcjkl",
    stderr: "",
    combined: "abcjkl",
    stdoutTruncated: true,
    stderrTruncated: false,
    combinedTruncated: true,
    maxOutputBytes: 6,
    stdoutBytes: 12,
    stderrBytes: 0,
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
      const maxBuffer = input.maxOutputBytes === undefined
        ? undefined
        : input.maxOutputBytes * 2;
      const result = Bun.spawnSync([...input.argv], {
        cwd: input.cwd,
        env: input.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: input.signal,
        timeout: input.timeoutMs,
        // ProcessRunner's budget is per stream; Bun's maxBuffer covers the
        // process, so allow one budget for stdout and one for stderr.
        maxBuffer,
      });
      const finishedAt = Date.now();
      const stdout = captureSyncOutput(result.stdout, input.maxOutputBytes);
      const stderr = captureSyncOutput(result.stderr, input.maxOutputBytes);
      const combined = captureSyncOutput(
        Buffer.concat([stdout.retained, stderr.retained]),
        input.maxOutputBytes,
      );
      const base = {
        argv: input.argv,
        cwd: input.cwd,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        output: {
          stdout: stdout.text,
          stderr: stderr.text,
          combined: combined.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          combinedTruncated: stdout.truncated
            || stderr.truncated
            || combined.truncated
            || result.exitedDueToMaxBuffer === true,
          maxOutputBytes: input.maxOutputBytes,
          stdoutBytes: stdout.observedBytes,
          stderrBytes: stderr.observedBytes,
          sinkStatus: "unused" as const,
        },
      };

      if (result.exitCode === 0) return { ...base, kind: "success", exitCode: 0 };
      return { ...base, kind: "nonzero", exitCode: result.exitCode };
    },
  };
}

function captureSyncOutput(
  source: Uint8Array,
  maxOutputBytes: number | undefined,
): {
  readonly retained: Uint8Array;
  readonly text: string;
  readonly observedBytes: number;
  readonly truncated: boolean;
} {
  if (maxOutputBytes === undefined || source.byteLength <= maxOutputBytes) {
    return {
      retained: source,
      text: new TextDecoder().decode(source),
      observedBytes: source.byteLength,
      truncated: false,
    };
  }

  const headBytes = Math.ceil(maxOutputBytes / 2);
  const tailBytes = maxOutputBytes - headBytes;
  const retained = new Uint8Array(maxOutputBytes);
  retained.set(source.subarray(0, headBytes));
  retained.set(source.subarray(source.byteLength - tailBytes), headBytes);
  return {
    retained,
    text: new TextDecoder().decode(retained),
    observedBytes: source.byteLength,
    truncated: true,
  };
}
