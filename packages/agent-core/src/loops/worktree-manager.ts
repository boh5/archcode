import { lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import { createProcessRunner } from "../process/runner";
import type { ProcessRunner, ProcessRunnerResult } from "../process/types";
import { isContained } from "../utils/safe-file";
import type { LoopCleanupState, LoopJobStatus, LoopWorktreeArtifact } from "./state";

export type LoopWorktreeErrorCode =
  | "INVALID_CANONICAL_ROOT"
  | "BARE_REPOSITORY"
  | "CANONICAL_ROOT_MISMATCH"
  | "CANONICAL_DIRTY"
  | "MISSING_BASE_SHA"
  | "INVALID_BASE_SHA"
  | "BASE_SHA_NOT_FOUND"
  | "WORKTREE_PATH_ESCAPE"
  | "WORKTREE_PATH_EXISTS"
  | "GIT_COMMAND_FAILED"
  | "UNSAFE_ARTIFACT_PATH";

export type LoopWorktreeJobClass = "local" | "remote";

export interface LoopWorktreeManagerOptions {
  readonly canonicalRoot: string;
  readonly git?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface LoopWorktreeCreateInput {
  readonly loopSlug: string;
  readonly subjectSlug: string;
  readonly jobId: string;
  readonly baseSha: string;
  readonly jobClass?: LoopWorktreeJobClass;
}

export interface LoopWorktreeCreateResult {
  readonly canonicalRoot: string;
  readonly managedRoot: string;
  readonly worktreePath: string;
  readonly worktreeName: string;
  readonly branchName: string;
  readonly baseSha: string;
  readonly resolvedHeadSha: string;
  readonly canonicalStatus: LoopGitStatusSnapshot;
}

export interface LoopGitStatusSnapshot {
  readonly dirty: boolean;
  readonly entries: readonly LoopGitStatusEntry[];
}

export interface LoopGitStatusEntry {
  readonly path: string;
  readonly index: string;
  readonly worktree: string;
  readonly raw: string;
}

export interface LoopWorktreeInspectionInput {
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseSha: string;
  readonly evidencePaths?: readonly string[];
}

export interface LoopWorktreeInspection {
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly status: LoopGitStatusSnapshot;
  readonly untrackedFiles: readonly string[];
  readonly localCommitsAhead: number;
  readonly changedRefs: readonly LoopChangedRef[];
  readonly diffStats: LoopWorktreeDiffStats;
  readonly evidenceArtifacts: readonly LoopWorktreeArtifact[];
  readonly hasChanges: boolean;
}

export interface LoopChangedRef {
  readonly ref: string;
  readonly before: string;
  readonly after: string;
}

export interface LoopWorktreeDiffStats {
  readonly committed: string;
  readonly workingTree: string;
}

export interface LoopWorktreeCleanupInput {
  readonly inspection: LoopWorktreeInspection;
  readonly jobStatus?: LoopJobStatus;
}

export interface LoopWorktreeCleanupResult {
  readonly cleanupState: LoopCleanupState;
  readonly removed: boolean;
  readonly reviewRequired: boolean;
  readonly reason: string;
  readonly worktreePath: string;
}

export class LoopWorktreeManagerError extends Error {
  constructor(
    public readonly code: LoopWorktreeErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LoopWorktreeManagerError";
  }
}

type LoopGitCompletedResult = Exclude<ProcessRunnerResult, { readonly kind: "spawn-failure" }>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_WORKTREE_NAME_LENGTH = 120;
const MAX_LOOP_BRANCH_SEGMENT_LENGTH = 64;
const MAX_SUBJECT_SEGMENT_LENGTH = 48;
const MAX_LOOP_NAME_SEGMENT_LENGTH = 48;
const MIN_SHORT_JOB_ID_LENGTH = 8;
const MAX_SHORT_JOB_ID_LENGTH = 12;
const FULL_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class LoopWorktreeManager {
  readonly #canonicalRootInput: string;
  readonly #git: ProcessRunner;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: LoopWorktreeManagerOptions) {
    this.#canonicalRootInput = resolve(options.canonicalRoot);
    this.#git = options.git ?? createProcessRunner();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async create(input: LoopWorktreeCreateInput): Promise<LoopWorktreeCreateResult> {
    const root = await this.#resolveCanonicalRoot();
    const canonicalStatus = await this.#status(root.canonicalRoot);
    if ((input.jobClass ?? "local") === "local" && canonicalStatus.dirty) {
      throw new LoopWorktreeManagerError("CANONICAL_DIRTY", "Canonical checkout must be clean before creating a loop worktree", {
        canonicalRoot: root.canonicalRoot,
        entries: canonicalStatus.entries,
      });
    }

    const baseSha = await this.#resolveBaseSha(root.canonicalRoot, input.baseSha);
    const managed = await this.#managedRootFor(root.canonicalRoot);
    const names = worktreeNames(input);
    const worktreePath = resolve(managed.managedRoot, names.worktreeName);
    await this.#assertContainedPath(worktreePath, managed.managedRoot, "WORKTREE_PATH_ESCAPE");
    await this.#assertPathDoesNotExist(worktreePath);
    await mkdir(managed.managedRoot, { recursive: true });
    await this.#assertRealPathContained(managed.managedRoot, managed.parentRoot, "WORKTREE_PATH_ESCAPE");

    await this.#gitSuccess(root.canonicalRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${names.branchName}`], {
      allowNonZero: true,
      operation: "check branch availability",
    }).then((result) => {
      if (result.kind === "success") {
        throw new LoopWorktreeManagerError("WORKTREE_PATH_EXISTS", "Loop technical branch already exists", {
          branchName: names.branchName,
        });
      }
    });

    await this.#gitSuccess(root.canonicalRoot, ["worktree", "add", "-b", names.branchName, worktreePath, baseSha], {
      operation: "create loop worktree",
    });
    await this.#assertRealPathContained(worktreePath, managed.managedRoot, "WORKTREE_PATH_ESCAPE");
    const resolvedHeadSha = await this.#gitStdout(worktreePath, ["rev-parse", "--verify", "HEAD"], "resolve worktree HEAD");

    return {
      canonicalRoot: root.canonicalRoot,
      managedRoot: managed.managedRoot,
      worktreePath,
      worktreeName: names.worktreeName,
      branchName: names.branchName,
      baseSha,
      resolvedHeadSha: resolvedHeadSha.trim(),
      canonicalStatus,
    };
  }

  async inspect(input: LoopWorktreeInspectionInput): Promise<LoopWorktreeInspection> {
    const root = await this.#resolveCanonicalRoot();
    const managed = await this.#managedRootFor(root.canonicalRoot);
    const worktreePath = resolve(input.worktreePath);
    await this.#assertRealPathContained(worktreePath, managed.managedRoot, "WORKTREE_PATH_ESCAPE");
    const baseSha = await this.#resolveBaseSha(root.canonicalRoot, input.baseSha);
    const status = await this.#status(worktreePath);
    const headSha = (await this.#gitStdout(worktreePath, ["rev-parse", "--verify", "HEAD"], "resolve inspected HEAD")).trim();
    const localCommitsAhead = Number((await this.#gitStdout(worktreePath, ["rev-list", "--count", `${baseSha}..HEAD`], "count local commits")).trim() || "0");
    const committed = await this.#gitStdout(worktreePath, ["diff", "--stat", "--summary", `${baseSha}..HEAD`], "collect committed diff stats");
    const workingTree = await this.#gitStdout(worktreePath, ["diff", "--stat", "--summary", "HEAD"], "collect working tree diff stats");
    const changedRefs = headSha === baseSha
      ? []
      : [{ ref: `refs/heads/${input.branchName}`, before: baseSha, after: headSha }];
    const evidenceArtifacts = await this.#inspectEvidencePaths(worktreePath, status, input.evidencePaths ?? []);
    const hasChanges = status.dirty || localCommitsAhead > 0 || changedRefs.length > 0;

    return {
      worktreePath,
      branchName: input.branchName,
      baseSha,
      headSha,
      status,
      untrackedFiles: status.entries.filter((entry) => entry.index === "?" && entry.worktree === "?").map((entry) => entry.path),
      localCommitsAhead,
      changedRefs,
      diffStats: { committed, workingTree },
      evidenceArtifacts,
      hasChanges,
    };
  }

  async cleanup(input: LoopWorktreeCleanupInput): Promise<LoopWorktreeCleanupResult> {
    const root = await this.#resolveCanonicalRoot();
    const managed = await this.#managedRootFor(root.canonicalRoot);
    await this.#assertContainedPath(input.inspection.worktreePath, managed.managedRoot, "WORKTREE_PATH_ESCAPE");
    await this.#assertRealPathContained(input.inspection.worktreePath, managed.managedRoot, "WORKTREE_PATH_ESCAPE");
    this.#assertLoopBranchName(input.inspection.branchName);
    const currentInspection = await this.inspect({
      worktreePath: input.inspection.worktreePath,
      branchName: input.inspection.branchName,
      baseSha: input.inspection.baseSha,
      evidencePaths: input.inspection.evidenceArtifacts.map((artifact) => artifact.path),
    });
    const changed = currentInspection.hasChanges;
    const failedOrBlocked = input.jobStatus === "failed" || input.jobStatus === "blocked" || input.jobStatus === "needs_user";
    if (changed || failedOrBlocked) {
      return {
        cleanupState: "preserved",
        removed: false,
        reviewRequired: true,
        reason: changed ? "worktree contains changes" : `job ended with ${input.jobStatus}`,
        worktreePath: currentInspection.worktreePath,
      };
    }

    await this.#gitSuccess(root.canonicalRoot, ["worktree", "remove", currentInspection.worktreePath], {
      operation: "remove unchanged loop worktree",
    });
    await this.#gitSuccess(root.canonicalRoot, ["branch", "-D", currentInspection.branchName], {
      allowNonZero: true,
      operation: "delete unchanged loop branch",
    });
    await rm(currentInspection.worktreePath, { recursive: true, force: true }).catch(() => undefined);

    return {
      cleanupState: "cleaned",
      removed: true,
      reviewRequired: false,
      reason: "worktree had no changes",
      worktreePath: currentInspection.worktreePath,
    };
  }

  async #resolveCanonicalRoot(): Promise<{ canonicalRoot: string }> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.#canonicalRootInput);
      const rootStat = await stat(canonicalRoot);
      if (!rootStat.isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new LoopWorktreeManagerError("INVALID_CANONICAL_ROOT", "Canonical root must be an existing directory", {
        canonicalRoot: this.#canonicalRootInput,
      }, error);
    }

    const inside = (await this.#gitStdout(canonicalRoot, ["rev-parse", "--is-inside-work-tree"], "validate git checkout")).trim();
    if (inside !== "true") {
      throw new LoopWorktreeManagerError("INVALID_CANONICAL_ROOT", "Canonical root must be inside a git work tree", { canonicalRoot });
    }
    const bare = (await this.#gitStdout(canonicalRoot, ["rev-parse", "--is-bare-repository"], "validate non-bare repository")).trim();
    if (bare === "true") {
      throw new LoopWorktreeManagerError("BARE_REPOSITORY", "Canonical root must be a non-bare git repository", { canonicalRoot });
    }
    const gitTopLevel = await realpath((await this.#gitStdout(canonicalRoot, ["rev-parse", "--show-toplevel"], "resolve git top-level")).trim());
    if (gitTopLevel !== canonicalRoot) {
      throw new LoopWorktreeManagerError("CANONICAL_ROOT_MISMATCH", "Canonical root must be the git top-level directory", {
        canonicalRoot,
        gitTopLevel,
      });
    }

    return { canonicalRoot };
  }

  async #managedRootFor(canonicalRoot: string): Promise<{ managedRoot: string; parentRoot: string }> {
    const parentRoot = await realpath(dirname(canonicalRoot));
    const managedRoot = resolve(parentRoot, `${basename(canonicalRoot)}.worktrees`);
    if (isContained(managedRoot, canonicalRoot) || managedRoot === canonicalRoot) {
      throw new LoopWorktreeManagerError("WORKTREE_PATH_ESCAPE", "Managed worktree root must be outside the canonical repository", {
        canonicalRoot,
        managedRoot,
      });
    }
    await this.#assertContainedPath(managedRoot, parentRoot, "WORKTREE_PATH_ESCAPE");
    await this.#assertNoEscapingSymlink(managedRoot, parentRoot);
    return { managedRoot, parentRoot };
  }

  async #resolveBaseSha(cwd: string, baseSha: string): Promise<string> {
    const trimmed = baseSha.trim();
    if (trimmed.length === 0) {
      throw new LoopWorktreeManagerError("MISSING_BASE_SHA", "Loop worktree creation requires an explicit base SHA");
    }
    if (!FULL_SHA_PATTERN.test(trimmed)) {
      throw new LoopWorktreeManagerError("INVALID_BASE_SHA", "Loop worktree base must be a full commit SHA, not a branch or remote ref", { baseSha });
    }

    const exists = await this.#gitSuccess(cwd, ["cat-file", "-e", `${trimmed}^{commit}`], {
      allowNonZero: true,
      operation: "verify base SHA exists",
    });
    if (exists.kind !== "success") {
      throw new LoopWorktreeManagerError("BASE_SHA_NOT_FOUND", "Loop worktree base SHA does not resolve to a commit", { baseSha });
    }
    return (await this.#gitStdout(cwd, ["rev-parse", "--verify", `${trimmed}^{commit}`], "resolve base SHA")).trim();
  }

  async #status(cwd: string): Promise<LoopGitStatusSnapshot> {
    const stdout = await this.#gitStdout(cwd, ["status", "--porcelain=v1", "-z"], "inspect git status");
    const entries = parsePorcelainStatus(stdout);
    return { dirty: entries.length > 0, entries };
  }

  async #inspectEvidencePaths(
    worktreePath: string,
    status: LoopGitStatusSnapshot,
    evidencePaths: readonly string[],
  ): Promise<LoopWorktreeArtifact[]> {
    const artifacts: LoopWorktreeArtifact[] = [];
    for (const evidencePath of evidencePaths) {
      const resolvedPath = resolve(worktreePath, evidencePath);
      await this.#assertContainedPath(resolvedPath, worktreePath, "UNSAFE_ARTIFACT_PATH");
      const relativePath = toGitRelativePath(worktreePath, resolvedPath);
      let exists = true;
      try {
        await this.#assertRealPathContained(resolvedPath, worktreePath, "UNSAFE_ARTIFACT_PATH");
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        exists = false;
      }

      if (!exists) {
        artifacts.push({ path: relativePath, status: "deleted" });
        continue;
      }

      const fileStat = await stat(resolvedPath);
      const statusEntry = status.entries.find((entry) => entry.path === relativePath);
      const artifactStatus = statusEntry === undefined
        ? "observed"
        : statusEntry.index === "?" && statusEntry.worktree === "?" ? "created" : "modified";
      const sha = fileStat.isFile()
        ? (await this.#gitStdout(worktreePath, ["hash-object", "--", relativePath], "hash evidence artifact")).trim()
        : undefined;
      artifacts.push({ path: relativePath, status: artifactStatus, sizeBytes: fileStat.size, sha });
    }
    return artifacts;
  }

  async #assertContainedPath(path: string, root: string, code: LoopWorktreeErrorCode): Promise<void> {
    if (!isContained(path, root)) {
      throw new LoopWorktreeManagerError(code, "Path escapes the allowed root", { path, root });
    }
  }

  async #assertRealPathContained(path: string, root: string, code: LoopWorktreeErrorCode): Promise<void> {
    const realRoot = await realpath(root);
    const realPath = await realpath(path);
    if (!isContained(realPath, realRoot)) {
      throw new LoopWorktreeManagerError(code, "Real path escapes the allowed root", { path, realPath, root, realRoot });
    }
  }

  async #assertNoEscapingSymlink(path: string, root: string): Promise<void> {
    let pathStat;
    try {
      pathStat = await lstat(path);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    if (!pathStat.isSymbolicLink()) return;
    throw new LoopWorktreeManagerError("WORKTREE_PATH_ESCAPE", "Managed worktree root must not be a symlink", { path, root });
  }

  async #assertPathDoesNotExist(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    throw new LoopWorktreeManagerError("WORKTREE_PATH_EXISTS", "Loop worktree path already exists", { path });
  }

  #assertLoopBranchName(branchName: string): void {
    if (!branchName.startsWith("archcode/loop/")) {
      throw new LoopWorktreeManagerError("WORKTREE_PATH_ESCAPE", "Cleanup branch must be a loop technical branch", { branchName });
    }
  }

  async #gitStdout(cwd: string, args: readonly string[], operation: string): Promise<string> {
    const result = await this.#gitSuccess(cwd, args, { operation });
    return result.output.stdout;
  }

  async #gitSuccess(
    cwd: string,
    args: readonly string[],
    options: { readonly operation: string; readonly allowNonZero?: boolean },
  ): Promise<LoopGitCompletedResult> {
    const result = await this.#git.run({
      argv: ["git", ...args],
      cwd,
      env: lockedGitEnv(cwd),
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
    });
    if (result.kind === "success" || (options.allowNonZero === true && result.kind === "nonzero")) return result;
    throw new LoopWorktreeManagerError("GIT_COMMAND_FAILED", `Git command failed during ${options.operation}`, {
      cwd,
      args,
      resultKind: result.kind,
      output: outputFromGitResult(result),
    });
  }
}

