import { homedir } from "node:os";
import { join } from "node:path";

export function getSessionsDir(override?: string): string {
  if (override !== undefined) {
    return override;
  }
  const envDir = process.env.SPECRA_SESSIONS_DIR;
  if (envDir !== undefined) {
    return envDir;
  }
  return join(homedir(), ".specra", "sessions");
}
