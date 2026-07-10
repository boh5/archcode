import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import { createProcessRunner } from "../process/runner";
import type { ProcessRunner, ProcessRunnerResult } from "../process/types";
import { isContained } from "../utils/safe-file";
import {
  managedWorktreeNames,
  WorktreeService,
  WorktreeServiceError,
  type WorktreeRemoveWarning,
} from "../worktrees";
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
  | "WORKTREE_NOT_REGISTERED"
  | "WORKTREE_CHANGED"
  | "WORKTREE_BRANCH_MISMATCH"
  | "GIT_COMMAND_FAILED"
  | "UNSAFE_ARTIFACT_PATH";

export type LoopWorktreeJobClass = "local" | "remote";

export interface LoopWorktreeManagerOptions {
  readonly canonicalRoot: string;
  readonly git?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly service?: Pick<WorktreeService, "create" | "findManaged" | "validate" | "validateManagedClaim" | "status" | "remove">;
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

export interface LoopWorktreeReuseInput extends LoopWorktreeCreateInput {
  readonly worktreePath: string;
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
  /** Runs after the final safety inspection and immediately before Git removal. */
  readonly beforeRemove?: () => Promise<void>;
  /** Runs before the repository lifecycle lock is released when detach fails. */
  readonly onRemoveFailureBeforeDetach?: () => Promise<void>;
  /** Marks the removal irreversible immediately after detach succeeds. */
  readonly onRemoveDetached?: () => Promise<void>;
}

export interface LoopWorktreeCleanupResult {
  readonly cleanupState: LoopCleanupState;
  readonly removed: boolean;
  readonly reviewRequired: boolean;
  readonly reason: string;
  readonly worktreePath: string;
  readonly branchDeleted?: boolean;
  readonly warning?: WorktreeRemoveWarning;
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
  readonly #service: Pick<WorktreeService, "create" | "findManaged" | "validate" | "validateManagedClaim" | "status" | "remove">;

  constructor(options: LoopWorktreeManagerOptions) {
    this.#canonicalRootInput = resolve(options.canonicalRoot);
    this.#git = options.git ?? createProcessRunner();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#service = options.service ?? new WorktreeService(options);
  }