export function worktreeNames(input: Pick<LoopWorktreeCreateInput, "loopSlug" | "subjectSlug" | "jobId">): {
  readonly worktreeName: string;
  readonly branchName: string;
  readonly shortJobId: string;
} {
  const loop = safeSegment(input.loopSlug, "loop", MAX_LOOP_NAME_SEGMENT_LENGTH);
  const subject = safeSegment(input.subjectSlug, "subject", MAX_SUBJECT_SEGMENT_LENGTH);
  const shortJobId = safeSegment(input.jobId, "job", MAX_SHORT_JOB_ID_LENGTH).slice(0, MAX_SHORT_JOB_ID_LENGTH);
  const paddedJobId = shortJobId.length >= MIN_SHORT_JOB_ID_LENGTH ? shortJobId : `${shortJobId}${"0".repeat(MIN_SHORT_JOB_ID_LENGTH - shortJobId.length)}`;
  const baseName = `${loop}-${subject}-${paddedJobId}`;
  return {
    worktreeName: baseName.slice(0, MAX_WORKTREE_NAME_LENGTH).replace(/-+$/g, "") || `loop-${paddedJobId}`,
    branchName: `archcode/loop/${safeSegment(input.loopSlug, "loop", MAX_LOOP_BRANCH_SEGMENT_LENGTH)}/${paddedJobId}`,
    shortJobId: paddedJobId,
  };
}

