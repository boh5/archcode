import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";

import { createProcessRunner } from "../process/runner";
import type { ProcessRunner, ProcessRunnerResult } from "../process/types";
import { isContained } from "../utils/safe-file";

export type WorktreeServiceErrorCode =
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
  | "DIFFERENT_REPOSITORY"
  | "WORKTREE_CHANGED"
  | "WORKTREE_BRANCH_MISMATCH"
  | "GIT_COMMAND_FAILED";

export interface WorktreeServiceOptions {
  readonly canonicalRoot: string;
  readonly git?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface WorktreeCreateInput {
  readonly owner: {
    readonly id: string;
  };
  readonly label?: string;
  readonly uniqueId?: string;
  readonly baseSha?: string;
  readonly requireCleanCanonical?: boolean;
}

export interface WorktreeCreateResult {
  readonly canonicalRoot: string;
  readonly managedRoot: string;
  readonly worktreePath: string;
  readonly worktreeName: string;
  readonly branchName: string;
  readonly baseSha: string;
  readonly resolvedHeadSha: string;
  readonly canonicalStatus: WorktreeGitStatus;
}

export interface WorktreeGitStatusEntry {
  readonly path: string;
  readonly index: string;
  readonly worktree: string;
  readonly raw: string;
}

export interface WorktreeGitStatus {
  readonly dirty: boolean;
  readonly entries: readonly WorktreeGitStatusEntry[];
}

export interface WorktreeInfo {
  readonly path: string;
  readonly headSha?: string;
  readonly branchName?: string;
  readonly isCanonical: boolean;
  readonly isManaged: boolean;
  readonly isBare: boolean;
  readonly isDetached: boolean;
  readonly isPrunable: boolean;
}

interface WorktreeManagedClaimIdentity {
  readonly path: string;
  readonly branchName: string;
}

/**
 * The validation mode encodes the proof required to claim a managed worktree.
 * Callers cannot accidentally omit the lineage checks for persisted state or
 * the clean/current-HEAD checks required for conservative orphan adoption.
 */
export type WorktreeManagedClaimInput = WorktreeManagedClaimIdentity & (
  | {
    readonly mode: "persisted";
    /** Persisted creation base; it must remain an ancestor of the branch HEAD. */
    readonly baseSha: string;
  }
  | {
    readonly mode: "orphan";
  }
);

export interface WorktreeManagedClaim {
  readonly worktree: WorktreeInfo;
  readonly status: WorktreeGitStatus;
  readonly headSha: string;
  readonly branchHeadSha: string;
  readonly canonicalHeadSha: string;
  /** Proven creation base: persisted metadata, or the unchanged canonical HEAD for an orphan. */
  readonly baseSha: string;
}

export interface WorktreeRemoveInput {
  readonly path: string;
  readonly branchName: string;
  /** Exact owner-recorded base when available. Omit for conservative admin cleanup. */
  readonly baseSha?: string;
  /** Runs inside the repository lifecycle lock after final validation and before Git removal. */
  readonly beforeRemove?: () => Promise<void>;
  /** Runs inside the same lock only when the worktree detach command fails. */
  readonly onRemoveFailureBeforeDetach?: () => Promise<void>;
  /** Runs inside the same lock immediately after worktree detach succeeds. */
  readonly onRemoveDetached?: () => Promise<void>;
}

export interface WorktreeRemoveWarning {
  readonly code: "BRANCH_DELETE_FAILED";
  readonly branchName: string;
  readonly message: string;
}

export interface WorktreeRemoveResult {
  readonly detached: true;
  readonly branchDeleted: boolean;
  readonly warning?: WorktreeRemoveWarning;
}

export interface WorktreeReconcilePreserved {
  readonly worktree: WorktreeInfo;
  readonly reason: string;
}

export interface WorktreeReconcileWarning {
  /** The stale worktree registration was detached, but this branch remains. */
  readonly worktree: WorktreeInfo;
  readonly warning: WorktreeRemoveWarning;
}

export interface WorktreeReconcileResult {
  /** Worktree registrations detached from Git, regardless of branch cleanup. */
  readonly removed: readonly WorktreeInfo[];
  readonly preserved: readonly WorktreeReconcilePreserved[];
  readonly warnings: readonly WorktreeReconcileWarning[];
}

export type ManagedWorktreeLookup = Pick<WorktreeCreateInput, "owner" | "uniqueId">;

export class WorktreeServiceError extends Error {
  constructor(
    public readonly code: WorktreeServiceErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorktreeServiceError";
  }
}

type GitCompletedResult = Exclude<ProcessRunnerResult, { readonly kind: "spawn-failure" }>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const FULL_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const MAX_NAME_LENGTH = 120;
const MAX_SEGMENT_LENGTH = 48;
const UNIQUE_ID_LENGTH = 12;
const MIN_UNIQUE_ID_LENGTH = 8;
const ARCHCODE_BRANCH_PREFIX = "archcode/";
const lifecycleQueueByCommonGitDir = new Map<string, Promise<void>>();

export class WorktreeService {
  readonly #canonicalRootInput: string;
  readonly #git: ProcessRunner;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: WorktreeServiceOptions) {
    this.#canonicalRootInput = resolve(options.canonicalRoot);
    this.#git = options.git ?? createProcessRunner();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    const canonicalRoot = await this.#resolveCanonicalRoot();
    const commonGitDir = await this.#lifecycleLockKey(canonicalRoot);
    return await withLifecycleLock(commonGitDir, async () => await this.#createLocked(canonicalRoot, input));
  }

