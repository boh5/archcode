import type { CollisionConflict, CollisionTarget } from "./state";
import { canonicalTargetKey, CollisionLedger } from "./collision-ledger";
import { createDefaultToolTargetExtractorRegistry, type ToolTargetExtractorRegistry } from "./tool-target-extractors";
import type { AfterHook, PermissionDecision, ToolExecutionContext, ToolPermission } from "../tools/types";

export interface LoopCollisionToolPermissionOptions {
  readonly extractorRegistry?: ToolTargetExtractorRegistry;
  readonly priority?: number | ((ctx: ToolExecutionContext, targets: readonly CollisionTarget[]) => number);
  readonly leaseTtlMs?: number;
}

export const LOOP_COLLISION_CONFLICT_CODE = "LOOP_COLLISION_CONFLICT";

export function createLoopCollisionToolPermission(options: LoopCollisionToolPermissionOptions = {}): ToolPermission {
  const extractorRegistry = options.extractorRegistry ?? createDefaultToolTargetExtractorRegistry();

  return async (input: unknown, ctx: ToolExecutionContext): Promise<PermissionDecision> => {
    const origin = ctx.origin;
    if (origin?.kind !== "loop") return { outcome: "allow" };
    if (!isEffectfulTool(ctx)) return { outcome: "allow" };
    if (origin.runId === undefined) return { outcome: "allow" };
    const runId = origin.runId;

    const targets = extractorRegistry.extract(ctx.toolName, input, { cwd: ctx.cwd });
    if (targets.length === 0) return { outcome: "allow" };

    const priority = typeof options.priority === "function"
      ? options.priority(ctx, targets)
      : options.priority ?? 0;
    const ledger = new CollisionLedger({
      stateManager: ctx.projectContext.loopState,
      workspaceRoot: ctx.projectContext.project.workspaceRoot,
      ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
    });
    const results = await ledger.acquireAll(targets.map((target) => ({
      target,
      loopId: origin.loopId,
      runId,
      toolCallId: ctx.toolCallId,
      priority,
    })));
    const conflict = results.find((result) => result.conflict !== undefined)?.conflict;
    if (conflict === undefined) return { outcome: "allow" };

    return collisionConflictDecision(conflict);
  };
}

export function createLoopCollisionToolReleaseHook(options: Pick<LoopCollisionToolPermissionOptions, "leaseTtlMs"> = {}): AfterHook {
  return async function collisionReleaseAfterHook(_result, ctx) {
    const origin = ctx.origin;
    if (origin?.kind !== "loop") return undefined;
    if (origin.runId === undefined) return undefined;

    const ledger = new CollisionLedger({
      stateManager: ctx.projectContext.loopState,
      workspaceRoot: ctx.projectContext.project.workspaceRoot,
      ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
    });
    await ledger.releaseToolCall(origin.loopId, origin.runId, ctx.toolCallId);
    await ledger.cleanupStale();
    return undefined;
  };
}

function collisionConflictDecision(conflict: CollisionConflict): PermissionDecision {
  return {
    outcome: "deny",
    source: "tool-guard",
    ruleId: "loop.collision_conflict",
    errorKind: "permission-denied",
    errorCode: LOOP_COLLISION_CONFLICT_CODE,
    reason: `[${LOOP_COLLISION_CONFLICT_CODE}] Loop target collision_conflict for ${conflict.targetKey}; held by loop ${conflict.conflictingLease.loopId} run ${conflict.conflictingLease.runId}.`,
    display: JSON.stringify({
      reason: "collision_conflict",
      targetKey: conflict.targetKey,
      target: conflict.target,
      conflictingLease: conflict.conflictingLease,
      detectedAt: conflict.detectedAt,
    }),
  };
}

export function collisionTargetKeys(targets: readonly CollisionTarget[]): string[] {
  return targets.map(canonicalTargetKey);
}

function isEffectfulTool(ctx: ToolExecutionContext): boolean {
  const traits = ctx.toolTraits;
  if (traits === undefined) return true;
  return traits.destructive || !traits.readOnly;
}
