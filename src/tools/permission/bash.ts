import type { ToolPermission, PermissionDecision, ToolExecutionContext } from "../types";
import { classifyCommand } from "../security";

/**
 * Creates a permission check for bash commands that classifies the command
 * using the low-level `classifyCommand` primitive and returns a PermissionDecision.
 *
 * Falls back to the provided `workspaceRoot` when `ctx.workspaceRoot` is not set.
 */
export function createBashPermission(workspaceRoot: string): ToolPermission {
  return (input: unknown, ctx: ToolExecutionContext): PermissionDecision => {
    if (!input || typeof input !== "object" || !("command" in input) || typeof input.command !== "string") {
      return { outcome: "ask", reason: "Bash permission requires a command string", prompt: "Review this bash command before execution." };
    }
    const cwd = "cwd" in input && typeof input.cwd === "string" ? input.cwd : undefined;
    return classifyCommand(input.command, { workspaceRoot: ctx.workspaceRoot || workspaceRoot, cwd });
  };
}