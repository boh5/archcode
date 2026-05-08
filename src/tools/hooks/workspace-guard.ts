import type { GuardHook, GuardDecision, ToolExecutionContext } from "../types";
import { resolveAndValidatePath } from "../security/path-validator";

export function createWorkspaceGuard(): GuardHook {
  return (input: unknown, ctx: ToolExecutionContext): GuardDecision => {
    const data = input as { path?: string };
    if (data.path) {
      const { resolved, isWithinWorkspace } = resolveAndValidatePath(
        data.path,
        ctx.workspaceRoot,
      );

      if (!isWithinWorkspace) {
        return {
          outcome: "deny",
          reason: `"${resolved}" is outside workspace "${ctx.workspaceRoot}" [TOOL_FILE_OUTSIDE_WORKSPACE]`,
        };
      }
    }

    return { outcome: "allow" };
  };
}
