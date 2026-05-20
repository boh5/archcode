import type { ToolPermission, PermissionDecision, ToolExecutionContext } from "../types";
import { classifyCommand } from "../security";

/**
 * Creates a permission check for bash commands that classifies the command
 * using the low-level `classifyCommand` primitive and returns a PermissionDecision.
 *
 * Uses the workspace root from the execution context.
 */
export function createBashPermission(): ToolPermission {
  return (input: unknown, ctx: ToolExecutionContext): PermissionDecision => {
    if (!input || typeof input !== "object" || !("command" in input) || typeof input.command !== "string") {
      return { outcome: "ask", reason: "Bash permission requires a command string", prompt: "Review this bash command before execution." };
    }
    const cwd = "cwd" in input && typeof input.cwd === "string" ? input.cwd : undefined;
    return classifyCommand(input.command, { workspaceRoot: ctx.workspaceRoot, cwd });
  };
}