  async #createLocked(canonicalRoot: string, input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    const canonicalStatus = userCanonicalStatus(await this.status(canonicalRoot));
    if (input.requireCleanCanonical === true && canonicalStatus.dirty) {
      throw new WorktreeServiceError("CANONICAL_DIRTY", "Canonical checkout must be clean before creating this worktree", {
        canonicalRoot,
        entries: canonicalStatus.entries,
      });
    }

    const baseSha = await this.#resolveBaseSha(canonicalRoot, input.baseSha);
    const { managedRoot, parentRoot } = await this.#managedRootFor(canonicalRoot);
    const names = managedWorktreeNames(input);
    const worktreePath = resolve(managedRoot, names.worktreeName);
    this.#assertContained(worktreePath, managedRoot);
    await this.#assertPathDoesNotExist(worktreePath);
    await mkdir(managedRoot, { recursive: true });
    await this.#assertRealContained(managedRoot, parentRoot);

    const branch = await this.#gitSuccess(canonicalRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${names.branchName}`], {
      operation: "check managed worktree branch availability",
      allowNonZero: true,
    });
    if (branch.kind === "success") {
      await this.#removeSafeDetachedBaseBranch(canonicalRoot, names.branchName, baseSha);
    }

    let added = false;
    try {
      await this.#gitSuccess(canonicalRoot, ["worktree", "add", "-b", names.branchName, worktreePath, baseSha], {
        operation: "create managed worktree",
      });
      added = true;
      await this.#assertRealContained(worktreePath, managedRoot);
      const resolvedHeadSha = (await this.#gitStdout(worktreePath, ["rev-parse", "--verify", "HEAD"], "resolve worktree HEAD")).trim();

      return {
        canonicalRoot,
        managedRoot,
        worktreePath,
        worktreeName: names.worktreeName,
        branchName: names.branchName,
        baseSha,
        resolvedHeadSha,
        canonicalStatus,
      };
    } catch (error) {
      if (!added) throw error;
      try {
        await this.#rollbackCreatedWorktree(canonicalRoot, {
          path: worktreePath,
          branchName: names.branchName,
          baseSha,
        });
      } catch (rollbackError) {
        throw new WorktreeServiceError(
          "GIT_COMMAND_FAILED",
          "Managed worktree creation failed and conservative rollback could not complete",
          {
            worktreePath,
            branchName: names.branchName,
            baseSha,
            createError: errorMessage(error),
            rollbackError: errorMessage(rollbackError),
          },
          error,
        );
      }
      throw error;
    }
  }

  /**
   * Self-heals the only safe branch-only rollback residue. The reserved ref is
   * deleted with an expected-value CAS only when no worktree registration owns
   * it and it still points at the exact requested creation base.
   */
  async #removeSafeDetachedBaseBranch(canonicalRoot: string, branchName: string, baseSha: string): Promise<void> {
    const registered = (await this.#listForCanonical(canonicalRoot)).find((worktree) => worktree.branchName === branchName);
    if (registered !== undefined) {
      throw new WorktreeServiceError("WORKTREE_PATH_EXISTS", "Managed worktree branch is still registered", {
        branchName,
        worktreePath: registered.path,
      });
    }
    const branchHeadSha = (await this.#gitStdout(
      canonicalRoot,
      ["rev-parse", "--verify", `refs/heads/${branchName}^{commit}`],
      "resolve detached managed worktree branch",
    )).trim();
    if (branchHeadSha !== baseSha) {
      throw new WorktreeServiceError("WORKTREE_PATH_EXISTS", "Managed worktree branch contains state that cannot be adopted or deleted", {
        branchName,
        branchHeadSha,
        baseSha,
      });
    }
    await this.#deleteBranchExpected(canonicalRoot, branchName, baseSha);
  }

  async list(): Promise<WorktreeInfo[]> {
    const canonicalRoot = await this.#resolveCanonicalRoot();
    return await this.#listForCanonical(canonicalRoot);
  }

  async #listForCanonical(canonicalRoot: string): Promise<WorktreeInfo[]> {
    const canonicalRealPath = await realpath(canonicalRoot);
    const { managedRoot } = await this.#managedRootFor(canonicalRoot);
    const output = await this.#gitStdout(canonicalRoot, ["worktree", "list", "--porcelain", "-z"], "list worktrees");
    const records = parseWorktreeList(output);
    const result: WorktreeInfo[] = [];
    for (const record of records) {
      const path = await realpath(record.path).catch(() => resolve(record.path));
      result.push({
        path,
        ...(record.headSha === undefined ? {} : { headSha: record.headSha }),
        ...(record.branchName === undefined ? {} : { branchName: record.branchName }),
        isCanonical: path === canonicalRealPath,
        isManaged: isContained(path, managedRoot),
        isBare: record.isBare,
        isDetached: record.isDetached,
        isPrunable: record.isPrunable,
      });
    }
    return result;
  }

  async findManaged(input: ManagedWorktreeLookup): Promise<WorktreeInfo | undefined> {
    const branchName = managedWorktreeNames({
      owner: input.owner,
      uniqueId: input.uniqueId,
    }).branchName;
    return (await this.list()).find((worktree) => (
      worktree.isManaged
      && !worktree.isPrunable
      && worktree.branchName === branchName
    ));
  }

  async validate(pathInput: string): Promise<WorktreeInfo> {
    const canonicalRoot = await this.#resolveCanonicalRoot();
    const path = await this.#existingDirectory(pathInput);
    const [canonicalCommonDir, targetCommonDir] = await Promise.all([
      this.#commonGitDir(canonicalRoot),
      this.#commonGitDir(path),
    ]);
    if (canonicalCommonDir !== targetCommonDir) {
      throw new WorktreeServiceError("DIFFERENT_REPOSITORY", "Target worktree belongs to a different Git repository", {
        canonicalRoot,
        path,
      });
    }

    const worktree = (await this.list()).find((entry) => entry.path === path);
    if (worktree === undefined) {
      throw new WorktreeServiceError("WORKTREE_NOT_REGISTERED", "Target directory is not a registered Git worktree", { path });
    }
    return worktree;
  }

  async validateManagedClaim(input: WorktreeManagedClaimInput): Promise<WorktreeManagedClaim> {
    const canonicalRoot = await this.#resolveCanonicalRoot();
    const commonGitDir = await this.#lifecycleLockKey(canonicalRoot);
    return await withLifecycleLock(
      commonGitDir,
      async () => await this.#validateManagedClaimLocked(canonicalRoot, input),
    );
  }

  async #validateManagedClaimLocked(
    canonicalRoot: string,
    input: WorktreeManagedClaimInput,
  ): Promise<WorktreeManagedClaim> {
    const worktree = await this.validate(input.path);
    if (worktree.isCanonical || !worktree.isManaged) {
      throw new WorktreeServiceError("WORKTREE_PATH_ESCAPE", "Only ArchCode-managed worktrees can hold managed claims", {
        path: worktree.path,
      });
    }
    if (worktree.branchName !== input.branchName || !isArchCodeManagedBranch(input.branchName)) {
      throw new WorktreeServiceError("WORKTREE_BRANCH_MISMATCH", "Managed worktree branch does not match the expected ArchCode claim", {
        path: worktree.path,
        expected: input.branchName,
        actual: worktree.branchName,
      });
    }

    const [status, headSha, branchHeadSha, canonicalHeadSha] = await Promise.all([
      this.#removalStatus(worktree.path),
      this.#gitStdout(worktree.path, ["rev-parse", "--verify", "HEAD^{commit}"], "resolve managed claim HEAD").then((value) => value.trim()),
      this.#gitStdout(canonicalRoot, ["rev-parse", "--verify", `refs/heads/${input.branchName}^{commit}`], "resolve managed claim branch").then((value) => value.trim()),
      this.#gitStdout(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"], "resolve canonical claim HEAD").then((value) => value.trim()),
    ]);
    if (worktree.headSha === undefined || worktree.headSha !== headSha || branchHeadSha !== headSha) {
      throw new WorktreeServiceError("WORKTREE_CHANGED", "Managed worktree HEAD no longer matches its registered branch", {
        path: worktree.path,
        listedHeadSha: worktree.headSha,
        headSha,
        branchHeadSha,
      });
    }
    if (input.mode === "orphan" && status.dirty) {
      throw new WorktreeServiceError("WORKTREE_CHANGED", "Managed worktree must be clean before its claim can be adopted", {
        path: worktree.path,
        entries: status.entries,
      });
    }

    let baseSha: string;
    if (input.mode === "persisted") {
      baseSha = await this.#resolveBaseSha(canonicalRoot, input.baseSha);
      const descendant = await this.#gitSuccess(canonicalRoot, ["merge-base", "--is-ancestor", baseSha, headSha], {
        operation: "verify managed claim ancestry",
        allowNonZero: true,
      });
      if (descendant.kind !== "success") {
        throw new WorktreeServiceError("WORKTREE_CHANGED", "Managed worktree HEAD no longer descends from its recorded base", {
          path: worktree.path,
          baseSha,
          headSha,
        });
      }
    } else {
      if (headSha !== canonicalHeadSha) {
        throw new WorktreeServiceError("WORKTREE_CHANGED", "Unclaimed managed worktree HEAD no longer equals canonical HEAD", {
          path: worktree.path,
          headSha,
          canonicalHeadSha,
        });
      }
      baseSha = canonicalHeadSha;
    }

    return {
      worktree,
      status,
      headSha,
      branchHeadSha,
      canonicalHeadSha,
      baseSha,
    };
  }

  async status(pathInput: string): Promise<WorktreeGitStatus> {
    const output = await this.#gitStdout(pathInput, ["status", "--porcelain=v1", "-z"], "inspect worktree status");
    const entries = parsePorcelainStatus(output);
    return { dirty: entries.length > 0, entries };
  }

  async #removalStatus(pathInput: string): Promise<WorktreeGitStatus> {
    const output = await this.#gitStdout(
      pathInput,
      ["status", "--porcelain=v1", "-z", "--ignored=matching"],
      "inspect removable worktree status including ignored files",
    );
    const entries = parsePorcelainStatus(output);
    return { dirty: entries.length > 0, entries };
  }

  async remove(input: WorktreeRemoveInput): Promise<WorktreeRemoveResult> {
    const canonicalRoot = await this.#resolveCanonicalRoot();
    const commonGitDir = await this.#lifecycleLockKey(canonicalRoot);
    return await withLifecycleLock(commonGitDir, async () => await this.#removeLocked(canonicalRoot, input));
  }

  async #removeLocked(canonicalRoot: string, input: WorktreeRemoveInput): Promise<WorktreeRemoveResult> {
    const target = await this.validate(input.path);
    if (target.isCanonical || !target.isManaged) {
      throw new WorktreeServiceError("WORKTREE_PATH_ESCAPE", "Only ArchCode-managed worktrees can be removed", {
        path: target.path,
      });
    }
    if (target.branchName !== input.branchName || !isArchCodeManagedBranch(input.branchName)) {
      throw new WorktreeServiceError("WORKTREE_BRANCH_MISMATCH", "Managed worktree branch does not match the expected ArchCode branch", {
        expected: input.branchName,
        actual: target.branchName,
      });
    }

    const baseSha = input.baseSha === undefined ? undefined : await this.#resolveBaseSha(canonicalRoot, input.baseSha);
    const prepared = await this.#assertRemovableSnapshot(canonicalRoot, target, input.branchName, baseSha);

    await input.beforeRemove?.();
    try {
      await this.#assertRemovableSnapshot(canonicalRoot, target, input.branchName, baseSha, prepared.headSha);
    } catch (validationError) {
      await this.#failBeforeDetach(input, target, validationError, "final validation");
    }
    try {
      await this.#gitSuccess(canonicalRoot, ["worktree", "remove", target.path], { operation: "remove unchanged managed worktree" });
    } catch (removeError) {
      await this.#failBeforeDetach(input, target, removeError, "detach command");
    }
    await input.onRemoveDetached?.();
    try {
      await this.#deleteBranchExpected(canonicalRoot, input.branchName, prepared.headSha);
      return { detached: true, branchDeleted: true };
    } catch (branchError) {
      return {
        detached: true,
        branchDeleted: false,
        warning: {
          code: "BRANCH_DELETE_FAILED",
          branchName: input.branchName,
          message: errorMessage(branchError),
        },
      };
    }
  }

  async #assertRemovableSnapshot(
    canonicalRoot: string,
    expectedTarget: WorktreeInfo,
    branchName: string,
    baseSha?: string,
    expectedHeadSha?: string,
  ): Promise<{ readonly headSha: string }> {
    const target = await this.validate(expectedTarget.path);
    if (target.path !== expectedTarget.path || target.branchName !== branchName || target.isCanonical || !target.isManaged) {
      throw new WorktreeServiceError("WORKTREE_CHANGED", "Managed worktree identity changed while preparing removal", {
        expectedPath: expectedTarget.path,
        actualPath: target.path,
        expectedBranch: branchName,
        actualBranch: target.branchName,
      });
    }

    const [status, headSha, branchHeadSha] = await Promise.all([
      this.#removalStatus(target.path),
      this.#gitStdout(target.path, ["rev-parse", "--verify", "HEAD"], "resolve removable worktree HEAD").then((value) => value.trim()),
      this.#gitStdout(canonicalRoot, ["rev-parse", "--verify", `refs/heads/${branchName}`], "resolve removable worktree branch").then((value) => value.trim()),
    ]);
    const hasUniqueCommits = baseSha === undefined
      ? (await this.#gitSuccess(canonicalRoot, ["merge-base", "--is-ancestor", headSha, "HEAD"], {
        operation: "check managed worktree for unique commits",
        allowNonZero: true,
      })).kind !== "success"
      : headSha !== baseSha;
    if (
      status.dirty
      || hasUniqueCommits
      || branchHeadSha !== headSha
      || (expectedHeadSha !== undefined && headSha !== expectedHeadSha)
    ) {
      throw new WorktreeServiceError("WORKTREE_CHANGED", "Changed worktrees must be preserved for review", {
        path: target.path,
        dirty: status.dirty,
        entries: status.entries,
        baseSha,
        expectedHeadSha,
        headSha,
        branchHeadSha,
        hasUniqueCommits,
      });
    }
    return { headSha };
  }

  async #failBeforeDetach(
    input: WorktreeRemoveInput,
    target: WorktreeInfo,
    primaryError: unknown,
    phase: "final validation" | "detach command",
  ): Promise<never> {
    try {
      await input.onRemoveFailureBeforeDetach?.();
    } catch (callbackError) {
      throw new WorktreeServiceError(
        "GIT_COMMAND_FAILED",
        `Worktree ${phase} failed and its pre-detach failure callback also failed`,
        {
          path: target.path,
          branchName: input.branchName,
          primaryError: errorMessage(primaryError),
          callbackError: errorMessage(callbackError),
        },
        new AggregateError([primaryError, callbackError]),
      );
    }
    throw primaryError;
  }

  /**
   * Control-plane recovery for ArchCode-managed registrations whose directories
   * have already disappeared. This method is intentionally not an Agent tool.
   */
  async reconcilePrunable(): Promise<WorktreeReconcileResult> {
    const canonicalRoot = await this.#resolveCanonicalRoot();
    const commonGitDir = await this.#lifecycleLockKey(canonicalRoot);
    return await withLifecycleLock(commonGitDir, async () => {
      const removed: WorktreeInfo[] = [];
      const preserved: WorktreeReconcilePreserved[] = [];
      const warnings: WorktreeReconcileWarning[] = [];
      const worktrees = await this.#listForCanonical(canonicalRoot);

      for (const worktree of worktrees) {
        if (worktree.isCanonical || !worktree.isManaged || !worktree.isPrunable) continue;
        if (worktree.branchName === undefined || !worktree.branchName.startsWith("archcode/") || worktree.headSha === undefined) {
          preserved.push({ worktree, reason: "missing ArchCode branch ownership metadata" });
          continue;
        }

        const branchHeadSha = (await this.#gitStdout(
          canonicalRoot,
          ["rev-parse", "--verify", `refs/heads/${worktree.branchName}`],
          "resolve prunable managed worktree branch",
        )).trim();
        if (branchHeadSha !== worktree.headSha) {
          preserved.push({ worktree, reason: "branch changed after the worktree became prunable" });
          continue;
        }

        const ancestor = await this.#gitSuccess(canonicalRoot, ["merge-base", "--is-ancestor", worktree.headSha, "HEAD"], {
          operation: "check prunable managed worktree for unique commits",
          allowNonZero: true,
        });
        if (ancestor.kind !== "success") {
          preserved.push({ worktree, reason: "branch contains commits not reachable from canonical HEAD" });
          continue;
        }

        await this.#gitSuccess(canonicalRoot, ["worktree", "remove", worktree.path], {
          operation: "remove prunable managed worktree registration",
        });
        removed.push(worktree);
        try {
          await this.#deleteBranchExpected(canonicalRoot, worktree.branchName, worktree.headSha);
        } catch (branchError) {
          warnings.push({
            worktree,
            warning: {
              code: "BRANCH_DELETE_FAILED",
              branchName: worktree.branchName,
              message: errorMessage(branchError),
            },
          });
        }
      }

      return { removed, preserved, warnings };
    });
  }

  async #rollbackCreatedWorktree(
    canonicalRoot: string,
    input: { readonly path: string; readonly branchName: string; readonly baseSha: string },
  ): Promise<void> {
    const expectedPath = await realpath(input.path).catch(() => resolve(input.path));
    const target = (await this.#listForCanonical(canonicalRoot)).find((worktree) => (
      worktree.path === expectedPath && worktree.branchName === input.branchName
    ));
    if (target === undefined || target.headSha !== input.baseSha) {
      throw new WorktreeServiceError("WORKTREE_CHANGED", "Created worktree could not be proven unchanged for rollback", {
        expectedPath,
        branchName: input.branchName,
        baseSha: input.baseSha,
        actual: target,
      });
    }

    const branchHeadSha = (await this.#gitStdout(
      canonicalRoot,
      ["rev-parse", "--verify", `refs/heads/${input.branchName}`],
      "resolve rollback branch",
    )).trim();
    if (branchHeadSha !== input.baseSha) {
      throw new WorktreeServiceError("WORKTREE_CHANGED", "Created worktree branch changed before rollback", {
        branchName: input.branchName,
        baseSha: input.baseSha,
        branchHeadSha,
      });
    }
    if (!target.isPrunable && (await this.#removalStatus(target.path)).dirty) {
      throw new WorktreeServiceError("WORKTREE_CHANGED", "Created worktree became dirty before rollback", { path: target.path });
    }

    await this.#gitSuccess(canonicalRoot, ["worktree", "remove", target.path], {
      operation: "rollback created worktree",
    });
    await this.#deleteBranchExpected(canonicalRoot, input.branchName, input.baseSha);
  }

  async #deleteBranchExpected(canonicalRoot: string, branchName: string, expectedHeadSha: string): Promise<void> {
    await this.#gitSuccess(
      canonicalRoot,
      ["update-ref", "--no-deref", "-d", `refs/heads/${branchName}`, expectedHeadSha],
      { operation: "delete unchanged managed worktree branch" },
    );
  }

  async #resolveCanonicalRoot(): Promise<string> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.#canonicalRootInput);
      if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new WorktreeServiceError("INVALID_CANONICAL_ROOT", "Canonical root must be an existing directory", {
        canonicalRoot: this.#canonicalRootInput,
      }, error);
    }

    const inside = (await this.#gitStdout(canonicalRoot, ["rev-parse", "--is-inside-work-tree"], "validate git checkout")).trim();
    if (inside !== "true") {
      throw new WorktreeServiceError("INVALID_CANONICAL_ROOT", "Canonical root must be inside a Git worktree", { canonicalRoot });
    }
    const bare = (await this.#gitStdout(canonicalRoot, ["rev-parse", "--is-bare-repository"], "validate non-bare repository")).trim();
    if (bare === "true") {
      throw new WorktreeServiceError("BARE_REPOSITORY", "Canonical root must be a non-bare repository", { canonicalRoot });
    }
    const topLevel = await realpath((await this.#gitStdout(canonicalRoot, ["rev-parse", "--show-toplevel"], "resolve Git top-level")).trim());
    if (topLevel !== canonicalRoot) {
      throw new WorktreeServiceError("CANONICAL_ROOT_MISMATCH", "Canonical root must be the Git top-level directory", {
        canonicalRoot,
        topLevel,
      });
    }
    return canonicalRoot;
  }

  async #managedRootFor(canonicalRoot: string): Promise<{ managedRoot: string; parentRoot: string }> {
    const parentRoot = await realpath(dirname(canonicalRoot));
    const managedRoot = resolve(parentRoot, `${basename(canonicalRoot)}.worktrees`);
    this.#assertContained(managedRoot, parentRoot);
    if (isContained(managedRoot, canonicalRoot) || managedRoot === canonicalRoot) {
      throw new WorktreeServiceError("WORKTREE_PATH_ESCAPE", "Managed worktree root must be outside the canonical checkout", {
        canonicalRoot,
        managedRoot,
      });
    }
    try {
      const info = await lstat(managedRoot);
      if (info.isSymbolicLink()) {
        throw new WorktreeServiceError("WORKTREE_PATH_ESCAPE", "Managed worktree root must not be a symlink", { managedRoot });
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    return { managedRoot, parentRoot };
  }

  async #resolveBaseSha(cwd: string, baseShaInput?: string): Promise<string> {
    const baseSha = baseShaInput === undefined
      ? (await this.#gitStdout(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], "resolve default base commit")).trim()
      : baseShaInput.trim();
    if (baseSha.length === 0) throw new WorktreeServiceError("MISSING_BASE_SHA", "Worktree creation requires a base commit");
    if (!FULL_SHA_PATTERN.test(baseSha)) {
      throw new WorktreeServiceError("INVALID_BASE_SHA", "Worktree base must be a full commit SHA", { baseSha });
    }
    const exists = await this.#gitSuccess(cwd, ["cat-file", "-e", `${baseSha}^{commit}`], {
      operation: "verify base commit",
      allowNonZero: true,
    });
    if (exists.kind !== "success") {
      throw new WorktreeServiceError("BASE_SHA_NOT_FOUND", "Worktree base commit was not found", { baseSha });
    }
    return (await this.#gitStdout(cwd, ["rev-parse", "--verify", `${baseSha}^{commit}`], "resolve base commit")).trim();
  }

  async #commonGitDir(cwd: string): Promise<string> {
    const value = (await this.#gitStdout(cwd, ["rev-parse", "--git-common-dir"], "resolve Git common directory")).trim();
    return await realpath(resolve(cwd, value));
  }

  async #lifecycleLockKey(canonicalRoot: string): Promise<string> {
    const dotGit = join(canonicalRoot, ".git");
    if ((await stat(dotGit)).isDirectory()) return await realpath(dotGit);
    const pointer = (await Bun.file(dotGit).text()).trim();
    const match = /^gitdir:\s*(.+)$/i.exec(pointer);
    if (match?.[1] === undefined) {
      throw new WorktreeServiceError("INVALID_CANONICAL_ROOT", "Canonical root has an invalid .git pointer", {
        canonicalRoot,
        dotGit,
      });
    }
    const gitDir = await realpath(resolve(canonicalRoot, match[1]));
    const commonDirFile = Bun.file(join(gitDir, "commondir"));
    if (!(await commonDirFile.exists())) return gitDir;
    const commonDir = (await commonDirFile.text()).trim();
    if (commonDir.length === 0) {
      throw new WorktreeServiceError("INVALID_CANONICAL_ROOT", "Canonical root has an empty Git common-dir pointer", {
        canonicalRoot,
        gitDir,
      });
    }
    return await realpath(resolve(gitDir, commonDir));
  }

  async #existingDirectory(pathInput: string): Promise<string> {
    try {
      const path = await realpath(resolve(pathInput));
      if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
      return path;
    } catch (error) {
      throw new WorktreeServiceError("WORKTREE_NOT_REGISTERED", "Target worktree must be an existing directory", {
        path: pathInput,
      }, error);
    }
  }

  #assertContained(path: string, root: string): void {
    if (!isContained(path, root)) {
      throw new WorktreeServiceError("WORKTREE_PATH_ESCAPE", "Worktree path escapes the managed root", { path, root });
    }
  }

  async #assertRealContained(path: string, root: string): Promise<void> {
    const [realPath, realRoot] = await Promise.all([realpath(path), realpath(root)]);
    if (!isContained(realPath, realRoot)) {
      throw new WorktreeServiceError("WORKTREE_PATH_ESCAPE", "Real worktree path escapes the managed root", {
        path,
        realPath,
        root,
        realRoot,
      });
    }
  }

  async #assertPathDoesNotExist(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    throw new WorktreeServiceError("WORKTREE_PATH_EXISTS", "Managed worktree path already exists", { path });
  }

  async #gitStdout(cwd: string, args: readonly string[], operation: string): Promise<string> {
    return (await this.#gitSuccess(cwd, args, { operation })).output.stdout;
  }

  async #gitSuccess(
    cwd: string,
    args: readonly string[],
    options: { readonly operation: string; readonly allowNonZero?: boolean },
  ): Promise<GitCompletedResult> {
    const result = await this.#git.run({
      argv: ["git", ...args],
      cwd,
      env: lockedGitEnv(cwd),
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
    });
    if (result.kind === "success" || (options.allowNonZero === true && result.kind === "nonzero")) return result;
    throw new WorktreeServiceError("GIT_COMMAND_FAILED", `Git command failed during ${options.operation}`, {
      cwd,
      args,
      resultKind: result.kind,
      output: result.kind === "spawn-failure" ? undefined : result.output.combined,
    });
  }
}

