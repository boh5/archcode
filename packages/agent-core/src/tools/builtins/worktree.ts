import { isAbsolute } from "node:path";
import { z } from "zod";

import { TOOL_WORKTREE_ENTER, TOOL_WORKTREE_EXIT } from "../names";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  isArchCodeManagedBranch,
  isManagedWorktreeFor,
  WorktreeService,
  WorktreeServiceError,
  type WorktreeInfo,
} from "../../worktrees";
import { SessionCwdTransitionConflictError } from "../../agents/errors";

export const WorktreeEnterInputSchema = z.strictObject({
  path: z.string().trim().min(1).refine(isAbsolute, "Existing worktree path must be absolute").optional()
    .describe("Existing worktree path explicitly requested by the user. Omit to create a new ArchCode-managed worktree."),
  name: z.string().trim().min(1).max(80).optional()
    .describe("Optional short label for a newly created worktree. Ignored when path is provided."),
});

export const WorktreeExitInputSchema = z.strictObject({});

export type WorktreeEnterInput = z.infer<typeof WorktreeEnterInputSchema>;

const confirmWorktreeTransition = async () => ({
  outcome: "ask" as const,
  source: "builtin-policy" as const,
  ruleId: "session.worktree.transition",
  reason: "Changing the Session worktree rebuilds the Agent execution environment.",
});

export const worktreeEnterTool = defineTool({
  name: TOOL_WORKTREE_ENTER,
  description: [
    "Enter a worktree for this interactive root Orchestrator Session.",
    "Omit path to create or re-enter this Session's own managed worktree from the current project HEAD.",
    "Use path only when the user explicitly identifies an existing worktree.",
    "Wait for or cancel running descendant sessions before entering a worktree.",
    "This changes Session cwd and restarts the Agent context; it never lists or removes worktrees.",
  ].join(" "),
  inputSchema: WorktreeEnterInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  permissions: [confirmWorktreeTransition],
  execute: executeWorktreeEnter,
});

export const worktreeExitTool = defineTool({
  name: TOOL_WORKTREE_EXIT,
  description: "Return this interactive root Orchestrator Session to its canonical project checkout after descendant sessions have stopped. This changes Session cwd but never removes the worktree.",
  inputSchema: WorktreeExitInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  permissions: [confirmWorktreeTransition],
  execute: executeWorktreeExit,
});

export async function executeWorktreeEnter(
  input: WorktreeEnterInput,
  ctx: ToolExecutionContext,
): Promise<string | ToolExecutionResult> {
  const eligibilityError = validateInteractiveRootSession(ctx);
  if (eligibilityError !== undefined) return eligibilityError;

  const projectRoot = ctx.projectContext.project.workspaceRoot;
  const state = ctx.store.getState();
  if (state.cwd !== projectRoot) {
    return createToolErrorResult({
      kind: "execution",
      code: "WORKTREE_ALREADY_ENTERED",
      message: "This Session is already in a worktree. Use worktree_exit before entering another worktree.",
    });
  }
  const releaseTransition = acquireCwdTransition(ctx, projectRoot, state.sessionId);
  if (typeof releaseTransition !== "function") return releaseTransition;

  const service = new WorktreeService({ canonicalRoot: projectRoot });
  let created: Awaited<ReturnType<WorktreeService["create"]>> | undefined;
  try {
    const owner = { type: "session" as const, id: state.sessionId };
    const targetInfo = input.path === undefined
      ? await service.findManaged({ owner })
      : await service.validate(input.path);
    if (input.path !== undefined && targetInfo !== undefined) {
      const ownershipError = validateExplicitTargetOwnership(targetInfo, owner);
      if (ownershipError !== undefined) return ownershipError;
    }
    let target = targetInfo?.path;
    if (target === undefined) {
      created = await service.create({
        owner,
        label: input.name,
        requireCleanCanonical: true,
      });
      target = created.worktreePath;
    }

    if (targetInfo?.isCanonical === true || target === projectRoot) {
      return createToolErrorResult({
        kind: "execution",
        code: "WORKTREE_TARGET_IS_PROJECT",
        message: "The Session is already using the canonical project checkout.",
      });
    }

    await ctx.storeManager.updateCwd(state.sessionId, projectRoot, target, state.cwd);
    return {
      output: JSON.stringify({
        changed: true,
        previousCwd: state.cwd,
        cwd: target,
        created: created !== undefined,
        ...(created === undefined ? {} : { branchName: created.branchName }),
      }),
      isError: false,
      meta: { sessionCwdChanged: true, previousCwd: state.cwd, cwd: target },
    };
  } catch (error) {
    let transitionError = error;
    if (created !== undefined) {
      try {
        const rollback = await service.remove({
          path: created.worktreePath,
          branchName: created.branchName,
          baseSha: created.baseSha,
        });
        if (!rollback.branchDeleted) {
          throw new WorktreeServiceError(
            "GIT_COMMAND_FAILED",
            "Session worktree rollback detached the worktree but could not delete its branch",
            {
              branchName: created.branchName,
              warning: rollback.warning,
            },
          );
        }
      } catch (rollbackError) {
        transitionError = new AggregateError(
          [error, rollbackError],
          "Session cwd transition failed and the newly created worktree could not be rolled back",
        );
      }
    }
    return worktreeErrorResult(transitionError);
  } finally {
    releaseTransition();
  }
}

