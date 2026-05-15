import type { ToolPermission, PermissionDecision, ToolExecutionContext } from "../types";
import { resolveAndValidatePath } from "../security";

export interface WorkspacePermissionOptions {
  /**
   * The input key to read the path from. Defaults to "path".
   * Use "filePath" for LSP tools that accept `filePath` instead of `path`.
   */
  pathKey?: string;
}

/**
 * Creates a permission check that verifies the target path is within the
 * workspace root. Supports configurable input key via `pathKey` option.
 *
 * Default `pathKey` is `"path"` (used by file_read, file_write, etc.).
 * LSP tools should pass `{ pathKey: "filePath" }` to check the `filePath` field.
 */
export function createWorkspacePermission(
  options: WorkspacePermissionOptions = {},
): ToolPermission {
  const pathKey = options.pathKey ?? "path";

  return (input: unknown, ctx: ToolExecutionContext): PermissionDecision => {
    const data = input as { [key: string]: string | undefined };
    const pathValue = data[pathKey];
    if (pathValue) {
      const { resolved, isWithinWorkspace } = resolveAndValidatePath(
        pathValue,
        ctx.workspaceRoot,
      );

      if (!isWithinWorkspace) {
        return {
          outcome: "ask",
          reason: `"${resolved}" is outside workspace "${ctx.workspaceRoot}" [TOOL_FILE_OUTSIDE_WORKSPACE]`,
          approval: {
            eligible: true,
            scope: {
              kind: "file-path",
              operation: "read",
              path: resolved,
              pathMode: "exact",
            },
            display: `Access ${resolved}`,
            reason: "Path is outside workspace",
          },
          source: "tool-guard",
          ruleId: "tool-file-outside-workspace",
        };
      }
    }

    return { outcome: "allow" };
  };
}
