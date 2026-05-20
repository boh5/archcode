import { join } from "node:path";

let _override: ((workspaceRoot: string) => string) | undefined;

export function getSessionsDir(workspaceRoot: string): string {
  if (_override) return _override(workspaceRoot);
  return join(workspaceRoot, ".specra", "sessions");
}

export function __setSessionsDirForTest(
  fn: ((workspaceRoot: string) => string) | undefined,
): void {
  _override = fn;
}