function validateExplicitTargetOwnership(
  target: WorktreeInfo,
  owner: { readonly type: "session"; readonly id: string },
): ToolExecutionResult | undefined {
  const isOwnedBySession = isManagedWorktreeFor(target, { owner });
  if ((target.isManaged || isArchCodeManagedBranch(target.branchName)) && !isOwnedBySession) {
    return createToolErrorResult({
      kind: "permission-denied",
      code: "WORKTREE_TARGET_NOT_OWNED",
      message: "A Session may enter only its own ArchCode-managed worktree. Goal, Loop, and other Session worktrees keep their lifecycle ownership.",
    });
  }
  return undefined;
}

export async function executeWorktreeExit(
  _input: Record<string, never>,
  ctx: ToolExecutionContext,
): Promise<string | ToolExecutionResult> {
  const eligibilityError = validateInteractiveRootSession(ctx);
  if (eligibilityError !== undefined) return eligibilityError;

  const projectRoot = ctx.projectContext.project.workspaceRoot;
  const state = ctx.store.getState();
  if (state.cwd === projectRoot) {
    return createToolErrorResult({
      kind: "execution",
      code: "WORKTREE_NOT_ENTERED",
      message: "This Session is already using the canonical project checkout.",
    });
  }
  const releaseTransition = acquireCwdTransition(ctx, projectRoot, state.sessionId);
  if (typeof releaseTransition !== "function") return releaseTransition;

  try {
    await ctx.storeManager.updateCwd(state.sessionId, projectRoot, projectRoot, state.cwd);
    return {
      output: JSON.stringify({ changed: true, previousCwd: state.cwd, cwd: projectRoot, removed: false }),
      isError: false,
      meta: { sessionCwdChanged: true, previousCwd: state.cwd, cwd: projectRoot },
    };
  } catch (error) {
    return worktreeErrorResult(error);
  } finally {
    releaseTransition();
  }
}

function acquireCwdTransition(
  ctx: ToolExecutionContext,
  projectRoot: string,
  sessionId: string,
): (() => void) | ToolExecutionResult {
  if (ctx.acquireSessionCwdTransition === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "WORKTREE_TRANSITION_GUARD_UNAVAILABLE",
      message: "Session worktree transition safety is unavailable in this execution context.",
    });
  }
  try {
    return ctx.acquireSessionCwdTransition(projectRoot, sessionId);
  } catch (error) {
    return worktreeErrorResult(error);
  }
}

function validateInteractiveRootSession(ctx: ToolExecutionContext): ToolExecutionResult | undefined {
  const state = ctx.store.getState();
  if (
    ctx.agentName !== "orchestrator"
    || state.parentSessionId !== undefined
    || state.goalId !== undefined
    || state.loopId !== undefined
    || (ctx.currentDepth ?? 0) !== 0
  ) {
    return createToolErrorResult({
      kind: "permission-denied",
      code: "WORKTREE_SESSION_NOT_ELIGIBLE",
      message: "Worktree transitions are available only to ordinary interactive root Orchestrator Sessions. Goal, Loop, child, and other Agent Sessions inherit their execution directory.",
    });
  }
  return undefined;
}

function worktreeErrorResult(error: unknown): ToolExecutionResult {
  const safeError = error instanceof Error ? error : new Error(String(error));
  return createToolErrorResult({
    kind: "execution",
    code: error instanceof WorktreeServiceError
      ? error.code
      : error instanceof SessionCwdTransitionConflictError
        ? "WORKTREE_ACTIVE_DESCENDANTS"
        : "WORKTREE_TRANSITION_FAILED",
    name: safeError.name,
    message: safeError.message,
    error: safeError,
  });
}