  async create(input: LoopWorktreeCreateInput): Promise<LoopWorktreeCreateResult> {
    try {
      const orphan = await this.#adoptPreCheckpointOrphan(input);
      if (orphan !== undefined) return orphan;
      return await this.#service.create({
        owner: { type: "loop", id: input.loopSlug },
        label: input.subjectSlug,
        uniqueId: input.jobId,
        baseSha: input.baseSha,
        requireCleanCanonical: (input.jobClass ?? "local") === "local",
      });
    } catch (error) {
      if (!(error instanceof WorktreeServiceError)) throw error;
      if (error.code === "WORKTREE_PATH_EXISTS") {
        const racedOrphan = await this.#adoptPreCheckpointOrphan(input);
        if (racedOrphan !== undefined) return racedOrphan;
      }
      throw new LoopWorktreeManagerError(loopCreateErrorCode(error.code), error.message, error.details, error);
    }
  }

  async reuse(input: LoopWorktreeReuseInput): Promise<LoopWorktreeCreateResult> {
    try {
      const root = await this.#resolveCanonicalRoot();
      const managed = await this.#managedRootFor(root.canonicalRoot);
      const expected = managedWorktreeNames({
        owner: { type: "loop", id: input.loopSlug },
        label: input.subjectSlug,
        uniqueId: input.jobId,
        baseSha: input.baseSha,
      });
      const claim = await this.#service.validateManagedClaim({
        path: input.worktreePath,
        branchName: expected.branchName,
        mode: "persisted",
        baseSha: input.baseSha,
      });
      const existing = claim.worktree;
      const expectedPath = resolve(managed.managedRoot, expected.worktreeName);
      if (!existing.isManaged || existing.path !== expectedPath || existing.branchName !== expected.branchName) {
        throw new LoopWorktreeManagerError("WORKTREE_BRANCH_MISMATCH", "Persisted Loop worktree no longer matches its managed branch", {
          path: existing.path,
          expectedPath,
          expectedBranch: expected.branchName,
          actualBranch: existing.branchName,
        });
      }
      return {
        canonicalRoot: root.canonicalRoot,
        managedRoot: managed.managedRoot,
        worktreePath: existing.path,
        worktreeName: basename(existing.path),
        branchName: expected.branchName,
        baseSha: claim.baseSha,
        resolvedHeadSha: claim.headSha,
        canonicalStatus: await this.#status(root.canonicalRoot),
      };
    } catch (error) {
      if (error instanceof LoopWorktreeManagerError) throw error;
      if (!(error instanceof WorktreeServiceError)) throw error;
      throw new LoopWorktreeManagerError(loopCreateErrorCode(error.code), error.message, error.details, error);
    }
  }

  async #adoptPreCheckpointOrphan(input: LoopWorktreeCreateInput): Promise<LoopWorktreeCreateResult | undefined> {
    const owner = { type: "loop" as const, id: input.loopSlug };
    const existing = await this.#service.findManaged({ owner, uniqueId: input.jobId });
    if (existing === undefined) return undefined;

    const root = await this.#resolveCanonicalRoot();
    const managed = await this.#managedRootFor(root.canonicalRoot);
    const expected = managedWorktreeNames({ owner, label: input.subjectSlug, uniqueId: input.jobId, baseSha: input.baseSha });
    const expectedPath = resolve(managed.managedRoot, expected.worktreeName);
    // The base SHA is already durably write-ahead checkpointed even though the
    // path is not. Use the common persisted-claim proof to validate the
    // registered HEAD/branch pair and ancestry under one Git lifecycle lock,
    // then apply the stricter orphan requirement to that same snapshot.
    const claim = await this.#service.validateManagedClaim({
      path: existing.path,
      branchName: expected.branchName,
      mode: "persisted",
      baseSha: input.baseSha,
    });
    if (claim.worktree.path !== expectedPath || claim.worktree.branchName !== expected.branchName) {
      throw new LoopWorktreeManagerError("WORKTREE_BRANCH_MISMATCH", "Refusing to adopt a Loop worktree outside the deterministic job path", {
        expectedPath,
        actualPath: claim.worktree.path,
        expectedBranch: expected.branchName,
        actualBranch: claim.worktree.branchName,
      });
    }

    if (claim.headSha !== claim.baseSha || claim.status.dirty) {
      throw new LoopWorktreeManagerError("WORKTREE_CHANGED", "Refusing to adopt a changed Loop worktree that was not checkpointed", {
        worktreePath: claim.worktree.path,
        branchName: claim.worktree.branchName,
        expectedHeadSha: claim.baseSha,
        actualHeadSha: claim.headSha,
        dirty: claim.status.dirty,
      });
    }

    return {
      canonicalRoot: root.canonicalRoot,
      managedRoot: managed.managedRoot,
      worktreePath: claim.worktree.path,
      worktreeName: expected.worktreeName,
      branchName: expected.branchName,
      baseSha: claim.baseSha,
      resolvedHeadSha: claim.headSha,
      canonicalStatus: await this.#status(root.canonicalRoot),
    };
  }

  async inspect(input: LoopWorktreeInspectionInput): Promise<LoopWorktreeInspection> {
    const root = await this.#resolveCanonicalRoot();
    const managed = await this.#managedRootFor(root.canonicalRoot);
    const worktreePath = resolve(input.worktreePath);
    await this.#assertRealPathContained(worktreePath, managed.managedRoot, "WORKTREE_PATH_ESCAPE");
    let registered: Awaited<ReturnType<WorktreeService["validate"]>>;
    try {
      registered = await this.#service.validate(worktreePath);
    } catch (error) {
      if (!(error instanceof WorktreeServiceError)) throw error;
      throw new LoopWorktreeManagerError(loopCreateErrorCode(error.code), error.message, error.details, error);
    }
    if (!registered.isManaged || registered.branchName !== input.branchName) {
      throw new LoopWorktreeManagerError("WORKTREE_BRANCH_MISMATCH", "Loop worktree path does not match the expected registered branch", {
        worktreePath: registered.path,
        expectedBranch: input.branchName,
        actualBranch: registered.branchName,
      });
    }
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

    let removal;
    try {
      removal = await this.#service.remove({
        path: currentInspection.worktreePath,
        branchName: currentInspection.branchName,
        baseSha: currentInspection.baseSha,
        ...(input.beforeRemove === undefined ? {} : { beforeRemove: input.beforeRemove }),
        ...(input.onRemoveFailureBeforeDetach === undefined
          ? {}
          : { onRemoveFailureBeforeDetach: input.onRemoveFailureBeforeDetach }),
        ...(input.onRemoveDetached === undefined ? {} : { onRemoveDetached: input.onRemoveDetached }),
      });
    } catch (error) {
      if (!(error instanceof WorktreeServiceError)) throw error;
      throw new LoopWorktreeManagerError(loopCreateErrorCode(error.code), error.message, error.details, error);
    }

    return {
      cleanupState: "cleaned",
      removed: true,
      reviewRequired: false,
      reason: removal.warning?.message ?? "worktree had no changes",
      worktreePath: currentInspection.worktreePath,
      branchDeleted: removal.branchDeleted,
      ...(removal.warning === undefined ? {} : { warning: removal.warning }),
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
    const stdout = await this.#gitStdout(
      cwd,
      ["status", "--porcelain=v1", "-z", "--ignored=matching"],
      "inspect git status including ignored files",
    );
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

function loopCreateErrorCode(code: WorktreeServiceError["code"]): LoopWorktreeErrorCode {
  switch (code) {
    case "INVALID_CANONICAL_ROOT":
    case "BARE_REPOSITORY":
    case "CANONICAL_ROOT_MISMATCH":
    case "CANONICAL_DIRTY":
    case "MISSING_BASE_SHA":
    case "INVALID_BASE_SHA":
    case "BASE_SHA_NOT_FOUND":
    case "WORKTREE_PATH_ESCAPE":
    case "WORKTREE_PATH_EXISTS":
    case "WORKTREE_NOT_REGISTERED":
    case "WORKTREE_CHANGED":
    case "WORKTREE_BRANCH_MISMATCH":
    case "GIT_COMMAND_FAILED":
      return code;
    default:
      return "GIT_COMMAND_FAILED";
  }
}

export const LOOP_EMPTY_TREE_SHA_FOR_TESTS = EMPTY_TREE_SHA;
