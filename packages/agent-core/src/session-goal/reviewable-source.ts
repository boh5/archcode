import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const INTERNAL_DIRECTORIES = new Set([".archcode", ".git"]);

/**
 * The one authoritative source universe for a review attempt.
 *
 * In Git workspaces it exactly follows Git's reviewable set: tracked files plus
 * untracked files not excluded by ignore rules. That means a tracked dist file
 * stays reviewable, while an ignored cache never invalidates a review. Outside
 * Git, every workspace file except ArchCode/Git control state is reviewable.
 */
export class ReviewableSourceSet {
  readonly #paths: ReadonlySet<string>;

  private constructor(
    readonly cwd: string,
    readonly isGitWorkspace: boolean,
    paths: ReadonlySet<string>,
  ) {
    this.#paths = paths;
  }

  get paths(): ReadonlySet<string> {
    return this.#paths;
  }

  async listWatchDirectories(): Promise<readonly string[]> {
    const directories = [this.cwd];
    await this.#collectWatchDirectories(this.cwd, directories);
    return directories;
  }

  async containsEventPath(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (isInternalPath(normalized)) return false;
    if (!this.isGitWorkspace) return true;
    if (
      this.#paths.has(normalized)
      || [...this.#paths].some((candidate) => (
        candidate.startsWith(`${normalized}/`) || normalized.startsWith(`${candidate}/`)
      ))
    ) return true;
    const fileRule = await gitOutput(this.cwd, ["check-ignore", "-q", "--", normalized]);
    const directoryRule = await gitOutput(this.cwd, ["check-ignore", "-q", "--", normalized + "/"]);
    if (fileRule.exitCode === 0 || directoryRule.exitCode === 0) return false;
    if (fileRule.exitCode === 1 && directoryRule.exitCode === 1) return true;
    throw new Error(`git check-ignore failed for ${normalized || "."}`);
  }

  static async create(cwd: string): Promise<ReviewableSourceSet> {
    const inside = await gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode === 0 && inside.stdout.trim() === "true") {
      const files = await requiredGitOutput(cwd, ["ls-files", "-co", "--exclude-standard", "-z"]);
      return new ReviewableSourceSet(cwd, true, new Set(splitNul(files).filter((path) => !isInternalPath(path))));
    }
    return new ReviewableSourceSet(cwd, false, new Set(await listNonGitFiles(cwd, cwd)));
  }

  async #collectWatchDirectories(directory: string, directories: string[]): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absolute = join(directory, entry.name);
      const path = normalizePath(relative(this.cwd, absolute));
      if (!await this.containsEventPath(path)) continue;
      directories.push(absolute);
      await this.#collectWatchDirectories(absolute, directories);
    }
  }
}

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

async function listNonGitFiles(root: string, directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const path = normalizePath(relative(root, absolute));
    if (isInternalPath(path)) continue;
    if (entry.isDirectory()) result.push(...await listNonGitFiles(root, absolute));
    else result.push(path);
  }
  return result;
}

function isInternalPath(path: string): boolean {
  return path.split("/").some((segment) => INTERNAL_DIRECTORIES.has(segment));
}

export async function gitOutput(cwd: string, args: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function requiredGitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await gitOutput(cwd, args);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function splitNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}
