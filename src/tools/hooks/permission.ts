import type { GuardDecision, PermissionErrorCode, ToolExecutionResult } from "../types";
import { createToolErrorResult } from "../errors";

/**
 * Compose multiple guard decisions with priority: deny > ask > allow.
 * - If any decision is "deny", return the first deny decision.
 * - If any decision is "ask" and none is "deny", return the first ask decision.
 * - Otherwise return "allow".
 */
export function combineGuardDecisions(decisions: GuardDecision[]): GuardDecision {
  for (const d of decisions) {
    if (d.outcome === "deny") return d;
  }
  for (const d of decisions) {
    if (d.outcome === "ask") return d;
  }
  return { outcome: "allow" };
}

export function createPermissionErrorResult(
  code: PermissionErrorCode,
  message: string,
  meta?: Record<string, unknown>,
): ToolExecutionResult {
  return createToolErrorResult({
    code,
    message,
    meta: {
      permissionErrorCode: code,
      skippedExecution: true,
      ...meta,
    },
  });
}


