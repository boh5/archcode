import { isAbsolute, resolve } from "node:path";

import { WorktreeService, type WorktreeInfo } from "../worktrees";
import { InvalidSessionCwdError } from "./errors";

/**
 * Validates the persisted execution root before any Agent or resumed tool can
 * use it. The project root keeps its registered spelling; linked worktrees
 * must use the canonical path returned by Git so a symlink cannot later be
 * redirected to a different directory.
 */
export async function assertValidSessionCwd(projectRoot: string, cwd: string): Promise<void> {
  await resolveValidSessionCwd(projectRoot, cwd);
}

/** Returns the registered worktree identity, or undefined for the canonical project root. */
export async function resolveValidSessionCwd(
  projectRoot: string,
  cwd: string,
): Promise<WorktreeInfo | undefined> {
  if (!isAbsolute(cwd)) throw new InvalidSessionCwdError(cwd, "must be an absolute path");
  if (resolve(cwd) === resolve(projectRoot)) return undefined;

  try {
    const worktree = await new WorktreeService({ canonicalRoot: projectRoot }).validate(cwd);
    if (worktree.isCanonical) {
      throw new InvalidSessionCwdError(cwd, `must use the registered project root path ${projectRoot}`);
    }
    if (worktree.path !== cwd) {
      throw new InvalidSessionCwdError(cwd, `must use canonical worktree path ${worktree.path}`);
    }
    return worktree;
  } catch (error) {
    if (error instanceof InvalidSessionCwdError) throw error;
    throw new InvalidSessionCwdError(
      cwd,
      "must be the project root or a registered worktree from the same Git repository",
      error,
    );
  }
}