export function managedWorktreeNames(input: WorktreeCreateInput): { worktreeName: string; branchName: string } {
  const owner = safeSegment(input.owner.id, "session", MAX_SEGMENT_LENGTH);
  const rawUnique = safeSegment(input.uniqueId ?? input.owner.id, "session", UNIQUE_ID_LENGTH);
  const unique = rawUnique.length >= MIN_UNIQUE_ID_LENGTH
    ? rawUnique
    : `${rawUnique}${"0".repeat(MIN_UNIQUE_ID_LENGTH - rawUnique.length)}`;
  const label = safeSegment(input.label ?? owner, "session", MAX_SEGMENT_LENGTH);
  const branchName = `archcode/session/${unique}`;
  const worktreeName = `session-${label}-${unique}`
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/g, "");
  return { worktreeName, branchName };
}

/** Returns whether a branch belongs to ArchCode's reserved lifecycle namespace. */
export function isArchCodeManagedBranch(branchName: string | undefined): boolean {
  return branchName?.startsWith(ARCHCODE_BRANCH_PREFIX) === true;
}

/** Matches a registered managed worktree to one deterministic lifecycle owner. */
export function isManagedWorktreeFor(
  worktree: WorktreeInfo,
  input: ManagedWorktreeLookup,
): boolean {
  return worktree.isManaged
    && worktree.branchName === managedWorktreeNames({ owner: input.owner, uniqueId: input.uniqueId }).branchName;
}

