import { join } from "node:path";
import { PROJECT_RUNTIME_DIR_NAME, PROJECT_STATE_DIR_NAME } from "@archcode/protocol";

export function projectRuntimePath(workspaceRoot: string, ...parts: string[]): string {
  return join(workspaceRoot, PROJECT_STATE_DIR_NAME, PROJECT_RUNTIME_DIR_NAME, ...parts);
}
