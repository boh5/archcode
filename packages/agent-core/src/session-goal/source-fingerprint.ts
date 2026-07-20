import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { ReviewableSourceSet } from "./reviewable-source";

/**
 * Hashes the reviewable source snapshot. In Git workspaces HEAD and the index
 * are explicit inputs, while file contents cover tracked changes and
 * non-ignored untracked files. Ignored validation caches are intentionally not
 * part of the basis.
 */
export async function computeSourceFingerprint(cwd: string): Promise<string> {
  const sources = await ReviewableSourceSet.create(cwd);
  if (sources.isGitWorkspace) return await computeGitFingerprint(cwd, sources);
  return await computeDirectoryFingerprint(cwd, sources);
}

async function computeGitFingerprint(cwd: string, sources: ReviewableSourceSet): Promise<string> {
  const [headResult, index] = await Promise.all([
    gitOutput(cwd, ["rev-parse", "HEAD"]),
    requiredGitOutput(cwd, ["ls-files", "-s", "-z"]),
  ]);
  const hash = createHash("sha256");
  hash.update("git\0head\0").update(headResult.ok ? headResult.stdout : "unborn");
  hash.update("\0index\0").update(index);
  const paths = [...sources.paths].sort();
  for (const path of paths) await hashPath(hash, cwd, path);
  return hash.digest("hex");
}

async function computeDirectoryFingerprint(cwd: string, sources: ReviewableSourceSet): Promise<string> {
  const hash = createHash("sha256");
  hash.update("directory\0");
  for (const path of [...sources.paths].sort()) await hashPath(hash, cwd, path);
  return hash.digest("hex");
}

async function hashPath(hash: ReturnType<typeof createHash>, cwd: string, path: string): Promise<void> {
  const absolute = join(cwd, path);
  hash.update("\0path\0").update(path).update("\0");
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      hash.update("symlink\0").update(await readlink(absolute));
    } else if (stat.isFile()) {
      hash.update("file\0").update(await readFile(absolute));
    } else {
      hash.update(`other:${stat.mode}\0`);
    }
  } catch (error) {
    if (isMissing(error)) hash.update("missing\0");
    else throw error;
  }
}

async function requiredGitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await gitOutput(cwd, args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

function splitNul(value: string): string[] {
  return value.split("\0").filter((item) => item.length > 0);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