export function parsePorcelainStatus(output: string): WorktreeGitStatusEntry[] {
  if (output.length === 0) return [];
  return output.split("\0").filter(Boolean).map((raw) => ({
    path: raw.slice(3),
    index: raw[0] ?? " ",
    worktree: raw[1] ?? " ",
    raw,
  }));
}

function userCanonicalStatus(status: WorktreeGitStatus): WorktreeGitStatus {
  const entries = status.entries.filter((entry) => !(
    entry.index === "?"
    && entry.worktree === "?"
    && (entry.path === PROJECT_STATE_DIR_NAME || entry.path.startsWith(`${PROJECT_STATE_DIR_NAME}/`))
  ));
  return { dirty: entries.length > 0, entries };
}

interface ParsedWorktreeRecord {
  path: string;
  headSha?: string;
  branchName?: string;
  isBare: boolean;
  isDetached: boolean;
  isPrunable: boolean;
}

function parseWorktreeList(output: string): ParsedWorktreeRecord[] {
  const records: ParsedWorktreeRecord[] = [];
  let current: ParsedWorktreeRecord | undefined;
  for (const token of output.split("\0").filter(Boolean)) {
    if (token.startsWith("worktree ")) {
      if (current !== undefined) records.push(current);
      current = {
        path: token.slice("worktree ".length),
        isBare: false,
        isDetached: false,
        isPrunable: false,
      };
      continue;
    }
    if (current === undefined) continue;
    if (token.startsWith("HEAD ")) current.headSha = token.slice("HEAD ".length);
    else if (token.startsWith("branch ")) current.branchName = token.slice("branch refs/heads/".length);
    else if (token === "bare") current.isBare = true;
    else if (token === "detached") current.isDetached = true;
    else if (token.startsWith("prunable")) current.isPrunable = true;
  }
  if (current !== undefined) records.push(current);
  return records;
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

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function withLifecycleLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = lifecycleQueueByCommonGitDir.get(key) ?? Promise.resolve();
  const operation = previous.then(action);
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  lifecycleQueueByCommonGitDir.set(key, tail);

  try {
    return await operation;
  } finally {
    if (lifecycleQueueByCommonGitDir.get(key) === tail) lifecycleQueueByCommonGitDir.delete(key);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
