import type { PermissionDecision } from "../types";

/**
 * Compose multiple permission decisions with priority: deny > ask > allow.
 * - If any decision is "deny", return the first deny decision.
 * - If any decision is "ask" and none is "deny", return the first ask decision.
 * - Otherwise return "allow".
 */
export function combinePermissionDecisions(decisions: PermissionDecision[]): PermissionDecision {
  for (const d of decisions) {
    if (d.outcome === "deny") return d;
  }
  for (const d of decisions) {
    if (d.outcome === "ask") return d;
  }
  return { outcome: "allow" };
}