export function parsePorcelainStatus(output: string): LoopGitStatusEntry[] {
  if (output.length === 0) return [];
  return output.split("\0").filter(Boolean).map((raw) => {
    const index = raw[0] ?? " ";
    const worktree = raw[1] ?? " ";
    const path = raw.slice(3);
    return { path, index, worktree, raw };
  });
}

function safeSegment(value: string, fallback: string, maxLength: number): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, maxLength)
    .replace(/^[.-]+|[.-]+$/g, "");
  if (sanitized === "" || sanitized === "." || sanitized === "..") return fallback;
  return sanitized;
}

function lockedGitEnv(cwd: string): Record<string, string | undefined> {
  return {
    PATH: Bun.env.PATH,
    HOME: Bun.env.HOME,
    TMPDIR: Bun.env.TMPDIR,
    LANG: Bun.env.LANG ?? "C.UTF-8",
    LC_ALL: Bun.env.LC_ALL,
    PWD: cwd,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function toGitRelativePath(root: string, path: string): string {
  const relativePath = relative(root, path).split(sep).join("/");
  return relativePath === "" ? "." : relativePath;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function outputFromGitResult(result: ProcessRunnerResult): string | undefined {
  if (result.kind === "spawn-failure") return undefined;
  return result.output.combined;
}

export const LOOP_EMPTY_TREE_SHA_FOR_TESTS = EMPTY_TREE_SHA;
