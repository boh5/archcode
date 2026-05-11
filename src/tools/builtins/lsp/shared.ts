import { createWorkspaceGuard } from "../../hooks/workspace-guard";

/**
 * Type guard for plain objects. Used to validate LSP notification params.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Creates a workspace guard that normalizes `filePath` input field to `path`.
 * Used by LSP tools that accept `filePath` instead of `path`.
 */
export function createWorkspaceGuardForFilePath() {
  const guard = createWorkspaceGuard();
  return (input: unknown, ctx: Parameters<typeof guard>[1]) => {
    const normalized = isRecord(input) && typeof input.filePath === "string"
      ? { ...input, path: input.filePath }
      : input;
    return guard(normalized, ctx);
  };
}
